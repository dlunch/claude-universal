// Launches the Node rebuild of Claude Code produced by build.mjs. Embedded files are loaded
// the way Bun's loaders serve them: `text` assets as their contents, `file` assets as their
// path.
import fs from 'node:fs';
import { createRequire, enableCompileCache, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './bun.mjs';

// Unlike the official binary, this executable cannot run as ripgrep or update itself.
process.env.USE_BUILTIN_RIPGREP ??= '0';
process.env.DISABLE_AUTOUPDATER ??= '1';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8'));

registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : null;
    const loader = file && assets[path.relative(root, file)];
    if (!loader) return nextLoad(url, context);
    const value = loader === 'text' ? fs.readFileSync(file, 'utf8') : file;
    return { format: 'commonjs', source: `module.exports = ${JSON.stringify(value)};`, shortCircuit: true };
  },
});

enableCompileCache();
createRequire(import.meta.url)('./cli.js');
