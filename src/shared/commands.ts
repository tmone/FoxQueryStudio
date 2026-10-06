/** Everything the menu, the toolbar and the keyboard can ask the window to do. */
export type AppCommand =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.closeTab'
  | 'connection.connect'
  | 'connection.disconnect'
  | 'connection.refresh'
  | 'local.open'
  | 'query.run'
  | 'query.switchLanguage'
  | 'view.explorer'
  | 'view.output'
  | 'view.results'
  | 'view.messages'
  | 'view.tsql'
  | 'view.compare'
  | 'help.checkUpdates'
  | 'help.about';

export interface CommandInfo {
  label: string;
  /** Key combination in Electron accelerator notation, also matched by the window itself. */
  shortcut?: string;
}

export const COMMANDS: Record<AppCommand, CommandInfo> = {
  'file.new': { label: 'Truy vấn mới', shortcut: 'Ctrl+N' },
  'file.open': { label: 'Mở tệp…', shortcut: 'Ctrl+O' },
  'file.save': { label: 'Lưu', shortcut: 'Ctrl+S' },
  'file.saveAs': { label: 'Lưu thành…', shortcut: 'Ctrl+Shift+S' },
  'file.closeTab': { label: 'Đóng tab', shortcut: 'Ctrl+W' },
  'connection.connect': { label: 'Kết nối…', shortcut: 'Ctrl+Shift+C' },
  'connection.disconnect': { label: 'Ngắt kết nối' },
  'connection.refresh': { label: 'Làm mới danh sách đối tượng', shortcut: 'Ctrl+Shift+R' },
  'local.open': { label: 'Mở CSDL FoxPro (.dbc / .dbf)…', shortcut: 'Ctrl+Shift+O' },
  'query.run': { label: 'Chạy', shortcut: 'F5' },
  'query.switchLanguage': { label: 'Đổi ngôn ngữ FOX-SQL / T-SQL', shortcut: 'Ctrl+Shift+L' },
  'view.explorer': { label: 'Cây đối tượng', shortcut: 'F8' },
  'view.output': { label: 'Khung kết quả', shortcut: 'Ctrl+R' },
  'view.results': { label: 'Kết quả' },
  'view.messages': { label: 'Thông báo' },
  'view.tsql': { label: 'Bản dịch' },
  'view.compare': { label: 'So sánh hai cột', shortcut: 'Ctrl+Shift+D' },
  'help.checkUpdates': { label: 'Kiểm tra cập nhật' },
  'help.about': { label: 'Giới thiệu' },
};

/** `-` is a separator; `role:x` is a built-in Electron editing action. */
export type MenuEntry = AppCommand | '-' | `role:${'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'quit' | 'togglefullscreen' | 'zoomIn' | 'zoomOut' | 'resetZoom'}`;

export const MENUS: { label: string; items: MenuEntry[] }[] = [
  { label: '&Tệp', items: ['file.new', 'file.open', '-', 'file.save', 'file.saveAs', '-', 'file.closeTab', '-', 'role:quit'] },
  { label: '&Sửa', items: ['role:undo', 'role:redo', '-', 'role:cut', 'role:copy', 'role:paste', 'role:selectAll'] },
  { label: '&Xem', items: ['view.explorer', 'view.output', '-', 'view.results', 'view.messages', 'view.tsql', 'view.compare', '-', 'role:zoomIn', 'role:zoomOut', 'role:resetZoom', 'role:togglefullscreen'] },
  { label: '&Kết nối', items: ['connection.connect', 'connection.disconnect', '-', 'connection.refresh', '-', 'local.open'] },
  { label: 'Truy &vấn', items: ['query.run', '-', 'query.switchLanguage'] },
  { label: 'Trợ &giúp', items: ['help.checkUpdates', '-', 'help.about'] },
];

/** The shortcut pressed in a key event, in the notation used by `COMMANDS`, e.g. `Ctrl+Shift+S`. */
export function shortcutOf(event: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): string {
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return `${event.ctrlKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
}

const BY_SHORTCUT = new Map(Object.entries(COMMANDS).filter(([, info]) => info.shortcut).map(([id, info]) => [info.shortcut!, id as AppCommand]));

export const commandForShortcut = (shortcut: string): AppCommand | undefined => BY_SHORTCUT.get(shortcut);

export interface OpenedFile {
  path: string;
  content: string;
}

/** Window-level services exposed to the renderer through the preload bridge. */
export interface AppApi {
  onCommand(listener: (command: AppCommand) => void): () => void;
  /** Asks for a file and returns its text, or undefined when the dialog is cancelled. */
  openFile(): Promise<OpenedFile | undefined>;
  /** Writes to `path`, asking for one when it is undefined; returns the path written, or undefined when cancelled. */
  saveFile(path: string | undefined, content: string, suggestedName: string): Promise<string | undefined>;
}
