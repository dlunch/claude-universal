// Entry point of the single executable application. Like Bun's standalone binaries, the
// executable itself is process.execPath, which the app spawns to run itself again.
require('node:module').createRequire('/$bunfs/root/')('./claude.mjs');
