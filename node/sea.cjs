// Entry point of the single executable application. Like Bun's standalone binaries, the
// executable itself is process.execPath, which the app spawns to run itself again. The app's
// files are embedded as assets and extracted once per build into the user's cache directory.
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const sea = require('node:sea');

const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'claude-universal');
const buildId = sea.getAsset('build-id', 'utf8');
const appDir = path.join(cacheDir, buildId);

if (!fs.existsSync(appDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const staging = fs.mkdtempSync(`${appDir}.`);
  for (const name of sea.getAssetKeys()) {
    const dest = path.join(staging, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, new Uint8Array(sea.getRawAsset(name)));
  }
  try {
    fs.renameSync(staging, appDir);
  } catch (error) {
    // Another process extracted the same build first.
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(appDir)) throw error;
  }
  // Earlier builds are replaced by this one.
  for (const entry of fs.readdirSync(cacheDir)) {
    if (!entry.startsWith(buildId)) fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
  }
}

createRequire(appDir + path.sep)('./claude.mjs');
