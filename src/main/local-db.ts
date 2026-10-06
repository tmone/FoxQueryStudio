import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { loadFoxDatabase, type FoxTable } from '../dbf/database';
import { describeDatabase, loadTableSql, type LocalDatabase } from '../shared/local-db';
import type { DbApi } from '../shared/types';

/**
 * Copies tables into a session's #temp tables. Nothing is written outside tempdb,
 * so a login that may only read the project database is enough.
 */
export async function loadTables(execute: DbApi['execute'], sessionId: string, tables: FoxTable[]): Promise<void> {
  for (const table of tables) {
    for (const sql of loadTableSql(table)) {
      const result = await execute(sessionId, sql, 0);
      if (result.error) throw new Error(`Không nạp được bảng ${table.name}: ${result.error}`);
    }
  }
}

/** Keeps the records of the opened FoxPro database and serves them to the window. */
export function setupLocalDatabase(getWindow: () => BrowserWindow | undefined, db: DbApi): void {
  let tables: FoxTable[] = [];

  ipcMain.handle('local:open', async (): Promise<LocalDatabase | undefined> => {
    const window = getWindow();
    if (!window) return undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Chọn thư mục chứa các tệp .dbf', properties: ['openDirectory'] });
    if (canceled || !filePaths.length) return undefined;
    const loaded = loadFoxDatabase(filePaths[0]);
    if (!loaded.length) throw new Error('Thư mục không có tệp .dbf nào.');
    tables = loaded;
    return describeDatabase(filePaths[0], loaded);
  });

  ipcMain.handle('local:close', () => {
    tables = [];
  });

  ipcMain.handle('local:load', (_event, sessionId: string, tableNames: string[]) =>
    loadTables(db.execute, sessionId, tables.filter((t) => tableNames.includes(t.name))),
  );
}
