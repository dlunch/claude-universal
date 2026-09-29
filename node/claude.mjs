// Launches the Node rebuild of Claude Code produced by build.mjs. Embedded files are loaded
// the way Bun's loaders serve them: `text` assets as their contents, `file` assets as their
// path.
import fs from 'node:fs';
import { createRequire, enableCompileCache, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import './bun.mjs';

const assets = JSON.parse(fs.readFileSync(new URL('assets.json', import.meta.url), 'utf8'));

registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : null;
    const loader = assets[file];
    if (!loader) return nextLoad(url, context);
    const value = loader === 'text' ? fs.readFileSync(file, 'utf8') : file;
    return { format: 'commonjs', source: `module.exports = ${JSON.stringify(value)};`, shortCircuit: true };
  },
});

enableCompileCache();
createRequire(import.meta.url)('./cli.js');
