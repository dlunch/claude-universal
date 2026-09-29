// JavaScript implementation of Bun.ant.CellSegmenter, the native line renderer that Claude
// Code's Ink screen uses since 2.1.271. It follows the renderer the app shipped in JavaScript
// up to 2.1.270.
//
// segment(text, cells, runs, reorder) splits a line into terminal cells. Each cell is a pair
// in `cells`: [grapheme index, run << 10 | TAB or column width]. Each run is a pair in `runs`:
// [SGR key index, URI index]. Graphemes, SGR keys and URIs are interned into the public arrays
// the app reads; index 0 of `sgrKeys` and `uris` means none. It returns the cell count, or its
// negation when the buffers are too small.
//
// paint(screen, width, x, y, cells, count, _, charIds, runWords) writes segmented cells into a
// row of the screen buffer, whose cells are pairs [char id, word]; the low bits of a word hold
// the cell kind configured by `options.screen`. It returns the column after the text plus the
// damaged column range, packed as end + damageStart * 2^20 + damageEnd * 2^36.
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import bidiFactory from 'bidi-js';
import stringWidth from 'string-width';

const TAB = 256;
const RUN_SHIFT = 10;
const OSC8 = '\x1b]8;';
const CACHE_SIZE = 4096;
const graphemeSegmenter = new Intl.Segmenter();
let bidi;

class Interner {
  constructor(values, reserved) {
    this.values = values;
    this.ids = new Map();
    if (reserved !== undefined) this.intern(reserved);
  }

  intern(value) {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = this.values.length;
      this.values.push(value);
      this.ids.set(value, id);
    }
    return id;
  }
}

function hyperlinkUri(code) {
  const body = code.slice(OSC8.length, code.endsWith('\x07') ? -1 : -2);
  return body.slice(body.indexOf(';') + 1);
}

// Length of an escape sequence the tokenizer leaves in the text (charset designations and
// unrecognized CSI/OSC/DCS strings), measured in code points from its ESC.
function escapeLength(chars, i) {
  const next = chars[i + 1]?.value;
  if (next === '(' || next === ')' || next === '*' || next === '+') return 3;
  let j = i + 2;
  if (next === '[') {
    while (j < chars.length) {
      const cp = chars[j++].value.codePointAt(0);
      if (cp >= 0x40 && cp <= 0x7e) break;
    }
    return j - i;
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
    while (j < chars.length) {
      const value = chars[j++].value;
      if (value === '\x07') break;
      if (value === '\x1b' && chars[j]?.value === '\\') { j++; break; }
    }
    return j - i;
  }
  const cp = next?.codePointAt(0);
  return cp >= 0x30 && cp <= 0x7e ? 2 : 1;
}

export class CellSegmenter {
  constructor({ ambiguousIsNarrow = false, substitute = [], replacement = '\uFFFD', screen }) {
    this.ambiguousIsNarrow = ambiguousIsNarrow;
    this.substitute = substitute;
    this.replacement = replacement;
    this.screen = screen;
    this.graphemes = [];
    this.sgrKeys = [];
    this.sgrCloseKeys = [];
    this.uris = [];
    this.graphemeIds = new Interner(this.graphemes);
    this.sgrIds = new Interner(this.sgrKeys, '');
    this.sgrCloseKeys.push('');
    this.uriIds = new Interner(this.uris, '');
    this.cache = new Map();
  }

  segment(text, cells, runs, reorder) {
    const key = reorder ? `R${text}` : `N${text}`;
    let line = this.cache.get(key);
    if (line) {
      this.cache.delete(key);
    } else {
      line = this.split(text, reorder);
      if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, line);
    const count = line.cells.length / 2;
    if (line.cells.length > cells.length || line.runs.length > runs.length) {
      return -Math.max(count, line.runs.length / 2);
    }
    cells.set(line.cells);
    runs.set(line.runs);
    return count;
  }

  split(text, reorder) {
    const chars = styledCharsFromTokens(tokenize(text));
    const cells = [];
    const runs = [];
    let runKey;
    let group = '';
    const flush = () => {
      if (!group) return;
      for (const { segment } of graphemeSegmenter.segment(group)) this.pushCell(cells, segment, runs.length / 2 - 1);
      group = '';
    };
    for (let i = 0; i < chars.length; i++) {
      const { value, styles } = chars[i];
      if (value === '\x1b') {
        flush();
        i += escapeLength(chars, i) - 1;
        continue;
      }
      const sgr = [];
      let uri = '';
      for (const style of styles) {
        if (style.code.startsWith(OSC8)) uri = hyperlinkUri(style.code);
        else sgr.push(style);
      }
      const sgrKey = sgr.map((style) => style.code).join('\0');
      const nextRunKey = `${sgrKey}\x01${uri}`;
      if (nextRunKey !== runKey) {
        flush();
        runKey = nextRunKey;
        const sgrId = this.sgrIds.intern(sgrKey);
        if (sgrId === this.sgrCloseKeys.length) this.sgrCloseKeys.push(sgr.map((style) => style.endCode).join('\0'));
        runs.push(sgrId, this.uriIds.intern(uri));
      }
      group += value;
    }
    flush();
    return { cells: Int32Array.from(reorder ? this.reorder(cells) : cells), runs: Int32Array.from(runs) };
  }

  // Reorders cells from logical to visual order by the Unicode bidi algorithm (rule L2),
  // using the embedding level of each cell's first code unit.
  reorder(cells) {
    const count = cells.length / 2;
    const values = [];
    for (let i = 0; i < count; i++) values.push(cells[2 * i + 1] & TAB ? ' ' : this.graphemes[cells[2 * i]]);
    bidi ??= bidiFactory();
    const { levels } = bidi.getEmbeddingLevels(values.join(''), 'auto');
    const cellLevels = [];
    let offset = 0;
    for (const value of values) {
      cellLevels.push(levels[offset]);
      offset += value.length;
    }
    const order = [...cellLevels.keys()];
    for (let level = Math.max(0, ...cellLevels); level >= 1; level--) {
      for (let i = 0; i < count;) {
        if (cellLevels[order[i]] < level) { i++; continue; }
        let j = i + 1;
        while (j < count && cellLevels[order[j]] >= level) j++;
        order.splice(i, j - i, ...order.slice(i, j).reverse());
        i = j;
      }
    }
    return order.flatMap((i) => [cells[2 * i], cells[2 * i + 1]]);
  }

  pushCell(cells, grapheme, run) {
    if (grapheme === '\t') {
      cells.push(this.graphemeIds.intern(' '), (run << RUN_SHIFT) | TAB);
      return;
    }
    const cp = grapheme.codePointAt(0);
    if (grapheme.length === 1 && this.substitute.some(([first, last]) => cp >= first && cp <= last)) {
      cells.push(this.graphemeIds.intern(this.replacement), (run << RUN_SHIFT) | 1);
      return;
    }
    const width = cp < 0x20 ? 0 : stringWidth(grapheme, { ambiguousIsNarrow: this.ambiguousIsNarrow });
    if (width > 0) cells.push(this.graphemeIds.intern(grapheme), (run << RUN_SHIFT) | width);
  }

  paint(screen, width, x, y, cells, count, _unused, charIds, runWords) {
    const { widthMask, narrow, wide, spacerTail, spacerHead, emptyCharIndex, spacerCharIndex, emptyWord, tabWidth } = this.screen;
    const damage = { start: Infinity, end: 0 };
    for (let i = 0; i < count; i++) {
      const info = cells[2 * i + 1];
      if (info & TAB) {
        for (let n = tabWidth - (x % tabWidth); n > 0 && x < width; n--, x++) {
          this.write(screen, width, x, y, emptyCharIndex, emptyWord, damage);
        }
        continue;
      }
      const columns = info & 0xff;
      if (columns < 2) {
        this.write(screen, width, x, y, charIds[cells[2 * i]], runWords[info >>> RUN_SHIFT] | narrow, damage);
        x++;
      } else if (x + columns > width) {
        this.write(screen, width, x, y, emptyCharIndex, (emptyWord & ~widthMask) | spacerHead, damage);
        x++;
      } else {
        const word = runWords[info >>> RUN_SHIFT];
        this.write(screen, width, x, y, charIds[cells[2 * i]], word | wide, damage);
        for (let k = 2; k < columns; k++) this.write(screen, width, x + k, y, spacerCharIndex, word | spacerTail, damage);
        x += columns;
      }
    }
    return packDamage(x, damage);
  }

  setCell(screen, width, x, y, charId, word) {
    const damage = { start: Infinity, end: 0 };
    this.write(screen, width, x, y, charId, word, damage);
    return packDamage(x + 1, damage);
  }

  // Writes one cell, keeping wide characters and their spacer cells paired.
  write(screen, width, x, y, charId, word, damage) {
    if (x < 0 || x >= width) return;
    const { widthMask, wide, spacerTail, emptyCharIndex, spacerCharIndex, emptyWord } = this.screen;
    const i = (y * width + x) << 1;
    const kind = word & widthMask;
    const old = screen[i + 1] & widthMask;
    let start = x;
    let end = x + 1;
    if (old === wide && kind !== wide && x + 1 < width && (screen[i + 3] & widthMask) === spacerTail) {
      screen[i + 2] = emptyCharIndex;
      screen[i + 3] = emptyWord;
    }
    if (old === spacerTail && kind !== spacerTail && x > 0 && (screen[i - 1] & widthMask) === wide) {
      screen[i - 2] = emptyCharIndex;
      screen[i - 1] = emptyWord;
      start = x - 1;
    }
    screen[i] = charId;
    screen[i + 1] = word;
    if (kind === wide && x + 1 < width) {
      if ((screen[i + 3] & widthMask) === wide && x + 2 < width && (screen[i + 5] & widthMask) === spacerTail) {
        screen[i + 4] = emptyCharIndex;
        screen[i + 5] = emptyWord;
      }
      screen[i + 2] = spacerCharIndex;
      screen[i + 3] = (emptyWord & ~widthMask) | spacerTail;
      end = x + 2;
    }
    damage.start = Math.min(damage.start, start);
    damage.end = Math.max(damage.end, end);
  }
}

function packDamage(x, { start, end }) {
  return start < end ? x + start * 2 ** 20 + end * 2 ** 36 : x;
}
