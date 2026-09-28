// The subset of Bun's global API that Claude Code calls without a Node fallback.
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const util = require('node:util');
const zlib = require('node:zlib');
const semver = require('semver');
const { default: sliceAnsi } = require('slice-ansi');
const TOML = require('smol-toml');
const { default: stringWidth } = require('string-width');
const which = require('which');
const { default: wrapAnsi } = require('wrap-ansi');
const YAML = require('yaml');

// The app only compares these digests with ones computed by the same runtime, so any stable
// 64-bit hash serves in place of Bun's wyhash and xxHash64.
function hash64(data, seed = 0) {
  const digest = crypto.createHash('sha256').update(String(seed)).update(data).digest();
  return digest.readBigUInt64LE(0);
}

globalThis.Bun = {
  hash: Object.assign(hash64, { xxHash64: hash64, crc32: (data) => zlib.crc32(data) }),
  which: (command, options) => which.sync(command, { nothrow: true, path: options?.PATH }),
  stringWidth,
  stripANSI: util.stripVTControlCharacters,
  wrapAnsi,
  sliceAnsi,
  deepEquals: util.isDeepStrictEqual,
  semver: { order: semver.compare, satisfies: semver.satisfies },
  YAML: { parse: YAML.parse, stringify: YAML.stringify },
  TOML: { parse: TOML.parse },
  zstdDecompressSync: zlib.zstdDecompressSync,
  zstdDecompress: util.promisify(zlib.zstdDecompress),
  stdin: { stream: () => Readable.toWeb(process.stdin) },
  sleepSync: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  // Namespace probed for optional JIT tuning methods.
  unsafe: {},
};
