import { app, ipcMain, type BrowserWindow } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isAllowedUpdateUrl, isNewerVersion, latestReleaseUrl, parseRelease, UPDATE_REPO, type Release, type ReleaseAsset, type UpdateStatus } from '../shared/update';

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
/** Windows ships bsdtar, which reads .zip files. */
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const newCopy = (target: string) => `${target}.new`;
const oldCopy = (target: string) => `${target}.old`;

/**
 * What an update replaces, and with what:
 * - `exe`: the single portable .exe the launcher started us from;
 * - `folder`: the folder the program runs from (the unpacked .zip layout);
 * - `app`: only resources/app.asar in that folder, when the release was built for the same
 *   Electron — the 10 MB app code instead of the 150 MB program.
 */
interface Plan {
  kind: 'exe' | 'folder' | 'app';
  target: string;
  /** Where the download lands; for a folder, the .zip that is then unpacked into target.new. */
  file: string;
  /** What to start once the swap is done. */
  program: string;
  asset: ReleaseAsset;
}

const PROGRAM_FOLDER = app.isPackaged && !PROGRAM_FILE ? dirname(process.execPath) : undefined;
const APP_ASAR = join(process.resourcesPath, 'app.asar');

function planFor(release: Release): Plan {
  if (PROGRAM_FILE) {
    if (!release.asset) throw new Error('Bản phát hành không kèm tệp chương trình.');
    return { kind: 'exe', target: PROGRAM_FILE, file: newCopy(PROGRAM_FILE), program: PROGRAM_FILE, asset: release.asset };
  }
  if (!PROGRAM_FOLDER) throw new Error('Bản chạy từ mã nguồn không tự cập nhật.');
  if (release.app && release.app.electron === process.versions.electron && existsSync(APP_ASAR)) {
    return { kind: 'app', target: APP_ASAR, file: newCopy(APP_ASAR), program: process.execPath, asset: release.app };
  }
  if (!release.folder) throw new Error('Bản phát hành không kèm thư mục chương trình (.zip).');
  return { kind: 'folder', target: PROGRAM_FOLDER, file: `${PROGRAM_FOLDER}.new.zip`, program: join(PROGRAM_FOLDER, basename(process.execPath)), asset: release.folder };
}

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

  let pending: Plan | undefined;

  // The copy this one replaced could not be deleted while it was still running.
  for (const target of [PROGRAM_FILE, PROGRAM_FOLDER, PROGRAM_FOLDER && APP_ASAR]) {
    if (target) setTimeout(() => rmSync(oldCopy(target), { recursive: true, force: true }), OLD_COPY_CLEANUP_DELAY_MS);
  }

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

  /** Unpacks the downloaded folder next to the running one; the swap script moves it into place later. */
  function unpack(zip: string, target: string): void {
    rmSync(newCopy(target), { recursive: true, force: true });
    mkdirSync(newCopy(target), { recursive: true });
    const result = spawnSync(TAR, ['-xf', zip, '-C', newCopy(target)], { windowsHide: true });
    rmSync(zip, { force: true });
    if (result.status !== 0 || !existsSync(join(newCopy(target), basename(process.execPath)))) {
      rmSync(newCopy(target), { recursive: true, force: true });
      throw new Error('Không giải nén được bản mới.');
    }
  }

  async function downloadUpdate(): Promise<void> {
    if (!enabled || status.state !== 'available' || !latest) return;
    let plan: Plan | undefined;
    try {
      plan = planFor(latest);
      const { asset } = plan;
      if (!isAllowedUpdateUrl(asset.url)) throw new Error('Địa chỉ tải bản mới phải dùng HTTPS.');
      // The new program replaces this one, so it must be exactly the file that was published.
      if (!asset.sha256) throw new Error('Bản phát hành không kèm mã kiểm tra SHA-256.');
      publish({ state: 'downloading', percent: 0 });
      const sha256 = await download(asset.url, plan.file, (percent) => publish({ percent }));
      if (sha256 !== asset.sha256) throw new Error('Tệp tải về không khớp mã kiểm tra, đã bỏ.');
      if (plan.kind === 'folder') unpack(plan.file, plan.target);
      pending = plan;
      publish({ state: 'downloaded', percent: 100 });
    } catch (e) {
      if (plan) {
        rmSync(plan.file, { force: true });
        rmSync(newCopy(plan.target), { recursive: true, force: true });
      }
      publish({ state: 'error', message: (e as Error).message });
    }
  }

  /**
   * The launcher keeps the running .exe open, so it cannot be renamed until the program has
   * quit. A small script does the swap once that has happened and starts the new version.
   */
  /**
   * The running program keeps its file (or folder) busy, so the swap happens after it has quit.
   * PowerShell does it, started without a console window; everything it does is built in, so
   * no child process ever opens a window of its own (a .cmd using ping or timeout would).
   * Windows PowerShell ships with every Windows 10 and 11.
   */
  function install(): void {
    if (!enabled || status.state !== 'downloaded' || !pending || !existsSync(newCopy(pending.target))) return;
    const { target, program } = pending;
    const script = `${target}.update.ps1`;
    const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
    const lines = [
      "$ErrorActionPreference = 'Stop'",
      `$target = ${q(target)}; $new = ${q(newCopy(target))}; $old = ${q(oldCopy(target))}; $program = ${q(program)}`,
      '$moved = $false',
      `for ($attempt = 0; $attempt -lt ${SWAP_ATTEMPTS}; $attempt++) {`,
      '  Start-Sleep -Seconds 1',
      '  try {',
      '    if (Test-Path $old) { Remove-Item $old -Recurse -Force }',
      '    Move-Item $target $old',
      '    $moved = $true',
      '    break',
      '  } catch { }',
      '}',
      'if ($moved) {',
      '  Move-Item $new $target',
      '  Start-Process -FilePath $program',
      '  try { Remove-Item $old -Recurse -Force } catch { }',
      '}',
      'Remove-Item $MyInvocation.MyCommand.Path -Force',
    ];
    // A BOM makes Windows PowerShell read the file as UTF-8, whatever characters the paths hold.
    writeFileSync(script, `\uFEFF${lines.join('\r\n')}\r\n`);
    // The launcher's own variables must not reach the script's child, or the new copy would think it is this one.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PORTABLE_EXECUTABLE')));
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
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
