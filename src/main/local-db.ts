import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { ConnectionInfo, ConnectionProfile } from '../shared/types';
import { foxDatabaseTarget, type Connections } from './connections';
import { findVfp } from './fox-engine';
import { foxProPathOf, listRegistrations, readSettings, registerFoxPro, registerSql, removeRegistration, sqlProfileOf, writeSettings } from './settings';

const DATABASE_FILTERS = [
  { name: 'CSDL FoxPro', extensions: ['dbc', 'dbf'] },
  { name: 'Mọi tệp', extensions: ['*'] },
];
const VFP_FILTERS = [{ name: 'Visual FoxPro 9', extensions: ['exe'] }];

/** Where FoxPro is: the user's choice first, then the places the app looks by itself. */
export function locateVfp(shipped: string[]): string | undefined {
  const chosen = readSettings().vfpPath;
  return findVfp(chosen ? [chosen, ...shipped] : shipped);
}

/**
 * Serves connecting to the window: SQL Server by profile or by remembered registration,
 * FoxPro databases by file dialog or by registration, the registry itself, and where
 * FoxPro is. A FoxPro database is a container (.dbc) or any table (.dbf): a table that
 * belongs to a container opens the container; a free table opens its folder.
 */
export function setupConnectionIpc(getWindow: () => BrowserWindow | undefined, connections: Connections, shippedVfp: string[], openOnStart: string[] = []): void {
  async function chooseVfp(): Promise<string | undefined> {
    const window = getWindow();
    if (!window) return undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Chọn vfp9.exe của Visual FoxPro 9', properties: ['openFile'], filters: VFP_FILTERS });
    if (canceled || !filePaths.length) return undefined;
    writeSettings({ vfpPath: filePaths[0] });
    return filePaths[0];
  }

  async function openFoxPro(path: string): Promise<ConnectionInfo> {
    // Without FoxPro nothing can run; the user is asked where it is before anything else.
    if (!locateVfp(shippedVfp) && !(await chooseVfp())) throw new Error('Cần Visual FoxPro 9 để mở CSDL FoxPro; chọn vfp9.exe qua menu Kết nối → Đường dẫn Visual FoxPro 9.');
    const info = await connections.openFoxPro(path, registerFoxPro(path));
    // The registration names what was opened (the container, or the folder), not the file picked.
    if (info.localPath !== path) {
      removeRegistration(info.id);
      const id = registerFoxPro(info.localPath!);
      return connections.rename(info.id, id);
    }
    return info;
  }

  ipcMain.handle('vfp:getPath', () => locateVfp(shippedVfp));
  ipcMain.handle('vfp:choose', chooseVfp);

  // Databases listed next to the program are remembered like any other and opened by the window at start.
  ipcMain.handle('registry:startup', () => openOnStart.map((path) => registerFoxPro(foxDatabaseTarget(path).info.localPath!)));
  ipcMain.handle('registry:list', () => listRegistrations());
  ipcMain.handle('registry:remove', async (_e, id: string) => {
    await connections.disconnect(id);
    removeRegistration(id);
  });

  ipcMain.handle('db:connect', (_e, profile: ConnectionProfile, rememberPassword: boolean) => connections.connectSql(profile, registerSql(profile, rememberPassword)));
  ipcMain.handle('db:connectSaved', async (_e, id: string, password?: string): Promise<ConnectionInfo> => {
    const foxPath = foxProPathOf(id);
    if (foxPath) return openFoxPro(foxPath);
    const saved = sqlProfileOf(id);
    if (!saved) throw new Error('Kết nối này không còn trong danh sách.');
    const { hasPassword, ...profile } = saved;
    if (password !== undefined) profile.password = password;
    else if (!hasPassword) throw new Error('NEEDS_PASSWORD');
    return connections.connectSql(profile, id);
  });

  ipcMain.handle('local:open', async (): Promise<ConnectionInfo | undefined> => {
    const window = getWindow();
    if (!window) return undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Chọn tệp CSDL FoxPro (.dbc) hoặc một bảng (.dbf)', properties: ['openFile'], filters: DATABASE_FILTERS });
    if (canceled || !filePaths.length) return undefined;
    return openFoxPro(filePaths[0]);
  });
}
