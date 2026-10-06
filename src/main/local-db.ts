import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { loadFoxDatabase, type FoxTable } from '../dbf/database';
import { migratedFields } from '../dbf/to-sql';
import type { LocalDatabase } from '../shared/local-db';
import { localDatabaseName, type LocalEngine } from './local-engine';

/** Reads a FoxPro folder and loads it into the local engine. */
export async function openLocalDatabase(engine: LocalEngine, folder: string): Promise<LocalDatabase> {
  const tables: FoxTable[] = loadFoxDatabase(folder);
  if (!tables.length) throw new Error('Thư mục không có tệp .dbf nào.');
  const name = localDatabaseName(folder);
  await engine.openDatabase(name, tables);
  const notes = tables.flatMap((table) => {
    const kept = migratedFields(table);
    const dropped = table.fields.filter((f) => !kept.includes(f)).map((f) => f.name);
    return dropped.length ? [`${table.name}: bỏ cột kiểu nhị phân ${dropped.join(', ')}`] : [];
  });
  return { path: folder, name, tableCount: tables.length, rowCount: tables.reduce((sum, t) => sum + t.records.length, 0), notes };
}

/**
 * Serves "open a local FoxPro database" to the window. `activate` runs once the database is
 * loaded and switches the window's queries from the SQL Server connection to the local engine.
 */
export function setupLocalDatabase(getWindow: () => BrowserWindow | undefined, engine: LocalEngine, activate: () => Promise<void>): void {
  ipcMain.handle('local:open', async (): Promise<LocalDatabase | undefined> => {
    const window = getWindow();
    if (!window) return undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Chọn thư mục chứa các tệp .dbf', properties: ['openDirectory'] });
    if (canceled || !filePaths.length) return undefined;
    const opened = await openLocalDatabase(engine, filePaths[0]);
    await activate();
    return opened;
  });
}
