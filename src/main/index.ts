import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import sql from 'mssql';
import { createConnections } from './connections';
import { createDatabase, tediousConfig } from './db';
import { createFoxEngine } from './fox-engine';
import { locateVfp, setupConnectionIpc } from './local-db';
import { setupMenu } from './menu';
import { readSideConfig } from './side-config';
import { setupUpdater } from './updater';

/** Settings placed next to the program by whoever handed it out. */
const sideConfig = readSideConfig();
/** FoxPro next to the program, or inside it, is looked for before an installed one. */
const SHIPPED_VFP = [...(sideConfig.vfpPath ? [sideConfig.vfpPath] : []), join(process.resourcesPath, 'vfp', 'vfp9.exe')];
const connections = createConnections(
  () => createDatabase(sql, tediousConfig),
  () => createFoxEngine(() => locateVfp(SHIPPED_VFP)),
);
let mainWindow: BrowserWindow | undefined;

// The app looks like SSMS, which is light whatever the Windows theme.
nativeTheme.themeSource = 'light';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'FoxQuery Studio',
    // Shown in the title bar and taskbar; the installed .exe carries the same artwork.
    icon: join(app.getAppPath(), 'build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow = window;
  window.once('closed', () => (mainWindow = undefined));
  window.once('ready-to-show', () => window.show());
  // The app never navigates; external links open in the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle('db:disconnect', (_e, id: string) => connections.disconnect(id));
  ipcMain.handle('db:schema', (_e, id: string) => connections.loadSchema(id));
  ipcMain.handle('db:execute', (_e, id: string, sessionId: string, sql: string, maxRows: number) => connections.execute(id, sessionId, sql, maxRows));
  ipcMain.handle('db:closeSession', (_e, id: string, sessionId: string) => connections.closeSession(id, sessionId));
}

// Tests point the app at a folder of their own, so remembered connections do not leak between runs.
if (process.env.FQS_USER_DATA) app.setPath('userData', process.env.FQS_USER_DATA);

// Tests point the app at a folder of their own, so remembered connections do not leak between runs.
if (process.env.FQS_USER_DATA) app.setPath('userData', process.env.FQS_USER_DATA);

void app.whenReady().then(() => {
  registerIpc();
  setupMenu(() => mainWindow);
  setupConnectionIpc(() => mainWindow, connections, SHIPPED_VFP, sideConfig.openOnStart);
  setupUpdater(() => mainWindow);
  createWindow();
});

app.on('window-all-closed', () => {
  void connections.disconnectAll().finally(() => app.quit());
});
