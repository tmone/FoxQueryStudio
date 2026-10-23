import { formatRunTime, queryTitle, type Bookmark, type HistoryEntry } from '../../shared/journal';
import { icon, showContextMenu } from './widgets';

/** What the lists ask the window to do with an entry. */
export interface JournalActions {
  /** Opens the SQL in a new tab (on the connection named, when it is still open) and runs it when asked. */
  open(sql: string, language: HistoryEntry['language'], connection?: string, database?: string, run?: boolean, params?: Record<string, string>, inPlace?: boolean, procedure?: string): void;
  /** Asks for a name and keeps the SQL as a bookmark. */
  bookmark(sql: string, language: HistoryEntry['language']): void;
  rename(bookmark: Bookmark): void;
  removeBookmark(id: string): void;
  clearHistory(): void;
  copy(text: string): void;
}

const HISTORY_LIMIT = 500;
/** A sweep of the list is cheap; typing in the filter waits this long before one. */
const FILTER_DELAY_MS = 150;

function line(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/**
 * The history and bookmark lists of the side pane. Both read from the journal through the
 * window and show the newest (or the names, alphabetically); a double-click opens the entry
 * in a new tab and the context menu offers the rest.
 */
export function createJournal(actions: JournalActions) {
  const historyList = document.getElementById('history-list')!;
  const historyFilter = document.getElementById('history-filter') as HTMLInputElement;
  const historyCount = document.getElementById('history-count')!;
  const bookmarkList = document.getElementById('bookmark-list')!;
  const bookmarkFilter = document.getElementById('bookmark-filter') as HTMLInputElement;
  let bookmarks: Bookmark[] = [];
  let timer: number | undefined;

  function empty(text: string): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = text;
    return div;
  }

  function historyItem(entry: HistoryEntry): HTMLDivElement {
    const item = document.createElement('div');
    item.className = `journal-item${entry.error ? ' failed' : ''}`;
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    const head = document.createElement('div');
    head.className = 'head';
    const outcome = entry.error ? 'lỗi' : `${entry.rows ?? 0} dòng`;
    head.append(icon(entry.error ? 'remove' : 'history'), line('when', formatRunTime(entry.at)), line('outcome', `${outcome} · ${(entry.elapsedMs / 1000).toFixed(2)} s`));
    const where = line('where', entry.database ? `${entry.connection} · ${entry.database}` : entry.connection);
    const sql = line('sql', queryTitle(entry.sql));
    sql.lang = entry.language;
    item.append(head, where, sql);
    item.title = `${entry.sql}\n\n${entry.error ?? ''}`.trim();
    const open = (run: boolean) => actions.open(entry.sql, entry.language, entry.connection, entry.database, run);
    item.addEventListener('dblclick', () => open(false));
    item.addEventListener('keydown', (e) => e.key === 'Enter' && open(false));
    item.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Mở trong tab mới', icon: 'openTab', run: () => open(false) },
        { label: 'Chạy lại', icon: 'run', run: () => open(true) },
        { label: 'Lưu làm dấu trang…', icon: 'bookmark', run: () => actions.bookmark(entry.sql, entry.language) },
        { label: 'Sao chép lệnh', icon: 'copy', run: () => actions.copy(entry.sql) },
        { label: 'Xóa toàn bộ lịch sử…', icon: 'remove', run: actions.clearHistory },
      ]),
    );
    return item;
  }

  function bookmarkItem(bookmark: Bookmark): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'journal-item';
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    const head = document.createElement('div');
    head.className = 'head';
    head.append(icon('bookmark'), line('name', bookmark.name), line('outcome', bookmark.language === 'tsql' ? 'T-SQL' : 'FOX-SQL'));
    item.append(head, line('sql', queryTitle(bookmark.sql)));
    const paramLines = [...(bookmark.procedure ? [`Thủ tục: ${bookmark.procedure}`] : []), ...(bookmark.params ? Object.entries(bookmark.params).map(([k, v]) => `${k} = ${v}`) : [])];
    item.title = paramLines.length ? [bookmark.sql, ...paramLines].join('\n') : bookmark.sql;
    // The bookmark's own parameter values go with it, so running it asks nothing.
    // "Chạy" runs the bookmark in the current tab, on its work area (the procedure's cursor); a new tab has none.
    const open = (run: boolean) => actions.open(bookmark.sql, bookmark.language, undefined, undefined, run, bookmark.params, run, bookmark.procedure);
    item.addEventListener('dblclick', () => open(false));
    item.addEventListener('keydown', (e) => e.key === 'Enter' && open(false));
    item.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Mở trong tab mới', icon: 'openTab', run: () => open(false) },
        { label: 'Chạy', icon: 'run', run: () => open(true) },
        { label: 'Đổi tên…', icon: 'rename', run: () => actions.rename(bookmark) },
        { label: 'Sao chép lệnh', icon: 'copy', run: () => actions.copy(bookmark.sql) },
        { label: 'Xóa dấu trang', icon: 'remove', run: () => actions.removeBookmark(bookmark.id) },
      ]),
    );
    return item;
  }

  async function refreshHistory(): Promise<void> {
    const text = historyFilter.value.trim();
    const entries = await window.journal.history({ text, limit: HISTORY_LIMIT });
    historyList.replaceChildren(...(entries.length ? entries.map(historyItem) : [empty(text ? 'Không có lệnh nào khớp.' : 'Chưa có lệnh nào được chạy.')]));
    historyCount.textContent = entries.length ? `${entries.length}${entries.length === HISTORY_LIMIT ? '+' : ''} lệnh` : '';
  }

  function renderBookmarks(): void {
    const needle = bookmarkFilter.value.trim().toLowerCase();
    const shown = bookmarks.filter((b) => !needle || b.name.toLowerCase().includes(needle) || b.sql.toLowerCase().includes(needle));
    bookmarkList.replaceChildren(...(shown.length ? shown.map(bookmarkItem) : [empty(needle ? 'Không có dấu trang nào khớp.' : 'Chưa có dấu trang. Nhấn Ctrl+D để lưu truy vấn đang soạn.')]));
  }

  async function refreshBookmarks(): Promise<void> {
    bookmarks = await window.journal.bookmarks();
    renderBookmarks();
  }

  historyFilter.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refreshHistory(), FILTER_DELAY_MS);
  });
  bookmarkFilter.addEventListener('input', renderBookmarks);

  return { refreshHistory, refreshBookmarks };
}
