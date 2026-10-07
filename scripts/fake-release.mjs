// Stands in for GitHub's release API on this machine, to try the self-update by hand:
//
//   1. Build the version to update to:   npm run dist      (bump "version" in package.json first)
//   2. Serve it:                          node scripts/fake-release.mjs dist/FoxQueryStudio-0.2.0.exe
//   3. Start an OLDER FoxQueryStudio-*.exe with FQS_UPDATE_API=http://127.0.0.1:8765/latest
//      (PowerShell: $env:FQS_UPDATE_API='http://127.0.0.1:8765/latest'; .\FoxQueryStudio-0.1.0.exe)
//
// The running copy finds the newer version at start, offers it at the bottom right, downloads
// it on request, checks its SHA-256 and swaps itself out. test/e2e/update.mjs does all of this
// unattended.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';

const PORT = Number(process.env.PORT ?? 8765);
const file = process.argv[2] && resolve(process.argv[2]);
if (!file) {
  console.error('usage: node scripts/fake-release.mjs <path to FoxQueryStudio-<version>.exe>');
  process.exit(2);
}
const version = /-(\d+\.\d+\.\d+)\.exe$/i.exec(basename(file))?.[1];
if (!version) {
  console.error('the file must be named FoxQueryStudio-<version>.exe');
  process.exit(2);
}
const digest = `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
const release = { tag_name: `v${version}`, assets: [{ name: basename(file), browser_download_url: `http://127.0.0.1:${PORT}/download`, digest }] };

createServer((request, response) => {
  const path = new URL(request.url, `http://127.0.0.1:${PORT}`).pathname;
  console.log(`${request.method} ${path}`);
  if (path === '/latest') return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(release));
  if (path === '/download') {
    response.writeHead(200, { 'Content-Length': statSync(file).size });
    return void createReadStream(file).pipe(response);
  }
  response.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${basename(file)} as release v${version} (${digest})`);
  console.log(`Start an older FoxQueryStudio-*.exe with FQS_UPDATE_API=http://127.0.0.1:${PORT}/latest`);
});
