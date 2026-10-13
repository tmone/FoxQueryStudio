// Gathers the release assets that are not built by electron-builder:
//   dist/FoxQueryStudio-<version>-app-electron<electron>.asar  the app code alone, for light updates
//   dist/northwind-sample.zip                                  the FoxPro sample database
// Run after `npm run dist`.
import { copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appAssetName } from '../src/shared/update.ts';

const { version } = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('package.json', 'utf8')));
const electron = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync('node_modules/electron/package.json', 'utf8'))).version;
const dist = process.env.FQS_DIST_DIR || 'dist';
const asar = join(dist, 'win-unpacked', 'resources', 'app.asar');
if (!existsSync(asar)) throw new Error(`${asar} not found; run npm run dist first`);
copyFileSync(asar, join(dist, appAssetName(version, electron)));
console.log(join(dist, appAssetName(version, electron)));
if (existsSync('test/fixtures/northwind')) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path test/fixtures/northwind/* -DestinationPath ${join(dist, 'northwind-sample.zip')} -Force`], { stdio: 'inherit' });
  console.log(join(dist, 'northwind-sample.zip'));
}
