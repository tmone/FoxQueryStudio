// Proves the remote update for real: builds two installers, installs the older one,
// publishes the newer one on a local web server, and lets the installed app find,
// download and install it. Ends by uninstalling.
//
//   npm run build; node test/e2e/update.mjs
//
// Takes several minutes: it packages the app twice.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const OLD_VERSION = '0.1.0';
const NEW_VERSION = '0.2.0';
const PORT = 8765;
const FEED_URL = `http://127.0.0.1:${PORT}/`;
const WORK_DIR = resolve(process.env.FQS_UPDATE_E2E_DIR ?? join(tmpdir(), 'fqs-update-e2e'));
const INSTALL_DIR = join(WORK_DIR, 'installed');
const EXE = join(INSTALL_DIR, 'FoxQuery Studio.exe');
const UNINSTALLER = join(INSTALL_DIR, 'Uninstall FoxQuery Studio.exe');
const setupName = (version) => `FoxQueryStudio-Setup-${version}.exe`;

// Shells spawned by an Electron host (VS Code) set this and make electron.exe run as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

function buildInstaller(version) {
  const outDir = join(WORK_DIR, `build-${version}`);
  if (existsSync(join(outDir, setupName(version)))) return outDir;
  log(`building installer ${version}`);
  execFileSync(
    process.execPath,
    ['node_modules/electron-builder/cli.js', '--win', '--config', 'electron-builder.config.cjs', '--publish', 'never', `-c.extraMetadata.version=${version}`],
    { env: { ...cleanEnv, FQS_UPDATE_URL: FEED_URL, FQS_DIST_DIR: outDir }, stdio: 'ignore' },
  );
  return outDir;
}

/** Serves a release folder the way any static web server would, and records what was asked for. */
function serve(dir) {
  const requests = [];
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, FEED_URL).pathname.slice(1));
    const file = join(dir, name);
    requests.push(name);
    if (name.includes('..') || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      createReadStream(file, { start, end }).pipe(response);
    } else {
      response.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(file).pipe(response);
    }
  });
  return new Promise((done) => server.listen(PORT, '127.0.0.1', () => done({ server, requests })));
}

const isRunning = () => spawnSync('tasklist', ['/FI', 'IMAGENAME eq FoxQuery Studio.exe', '/NH'], { encoding: 'utf8' }).stdout.includes('FoxQuery Studio.exe');
const stopApp = () => spawnSync('taskkill', ['/IM', 'FoxQuery Studio.exe', '/F', '/T'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(condition, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function launch() {
  const app = await electron.launch({ executablePath: EXE, env: cleanEnv });
  const page = await app.firstWindow();
  // The version label is filled once the main process has answered.
  await page.waitForFunction(() => document.getElementById('app-version')?.textContent !== '');
  return { app, page };
}

mkdirSync(WORK_DIR, { recursive: true });
const oldBuild = buildInstaller(OLD_VERSION);
const newBuild = buildInstaller(NEW_VERSION);

stopApp();
rmSync(INSTALL_DIR, { recursive: true, force: true });
log(`installing ${OLD_VERSION} into ${INSTALL_DIR}`);
// /D must be the last argument and unquoted, by NSIS rules.
spawnSync(join(oldBuild, setupName(OLD_VERSION)), ['/S', `/D=${INSTALL_DIR}`], { stdio: 'ignore', windowsVerbatimArguments: true });
await waitFor(() => existsSync(EXE), 'the installed program');

let server;
try {
  // ---- 1. No release on the server: the app says so and offers nothing ---------------------
  const empty = join(WORK_DIR, 'empty-feed');
  mkdirSync(empty, { recursive: true });
  ({ server } = await serve(empty));
  let { app, page } = await launch();
  assert.equal(await page.textContent('#app-version'), `v${OLD_VERSION}`);
  await page.waitForFunction(() => document.getElementById('app-version').classList.contains('failed'), null, { timeout: 60_000 });
  assert.equal(await page.isHidden('#btn-update'), true);
  log('ok  reports a failed check without offering an update when the server has no release');
  await app.close();
  await new Promise((done) => server.close(done));

  // ---- 2. A newer release is published: find, download, install ---------------------------
  let requests;
  ({ server, requests } = await serve(newBuild));
  ({ app, page } = await launch());
  await page.waitForSelector('#btn-update:not([hidden])', { timeout: 60_000 });
  assert.equal(await page.textContent('#btn-update'), `Tải bản ${NEW_VERSION}`);
  assert.ok(!requests.some((name) => name.endsWith('.exe')), 'nothing is downloaded before the user asks');
  log(`ok  finds ${NEW_VERSION} on the server and waits for the user`);
  await page.screenshot({ path: 'test-results/update-available.png' });

  await page.click('#btn-update');
  await page.waitForFunction((label) => document.getElementById('btn-update').textContent === label, `Khởi động lại để cập nhật ${NEW_VERSION}`, { timeout: 300_000 });
  assert.ok(requests.includes(setupName(NEW_VERSION)), 'the installer was downloaded from the server');
  log('ok  downloads the new installer on request');
  await page.screenshot({ path: 'test-results/update-downloaded.png' });

  await page.click('#btn-update').catch(() => undefined); // the app quits while handling the click
  await app.close().catch(() => undefined);
  log('installing the update…');
  // The updater quits the app, runs the installer silently and starts the new version.
  await waitFor(() => !isRunning(), 'the old version to quit', 60_000).catch(() => undefined);
  await waitFor(isRunning, 'the new version to start by itself');
  log('ok  restarts by itself after installing');
  await sleep(3000);
  stopApp();
  await waitFor(() => !isRunning(), 'the restarted app to stop', 30_000);

  // ---- 3. The installed program is now the new version and is up to date ------------------
  ({ app, page } = await launch());
  assert.equal(await page.textContent('#app-version'), `v${NEW_VERSION}`);
  assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getVersion()), NEW_VERSION);
  await page.waitForFunction(() => document.getElementById('app-version').title.includes('bản mới nhất'), null, { timeout: 60_000 });
  assert.equal(await page.isHidden('#btn-update'), true);
  log(`ok  runs as ${NEW_VERSION} and reports it is up to date`);
  await page.screenshot({ path: 'test-results/update-done.png' });

  // ---- 4. A plain-HTTP address on another machine is refused ------------------------------
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  await app.close();
  const override = join(userData, 'update.json');
  writeFileSync(override, JSON.stringify({ url: 'http://192.168.1.10/updates/' }));
  try {
    ({ app, page } = await launch());
    await page.waitForFunction(() => document.getElementById('app-version').title.includes('HTTPS'), null, { timeout: 30_000 });
    assert.equal(await page.isDisabled('#app-version'), true);
    log('ok  refuses an update address that is not HTTPS');
    await app.close();
  } finally {
    rmSync(override, { force: true });
  }

  console.log(`\nUpdate ${OLD_VERSION} -> ${NEW_VERSION} verified. Server requests: ${[...new Set(requests)].join(', ')}`);
} finally {
  stopApp();
  server?.close();
  if (existsSync(UNINSTALLER)) {
    spawnSync(UNINSTALLER, ['/S'], { stdio: 'ignore' });
    await waitFor(() => !existsSync(EXE), 'the uninstall to finish', 60_000).catch(() => log('uninstall did not finish in time'));
  }
  log(`installed files left: ${existsSync(INSTALL_DIR) ? readdirSync(INSTALL_DIR).length : 0}`);
}
