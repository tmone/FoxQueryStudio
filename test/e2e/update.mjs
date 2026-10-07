// Proves the self-update of the single-file program for real: builds two versions of the
// portable .exe, runs the older one against a stand-in for GitHub's release API on this
// machine, and lets it find, download, verify and swap in the newer one.
//
//   npm run build; node test/e2e/update.mjs
//
// Takes several minutes: it packages the app twice.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const OLD_VERSION = '0.1.0';
const NEW_VERSION = '0.2.0';
const PORT = 8765;
const DEBUG_PORT = 9555;
const FEED_URL = `http://127.0.0.1:${PORT}/latest`;
const WORK_DIR = resolve(process.env.FQS_UPDATE_E2E_DIR ?? join(tmpdir(), 'fqs-update-e2e'));
const RUN_DIR = join(WORK_DIR, 'run');
const PROGRAM = join(RUN_DIR, 'FoxQueryStudio.exe');
const IMAGE_NAME = 'FoxQuery Studio.exe';
const programName = (version) => `FoxQueryStudio-${version}.exe`;

// Shells spawned by an Electron host (VS Code) set this and make electron.exe run as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function buildProgram(version) {
  const outDir = join(WORK_DIR, `build-${version}`);
  const file = join(outDir, programName(version));
  if (existsSync(file)) return file;
  log(`building ${programName(version)}`);
  execFileSync(
    process.execPath,
    ['node_modules/electron-builder/cli.js', '--win', '--config', 'electron-builder.config.cjs', '--publish', 'never', `-c.extraMetadata.version=${version}`],
    { env: { ...cleanEnv, FQS_DIST_DIR: outDir }, stdio: 'ignore' },
  );
  return file;
}

/**
 * Answers like GitHub: the "latest release" document, and the file it points to.
 * `release` is swapped by the test to play different situations.
 */
function serve(state) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, FEED_URL).pathname;
    state.requests.push(path);
    if (path === '/latest') {
      if (!state.release) return void response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"Not Found"}');
      return void response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state.release));
    }
    if (path === '/download' && state.file) {
      response.writeHead(200, { 'Content-Length': statSync(state.file).size });
      return void createReadStream(state.file).pipe(response);
    }
    response.writeHead(404).end();
  });
  return new Promise((done) => server.listen(PORT, '127.0.0.1', () => done(server)));
}

const release = (version, digest) => ({ tag_name: `v${version}`, assets: [{ name: programName(version), browser_download_url: `http://127.0.0.1:${PORT}/download`, digest }] });
const isRunning = () => spawnSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE_NAME}`, '/NH'], { encoding: 'utf8' }).stdout.includes(IMAGE_NAME);
const stopApp = () => spawnSync('taskkill', ['/IM', IMAGE_NAME, '/F', '/T'], { stdio: 'ignore' });

async function waitFor(condition, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** Attaches to the window of the running program; the portable launcher starts it as a child process. */
async function attach() {
  let browser;
  await waitFor(async () => {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`).catch(() => undefined);
    return browser?.contexts()[0]?.pages().length > 0;
  }, 'the program window');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.getElementById('app-version')?.textContent !== '');
  return { browser, page };
}

async function launch() {
  spawn(PROGRAM, [`--remote-debugging-port=${DEBUG_PORT}`], { env: { ...cleanEnv, FQS_UPDATE_API: FEED_URL }, detached: true, stdio: 'ignore' }).unref();
  return attach();
}

async function quit(browser) {
  await browser.close().catch(() => undefined);
  stopApp();
  await waitFor(() => !isRunning(), 'the program to stop', 30_000);
}

mkdirSync(WORK_DIR, { recursive: true });
mkdirSync('test-results', { recursive: true });
const oldProgram = buildProgram(OLD_VERSION);
const newProgram = buildProgram(NEW_VERSION);

stopApp();
rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(RUN_DIR, { recursive: true });
copyFileSync(oldProgram, PROGRAM);

const state = { release: undefined, file: undefined, requests: [] };
const server = await serve(state);
try {
  // ---- 1. No release published: the check fails quietly, nothing is offered ---------------
  let { browser, page } = await launch();
  assert.equal(await page.textContent('#app-version'), `v${OLD_VERSION}`);
  await page.waitForFunction(() => document.getElementById('app-version').classList.contains('failed'), null, { timeout: 60_000 });
  assert.match(await page.getAttribute('#app-version', 'title'), /Chưa có bản phát hành/);
  assert.equal(await page.isHidden('#btn-update'), true);
  log('ok  checks at start and reports that no release exists');

  // ---- 2. The same version is the latest: up to date ---------------------------------------
  state.release = release(OLD_VERSION, `sha256:${sha256(oldProgram)}`);
  await page.click('#app-version');
  await page.waitForFunction(() => document.getElementById('app-version').title.includes('bản mới nhất'), null, { timeout: 60_000 });
  assert.equal(await page.isHidden('#btn-update'), true);
  log('ok  reports it is up to date when the latest release is its own version');

  // ---- 3. A newer release whose file does not match its checksum is thrown away -----------
  state.release = release(NEW_VERSION, `sha256:${'0'.repeat(64)}`);
  state.file = newProgram;
  await page.click('#app-version');
  await page.waitForSelector('#btn-update:not([hidden])', { timeout: 60_000 });
  assert.equal(await page.textContent('#btn-update-label'), `Tải bản ${NEW_VERSION}`);
  assert.ok(!state.requests.includes('/download'), 'nothing is downloaded before the user asks');
  log(`ok  finds ${NEW_VERSION} and waits for the user`);
  await page.screenshot({ path: 'test-results/update-available.png' });
  await page.click('#btn-update');
  await page.waitForFunction(() => document.getElementById('app-version').title.includes('không khớp mã kiểm tra'), null, { timeout: 300_000 });
  assert.equal(existsSync(`${PROGRAM}.new`), false);
  assert.equal(sha256(PROGRAM), sha256(oldProgram));
  log('ok  discards a download that does not match the published checksum');

  // ---- 4. The genuine release: download, verify, swap, restart -----------------------------
  state.release = release(NEW_VERSION, `sha256:${sha256(newProgram)}`);
  await page.click('#app-version');
  await page.waitForSelector('#btn-update:not([hidden])', { timeout: 60_000 });
  await page.click('#btn-update');
  await page.waitForFunction((label) => document.getElementById('btn-update-label').textContent === label, `Khởi động lại để cập nhật ${NEW_VERSION}`, { timeout: 300_000 });
  assert.equal(sha256(`${PROGRAM}.new`), sha256(newProgram));
  log('ok  downloads the new program on request and verifies it');
  await page.screenshot({ path: 'test-results/update-downloaded.png' });

  await page.click('#btn-update').catch(() => undefined); // the program quits while handling the click
  await browser.close().catch(() => undefined);
  await waitFor(() => existsSync(PROGRAM) && sha256(PROGRAM) === sha256(newProgram), 'the new program to be in place', 60_000);
  await waitFor(isRunning, 'the new version to start by itself');
  log('ok  swaps the program file and restarts by itself');
  await sleep(8000);
  stopApp();
  await waitFor(() => !isRunning(), 'the restarted program to stop', 30_000);
  assert.equal(existsSync(`${PROGRAM}.old`), false, 'the replaced copy is cleaned up by the new version');

  // ---- 5. The program is now the new version and is up to date ---------------------------
  ({ browser, page } = await launch());
  assert.equal(await page.textContent('#app-version'), `v${NEW_VERSION}`);
  await page.waitForFunction(() => document.getElementById('app-version').title.includes('bản mới nhất'), null, { timeout: 60_000 });
  assert.equal(await page.isHidden('#btn-update'), true);
  log(`ok  runs as ${NEW_VERSION} and reports it is up to date`);
  await page.screenshot({ path: 'test-results/update-done.png' });
  await quit(browser);

  console.log('\nupdate ok');
} finally {
  stopApp();
  await new Promise((done) => server.close(done));
}
