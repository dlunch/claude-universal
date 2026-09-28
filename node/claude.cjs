#!/usr/bin/env node
// Launches the Node rebuild of Claude Code produced by build.mjs. Embedded files are loaded
// the way Bun's loaders serve them: `text` assets as their contents, `file` assets as their
// path.
const fs = require('node:fs');
const path = require('node:path');
const { enableCompileCache, registerHooks } = require('node:module');
const { fileURLToPath } = require('node:url');

const root = path.dirname(fs.realpathSync(__filename));
const assets = JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8'));

registerHooks({
  load(url, context, nextLoad) {
    const file = url.startsWith('file:') ? fileURLToPath(url) : null;
    const loader = assets[file];
    if (!loader) return nextLoad(url, context);
    const value = loader === 'text' ? fs.readFileSync(file, 'utf8') : file;
    return { format: 'commonjs', source: `module.exports = ${JSON.stringify(value)};`, shortCircuit: true };
  },
});

require('./bun.cjs');
enableCompileCache();
require('./cli.cjs');
