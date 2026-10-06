import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { LocalDatabase } from '../shared/local-db';
import type { FoxEngine } from './fox-engine';

const FILE_FILTERS = [
  { name: 'CSDL FoxPro', extensions: ['dbc', 'dbf'] },
  { name: 'Mọi tệp', extensions: ['*'] },
];

/**
 * Serves "open a FoxPro database" to the window: a database container (.dbc), or any table
 * (.dbf) of a folder of free tables. `activate` runs once FoxPro has the database open and
 * switches the window's queries from the SQL Server connection to it.
 */
export function setupLocalDatabase(getWindow: () => BrowserWindow | undefined, engine: FoxEngine, activate: () => Promise<void>): void {
  ipcMain.handle('local:open', async (): Promise<LocalDatabase | undefined> => {
    const window = getWindow();
    if (!window) return undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Chọn tệp CSDL FoxPro (.dbc) hoặc một bảng (.dbf)', properties: ['openFile'], filters: FILE_FILTERS });
    if (canceled || !filePaths.length) return undefined;
    const [path] = filePaths;
    await engine.openDatabase(path);
    await activate();
    const name = path.split(/[\\/]/).pop()!;
    // A single table stands for its folder: every free table next to it can be queried.
    return path.toLowerCase().endsWith('.dbc') ? { path, name } : { path: path.slice(0, -name.length - 1), name: path.slice(0, -name.length - 1).split(/[\\/]/).pop()! };
  });
}
