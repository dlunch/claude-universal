// Writes the single executable application config embedding every file of the app directory
// as an asset, and records a build id derived from their contents.
//
//   node sea-config.mjs <app-dir> <config>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [appDir, configPath] = process.argv.slice(2);
const files = fs.readdirSync(appDir, { recursive: true })
  .filter((name) => fs.statSync(path.join(appDir, name)).isFile())
  .sort();
const hash = crypto.createHash('sha256');
for (const name of files) hash.update(name).update('\0').update(fs.readFileSync(path.join(appDir, name)));
fs.writeFileSync(path.join(appDir, 'build-id'), hash.digest('hex').slice(0, 16));
files.push('build-id');

fs.writeFileSync(configPath, JSON.stringify({
  main: new URL('sea.cjs', import.meta.url).pathname,
  output: 'sea.blob',
  disableExperimentalSEAWarning: true,
  assets: Object.fromEntries(files.map((name) => [name, path.resolve(appDir, name)])),
}));
