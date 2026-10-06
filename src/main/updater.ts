import { app, ipcMain, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedUpdateUrl, type UpdateStatus } from '../shared/update';

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 3_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Written by electron-builder when the installer was built with an update server. */
const BUILT_IN_FEED = 'app-update.yml';
/** Optional file in the user data folder that points an installed copy at another server: {"url": "https://..."} */
const OVERRIDE_FILE = 'update.json';

function readOverrideUrl(): string | undefined {
  const file = join(app.getPath('userData'), OVERRIDE_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const url = JSON.parse(readFileSync(file, 'utf8')).url;
    return typeof url === 'string' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Why this copy cannot update itself, or undefined when it can. */
function disabledReason(overrideUrl: string | undefined): string | undefined {
  if (!app.isPackaged) return 'Bản chạy từ mã nguồn không tự cập nhật.';
  if (overrideUrl !== undefined) return isAllowedUpdateUrl(overrideUrl) ? undefined : `Địa chỉ cập nhật trong ${OVERRIDE_FILE} phải dùng HTTPS.`;
  return existsSync(join(process.resourcesPath, BUILT_IN_FEED)) ? undefined : 'Bản cài này không được cấu hình máy chủ cập nhật.';
}

/**
 * Wires the updater to the window. Nothing is downloaded or installed without the
 * user asking for it: a check only reports that a version exists.
 */
export function setupUpdater(getWindow: () => BrowserWindow | undefined): void {
  let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
  const publish = (change: Partial<UpdateStatus>) => {
    status = { ...status, ...change };
    getWindow()?.webContents.send('update:status', status);
  };

  const overrideUrl = readOverrideUrl();
  const reason = disabledReason(overrideUrl);
  if (reason) status = { ...status, state: 'disabled', message: reason };
  const enabled = !reason;

  ipcMain.handle('update:getStatus', () => status);
  ipcMain.handle('update:check', async () => {
    if (enabled) await autoUpdater.checkForUpdates().catch(() => undefined);
  });
  ipcMain.handle('update:download', async () => {
    if (enabled && status.state === 'available') await autoUpdater.downloadUpdate().catch(() => undefined);
  });
  ipcMain.handle('update:install', () => {
    // Silent install, then start the new version.
    if (enabled && status.state === 'downloaded') autoUpdater.quitAndInstall(true, true);
  });
  if (!enabled) return;

  if (overrideUrl) autoUpdater.setFeedURL({ provider: 'generic', url: overrideUrl });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', message: undefined }));
  autoUpdater.on('update-available', (info) => publish({ state: 'available', newVersion: info.version }));
  autoUpdater.on('update-not-available', () => publish({ state: 'not-available', newVersion: undefined }));
  autoUpdater.on('download-progress', (progress) => publish({ state: 'downloading', percent: progress.percent }));
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'downloaded', newVersion: info.version, percent: 100 }));
  autoUpdater.on('error', (error) => publish({ state: 'error', message: error.message }));

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}
