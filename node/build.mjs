// Rebuilds the official Bun-compiled Claude Code binary into a Node.js application.
//
//   node build.mjs <claude-binary> <out-dir>
//
// A Bun standalone executable carries its embedded filesystem (/$bunfs/root/...) as a blob
// that ends with an `Offsets` struct followed by the "\n---- Bun! ----\n" trailer. The module
// table in that blob lists every embedded file. JS modules are bundled by esbuild into
// <out-dir>/cli.js; every other file is written to <out-dir> under its original name, and
// <out-dir>/assets.json records which Bun loader serves it (see claude.mjs). The image
// installs <out-dir> at /$bunfs/root so the paths the app computes resolve unchanged.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const [binaryPath, outDir] = process.argv.slice(2);
if (!binaryPath || !outDir) {
  console.error('usage: node build.mjs <claude-binary> <out-dir>');
  process.exit(2);
}

const VFS_ROOT = '/$bunfs/root/';
const TRAILER = Buffer.from('\n---- Bun! ----\n');
const OFFSETS_SIZE = 32;
const RECORD_SIZE = 52;
// bun.options.Loader, stored in byte 1 of the record's flags word.
const LOADERS = { 1: 'js', 5: 'file', 10: 'napi', 13: 'text' };

const bin = fs.readFileSync(binaryPath);
const trailerPos = bin.lastIndexOf(TRAILER);
if (trailerPos < 0) throw new Error('not a Bun standalone executable');
const offsets = trailerPos - OFFSETS_SIZE;
const blob = offsets - Number(bin.readBigUInt64LE(offsets));
const tableOff = bin.readUInt32LE(offsets + 8);
const tableLen = bin.readUInt32LE(offsets + 12);
const entryIndex = bin.readUInt32LE(offsets + 16);
if (tableLen % RECORD_SIZE) throw new Error(`unexpected module table size ${tableLen}`);

// Record: name, contents, sourcemap, bytecode, extra, source path (StringPointer each), flags.
const slice = (pos) => {
  const start = blob + bin.readUInt32LE(pos);
  return bin.subarray(start, start + bin.readUInt32LE(pos + 4));
};
const modules = new Map();
const assets = {};
let entry;
fs.rmSync(outDir, { recursive: true, force: true });
for (let i = 0; i < tableLen / RECORD_SIZE; i++) {
  const rec = blob + tableOff + i * RECORD_SIZE;
  const name = slice(rec).toString();
  const loader = LOADERS[(bin.readUInt32LE(rec + 48) >> 8) & 0xff];
  if (!name.startsWith(VFS_ROOT) || !loader) throw new Error(`unexpected module ${name}`);
  if (i === entryIndex) entry = name;
  if (loader === 'js') {
    modules.set(name, slice(rec + 8));
  } else if (loader !== 'napi') {
    // Native addons are built for the download platform, so they are left out and fail to
    // load with MODULE_NOT_FOUND where the feature is used.
    const dest = path.join(outDir, name.slice(VFS_ROOT.length));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, slice(rec + 8));
    assets[name] = loader;
  }
}
fs.writeFileSync(path.join(outDir, 'assets.json'), JSON.stringify(assets));

const options = {
  outdir: outDir,
  metafile: true,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'error',
  // Bun's import.meta extensions, mapped onto the CommonJS scope of the bundle.
  define: {
    'import.meta.require': 'require',
    'import.meta.dir': '__dirname',
    'import.meta.dirname': '__dirname',
    'import.meta.filename': '__filename',
    'import.meta.path': '__filename',
    'import.meta.url': '__import_meta_url',
    'import.meta.main': 'true',
  },
  banner: { js: 'var __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  plugins: [{
    name: 'bunfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) =>
        modules.has(args.path) ? { path: args.path, namespace: 'bunfs' } : { external: true });
      build.onLoad({ filter: /.*/, namespace: 'bunfs' }, (args) =>
        ({ contents: modules.get(args.path), loader: 'js' }));
    },
  }],
};
const bundle = (names) => esbuild.build({
  ...options,
  entryPoints: names.map((name) => ({ in: name, out: name.slice(VFS_ROOT.length).replace(/\.js$/, '') })),
});

// The app runs some modules by path (the hooks worker, native addon wrappers) instead of
// importing them, so each module the CLI bundle does not contain is bundled on its own.
const { metafile } = await bundle([entry]);
const bundled = new Set(Object.keys(metafile.inputs).map((input) => input.slice('bunfs:'.length)));
await bundle([...modules.keys()].filter((name) => !bundled.has(name)));
