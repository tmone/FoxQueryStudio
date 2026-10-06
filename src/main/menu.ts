import { app, dialog, ipcMain, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { COMMANDS, MENUS, type AppCommand, type MenuEntry } from '../shared/commands';

const FILE_FILTERS = [
  { name: 'Truy vấn FoxPro', extensions: ['prg', 'qpr', 'sql', 'txt'] },
  { name: 'Mọi tệp', extensions: ['*'] },
];

/** FoxPro sources are usually saved in the Windows code page rather than UTF-8. */
function decodeSource(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function menuItem(entry: MenuEntry, send: (command: AppCommand) => void): MenuItemConstructorOptions {
  if (entry === '-') return { type: 'separator' };
  if (entry.startsWith('role:')) return { role: entry.slice(5) as MenuItemConstructorOptions['role'] };
  const command = entry as AppCommand;
  // The window handles the keys itself, so the menu only shows them.
  return { label: COMMANDS[command].label, accelerator: COMMANDS[command].shortcut, registerAccelerator: false, click: () => send(command) };
}

export function setupMenu(getWindow: () => BrowserWindow | undefined): void {
  const send = (command: AppCommand) => getWindow()?.webContents.send('app:command', command);
  const template: MenuItemConstructorOptions[] = MENUS.map((menu) => ({ label: menu.label, submenu: menu.items.map((entry) => menuItem(entry, send)) }));
  if (!app.isPackaged) template.push({ label: 'Phát triển', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  ipcMain.handle('file:open', async () => {
    const window = getWindow();
    if (!window) return undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: FILE_FILTERS });
    if (canceled || !filePaths.length) return undefined;
    return { path: filePaths[0], content: decodeSource(await readFile(filePaths[0])) };
  });

  ipcMain.handle('file:save', async (_event, path: string | undefined, content: string, suggestedName: string) => {
    const window = getWindow();
    if (!window) return undefined;
    let target = path;
    if (!target) {
      const chosen = await dialog.showSaveDialog(window, { defaultPath: suggestedName, filters: FILE_FILTERS });
      if (chosen.canceled || !chosen.filePath) return undefined;
      target = chosen.filePath;
    }
    await writeFile(target, content, 'utf8');
    return target;
  });

  ipcMain.handle('app:about', async () => {
    const window = getWindow();
    if (window) await dialog.showMessageBox(window, { type: 'info', title: 'FoxQuery Studio', message: `FoxQuery Studio ${app.getVersion()}`, detail: 'Viết SELECT theo cú pháp FoxPro, chạy trên SQL Server. Chỉ đọc dữ liệu.' });
  });
}
