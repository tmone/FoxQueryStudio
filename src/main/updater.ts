import { app, ipcMain, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, rmSync, writeFileSync } from 'node:fs';
import { isAllowedUpdateUrl, isNewerVersion, latestReleaseUrl, parseRelease, UPDATE_REPO, type Release, type UpdateStatus } from '../shared/update';

/**
 * Self-update of the single-file program from GitHub releases. At start (and every few
 * hours) the latest release is looked up; nothing is downloaded or replaced without the
 * user asking for it. An update is the new .exe put in place of the running one.
 */

const FIRST_CHECK_DELAY_MS = 3_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const OLD_COPY_CLEANUP_DELAY_MS = 5_000;
/** Seconds the swap script waits for this program to quit. */
const SWAP_ATTEMPTS = 60;
const REQUEST_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'FoxQueryStudio' };
/** Points the check at another address; used to try a release before it is published. */
const FEED_OVERRIDE = process.env.FQS_UPDATE_API;
/** Set by the portable launcher: the .exe the user started, as opposed to its unpacked copy. */
const PROGRAM_FILE = process.env.PORTABLE_EXECUTABLE_FILE;

const newCopy = (program: string) => `${program}.new`;
const oldCopy = (program: string) => `${program}.old`;

/** Why this copy cannot update itself, or undefined when it can. */
function disabledReason(feed: string): string | undefined {
  if (!isAllowedUpdateUrl(feed)) return 'Địa chỉ cập nhật phải dùng HTTPS.';
  if (!app.isPackaged && !FEED_OVERRIDE) return 'Bản chạy từ mã nguồn không tự cập nhật.';
  return undefined;
}

async function fetchRelease(feed: string): Promise<Release> {
  const response = await fetch(feed, { headers: REQUEST_HEADERS });
  if (response.status === 404) throw new Error('Chưa có bản phát hành nào (hoặc kho phát hành không công khai).');
  if (!response.ok) throw new Error(`Máy chủ cập nhật trả về lỗi ${response.status}.`);
  const release = parseRelease(await response.json());
  if (!release) throw new Error('Không đọc được thông tin bản phát hành.');
  return release;
}

/** Saves the file and returns its SHA-256; `onProgress` gets 0 to 100. */
async function download(url: string, target: string, onProgress: (percent: number) => void): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': REQUEST_HEADERS['User-Agent'] } });
  if (!response.ok || !response.body) throw new Error(`Không tải được bản mới (lỗi ${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const file = createWriteStream(target);
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once('drain', () => resolve()));
      if (total) onProgress((received / total) * 100);
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()));
  }
  return hash.digest('hex');
}

export function setupUpdater(getWindow: () => BrowserWindow | undefined): void {
  let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
  let latest: Release | undefined;
  const publish = (change: Partial<UpdateStatus>) => {
    status = { ...status, ...change };
    getWindow()?.webContents.send('update:status', status);
  };

  const feed = FEED_OVERRIDE ?? latestReleaseUrl(UPDATE_REPO);
  const reason = disabledReason(feed);
  if (reason) status = { ...status, state: 'disabled', message: reason };
  const enabled = !reason;

  // The copy this one replaced could not be deleted while it was still running.
  if (PROGRAM_FILE) setTimeout(() => rmSync(oldCopy(PROGRAM_FILE), { force: true }), OLD_COPY_CLEANUP_DELAY_MS);

  async function check(): Promise<void> {
    if (!enabled || status.state === 'checking' || status.state === 'downloading' || status.state === 'downloaded') return;
    publish({ state: 'checking', message: undefined });
    try {
      latest = await fetchRelease(feed);
      if (isNewerVersion(latest.version, app.getVersion())) publish({ state: 'available', newVersion: latest.version });
      else publish({ state: 'not-available', newVersion: undefined });
    } catch (e) {
      publish({ state: 'error', message: (e as Error).message });
    }
  }

  async function downloadUpdate(): Promise<void> {
    if (!enabled || status.state !== 'available' || !latest) return;
    const asset = latest.asset;
    try {
      if (!PROGRAM_FILE) throw new Error('Chỉ bản chạy từ tệp .exe mới tự thay được chính nó.');
      if (!asset) throw new Error('Bản phát hành không kèm tệp chương trình.');
      if (!isAllowedUpdateUrl(asset.url)) throw new Error('Địa chỉ tải bản mới phải dùng HTTPS.');
      // The new program replaces this one, so it must be exactly the file that was published.
      if (!asset.sha256) throw new Error('Bản phát hành không kèm mã kiểm tra SHA-256.');
      publish({ state: 'downloading', percent: 0 });
      const sha256 = await download(asset.url, newCopy(PROGRAM_FILE), (percent) => publish({ percent }));
      if (sha256 !== asset.sha256) throw new Error('Tệp tải về không khớp mã kiểm tra, đã bỏ.');
      publish({ state: 'downloaded', percent: 100 });
    } catch (e) {
      if (PROGRAM_FILE) rmSync(newCopy(PROGRAM_FILE), { force: true });
      publish({ state: 'error', message: (e as Error).message });
    }
  }

  /**
   * The launcher keeps the running .exe open, so it cannot be renamed until the program has
   * quit. A small script does the swap once that has happened and starts the new version.
   */
  function install(): void {
    if (!enabled || status.state !== 'downloaded' || !PROGRAM_FILE || !existsSync(newCopy(PROGRAM_FILE))) return;
    const script = `${PROGRAM_FILE}.update.cmd`;
    const lines = [
      '@echo off',
      'set tries=0',
      ':wait',
      'set /a tries+=1',
      `if %tries% gtr ${SWAP_ATTEMPTS} exit`,
      'ping -n 2 127.0.0.1 >nul',
      `move /y "${PROGRAM_FILE}" "${oldCopy(PROGRAM_FILE)}" >nul 2>nul || goto wait`,
      `move /y "${newCopy(PROGRAM_FILE)}" "${PROGRAM_FILE}" >nul`,
      `start "" "${PROGRAM_FILE}"`,
      `del "${oldCopy(PROGRAM_FILE)}" >nul 2>nul`,
      'del "%~f0"',
    ];
    writeFileSync(script, `${lines.join('\r\n')}\r\n`);
    // The launcher's own variables must not reach the script's child, or the new copy would think it is this one.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PORTABLE_EXECUTABLE')));
    spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
    app.quit();
  }

  ipcMain.handle('update:getStatus', () => status);
  ipcMain.handle('update:check', check);
  ipcMain.handle('update:download', downloadUpdate);
  ipcMain.handle('update:install', install);
  if (!enabled) return;

  setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}
