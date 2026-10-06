import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import type { ConnectionProfile, DbApi } from '../shared/types';
import sql from 'mssql';
import { createDatabase, tediousConfig } from './db';
import { setupLocalDatabase } from './local-db';
import { createLocalEngine } from './local-engine';
import { setupMenu } from './menu';
import { setupUpdater } from './updater';

const server = createDatabase(sql, tediousConfig);
const localEngine = createLocalEngine();
/** Where queries go: the SQL Server connection, or the local engine while a FoxPro folder is open. */
let db: DbApi = server;
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
  ipcMain.handle('db:connect', async (_e, profile: ConnectionProfile) => {
    await localEngine.disconnect();
    db = server;
    await server.connect(profile);
  });
  ipcMain.handle('db:disconnect', () => db.disconnect());
  ipcMain.handle('db:schema', () => db.loadSchema());
  ipcMain.handle('db:execute', (_e, sessionId: string, sql: string, maxRows: number) => db.execute(sessionId, sql, maxRows));
  ipcMain.handle('db:closeSession', (_e, sessionId: string) => db.closeSession(sessionId));
}

void app.whenReady().then(() => {
  registerIpc();
  setupMenu(() => mainWindow);
  setupLocalDatabase(() => mainWindow, localEngine, async () => {
    await server.disconnect();
    db = localEngine;
  });
  setupUpdater(() => mainWindow);
  createWindow();
});

app.on('window-all-closed', () => {
  void db.disconnect().finally(() => {
    localEngine.shutdown();
    app.quit();
  });
});
