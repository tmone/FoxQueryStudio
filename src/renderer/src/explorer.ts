import type { Registration } from '../../shared/registry';
import type { ConnectionInfo, SchemaTable } from '../../shared/types';
import { displayName, qualifiedName } from './editor';

/** A database of a connection; its tables are loaded the first time it is opened. */
export interface ExplorerDatabase {
  name: string;
  tables?: SchemaTable[];
}

/** A connection as the explorer shows it: its identity and its databases. */
export interface ExplorerConnection extends ConnectionInfo {
  databases: ExplorerDatabase[];
  /** True while the list of databases is still on its way. */
  loading?: boolean;
}

/** A remembered connection and, while it is open, its live side. */
export interface ExplorerEntry {
  registration: Registration;
  connection?: ExplorerConnection;
}

export interface ExplorerActions {
  insertText(text: string): void;
  /** Opens a remembered connection. */
  connect(registrationId: string): void;
  /** Forgets a remembered connection, closing it first. */
  remove(registrationId: string): void;
  /** Opens a new query on the connection and database that reads the first rows of the table. */
  selectTop(connectionId: string, database: string, table: SchemaTable): void;
  /** Makes the connection (and database, when given) the one new queries use. */
  select(connectionId: string, database?: string): void;
  /** Loads the tables of a database the first time its node is opened. */
  loadDatabase(connectionId: string, database: string): void;
  /** Moves the active query tab onto the connection. */
  useForActiveTab(connectionId: string): void;
  refresh(connectionId: string): void;
  disconnect(connectionId: string): void;
}

interface MenuAction {
  label: string;
  icon: IconName;
  run(): void;
}

type IconName =
  | 'server'
  | 'serverOffline'
  | 'database'
  | 'folder'
  | 'table'
  | 'view'
  | 'column'
  | 'cursor'
  | 'connect'
  | 'disconnect'
  | 'remove'
  | 'refresh'
  | 'useForTab'
  | 'preview'
  | 'insertName'
  | 'insertColumns';

/** Line icons, 16×16, in the spirit of the SSMS object explorer; colour comes from CSS. */
const ICONS: Record<IconName, string> = {
  server: '<rect x="2.5" y="2.5" width="11" height="4"/><rect x="2.5" y="9.5" width="11" height="4"/><circle cx="5" cy="4.5" r=".6" fill="currentColor"/><circle cx="5" cy="11.5" r=".6" fill="currentColor"/>',
  serverOffline: '<rect x="2.5" y="2.5" width="11" height="4"/><rect x="2.5" y="9.5" width="11" height="4"/><path d="M11 1.5l3 3M14 1.5l-3 3"/>',
  database: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  folder: '<path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z"/>',
  table: '<rect x="2" y="3" width="12" height="10"/><path d="M2 6h12M6 6v7M10 6v7"/>',
  view: '<rect x="2" y="3" width="12" height="10"/><path d="M2 6h12M6 6v7" stroke-dasharray="1.5 1.5"/><path d="M10 6v7" stroke-dasharray="1.5 1.5"/>',
  column: '<rect x="5" y="2.5" width="6" height="11"/><path d="M5 5.5h6"/>',
  cursor: '<rect x="2" y="3" width="12" height="10"/><path d="M2 6h12M6 6v7"/><path d="M9.5 9.5l3 3M12.5 9.5l-3 3"/>',
  connect: '<path d="M2.5 8h7M7 5l3 3-3 3"/><path d="M11 3.5h2.5v9H11"/>',
  disconnect: '<path d="M5 3.5H2.5v9H5"/><path d="M13.5 8h-7M9.5 5l-3 3 3 3"/>',
  remove: '<path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.7 9h5.6l.7-9"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
  useForTab: '<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 6.5h11M5.5 3.5v3"/><path d="M6 10h4"/>',
  preview: '<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 6.5h11M6 6.5v6M10 6.5v6"/>',
  insertName: '<path d="M3 12.5h10"/><path d="M4.5 10l3.5-7 3.5 7M5.7 7.5h4.6"/>',
  insertColumns: '<path d="M3 2.5h3v11H3zM6.5 2.5h3v11h-3zM10 2.5h3v11h-3z"/>',
};

function icon(name: IconName): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.innerHTML = ICONS[name];
  return svg;
}

type NodeKind = 'server' | 'database' | 'group' | 'table' | 'view' | 'folder' | 'cursors';

/** A tree node: a collapsible `details` whose summary carries an icon and a label. */
function node(kind: NodeKind, iconName: IconName, label: string, open = false): { details: HTMLDetailsElement; summary: HTMLElement } {
  const details = document.createElement('details');
  // `table` is kept on views too: both are objects whose columns can be listed.
  details.className = kind === 'view' ? 'node table view' : `node ${kind}`;
  details.open = open;
  const summary = document.createElement('summary');
  const text = document.createElement('span');
  text.className = 'label';
  text.textContent = label;
  summary.append(icon(iconName), text);
  details.append(summary);
  return { details, summary };
}

/** A line with a turning ring, for a node whose contents are on their way. */
function loadingLine(text: string): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'empty loading';
  const ring = document.createElement('span');
  ring.className = 'spinner';
  ring.setAttribute('role', 'progressbar');
  ring.setAttribute('aria-label', text);
  line.append(ring, text);
  return line;
}

function leaf(className: string, iconName: IconName, label: string, detail = ''): HTMLLIElement {
  const item = document.createElement('li');
  item.className = className;
  item.append(icon(iconName), label);
  if (detail) {
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = ` ${detail}`;
    item.append(type);
  }
  return item;
}

/** The root label of a connection: the FoxPro database file or folder, or server and login. */
export const connectionLabel = (c: ConnectionInfo) => (c.kind === 'foxpro' ? `FoxPro (${c.localPath})` : `${c.server} (${c.user})`);
export const registrationLabel = (r: Registration) => (r.kind === 'foxpro' ? `FoxPro (${r.path})` : `${r.profile.server} (${r.profile.user})`);

/**
 * Object explorer laid out like SSMS: one root per remembered connection, each open one with
 * its databases, folders for tables and views, and the cursors of the active query tab under
 * the database that tab runs in. Nodes are updated in place; the tree is only rebuilt when
 * connections come or go, or the filter changes.
 */
export function createExplorer(host: HTMLElement, actions: ExplorerActions) {
  let entries: ExplorerEntry[] = [];
  /** The connection and database new queries use. */
  let currentId: string | undefined;
  let currentDatabase: string | undefined;
  let filter = '';
  /** Cursors of the active tab, shown under its database. */
  let cursors: string[] = [];
  let currentCursor: string | undefined;
  let cursorsConnectionId: string | undefined;
  let cursorsDatabase: string | undefined;
  let cursorsNode: HTMLDetailsElement | undefined;
  let contextMenu: HTMLElement | undefined;
  /** Nodes the user opened or closed, so a rebuild keeps the tree as it was. */
  const openDatabases = new Set<string>();
  const closedServers = new Set<string>();
  const databaseKey = (connectionId: string, database: string) => `${connectionId}\n${database}`;
  /** Live nodes, for updates in place. */
  const serverNodes = new Map<string, HTMLDetailsElement>();
  const databaseNodes = new Map<string, { details: HTMLDetailsElement; connection: ExplorerConnection; database: ExplorerDatabase }>();

  const closeContextMenu = () => {
    contextMenu?.remove();
    contextMenu = undefined;
  };
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeContextMenu());
  window.addEventListener('blur', closeContextMenu);

  function showContextMenu(event: MouseEvent, items: MenuAction[]): void {
    event.preventDefault();
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.append(icon(item.icon), item.label);
      button.addEventListener('click', item.run);
      menu.append(button);
    }
    document.body.append(menu);
    // Keep the menu inside the window.
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4)}px`;
    contextMenu = menu;
  }

  function tableNode(connectionId: string, database: string, table: SchemaTable): HTMLDetailsElement {
    const { details, summary } = node(table.isView ? 'view' : 'table', table.isView ? 'view' : 'table', displayName(table));
    summary.title = 'Nhấp đúp để chèn tên; nhấp phải để xem thêm lệnh';
    summary.addEventListener('dblclick', () => actions.insertText(qualifiedName(table)));
    summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Xem 100 dòng đầu', icon: 'preview', run: () => actions.selectTop(connectionId, database, table) },
        { label: 'Chèn tên vào truy vấn', icon: 'insertName', run: () => actions.insertText(qualifiedName(table)) },
        { label: 'Chèn danh sách cột', icon: 'insertColumns', run: () => actions.insertText(table.columns.map((c) => c.name).join(', ')) },
      ]),
    );
    // Columns are built on first expand to keep large schemas light.
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('.folder')) return;
      const folder = node('folder', 'folder', `Cột (${table.columns.length})`, true);
      const list = document.createElement('ul');
      for (const column of table.columns) {
        const item = leaf('column', 'column', column.name, `${column.display ?? column.dataType}${column.nullable ? ', null' : ''}`);
        item.addEventListener('dblclick', () => actions.insertText(column.name));
        list.append(item);
      }
      folder.details.append(list);
      details.append(folder.details);
    });
    return details;
  }

  /** Draws the cursors of the active tab into the node that holds them. */
  function renderCursors(): void {
    if (!cursorsNode) return;
    const list = document.createElement('ul');
    for (const name of cursors) {
      const item = leaf('cursor', 'cursor', name, name === currentCursor ? 'đang chọn' : '');
      item.addEventListener('dblclick', () => actions.insertText(name));
      list.append(item);
    }
    cursorsNode.querySelector('summary > .label')!.textContent = `Cursor của tab (${cursors.length})`;
    cursorsNode.querySelector('ul')?.remove();
    cursorsNode.append(list);
  }

  /** Puts the cursors node under the database the active tab runs in, creating it there. */
  function placeCursors(): void {
    cursorsNode?.remove();
    cursorsNode = undefined;
    const target = cursorsConnectionId && cursorsDatabase ? databaseNodes.get(databaseKey(cursorsConnectionId, cursorsDatabase)) : undefined;
    if (!target || !target.database.tables) return;
    cursorsNode = node('cursors', 'folder', '', true).details;
    target.details.append(cursorsNode);
    renderCursors();
  }

  /** Fills a database node with its table and view folders once the tables are known. */
  function fillDatabase(details: HTMLDetailsElement, connection: ExplorerConnection, database: ExplorerDatabase): void {
    details.querySelectorAll(':scope > .group, :scope > .empty').forEach((e) => e.remove());
    if (!database.tables) {
      // Closed: a hint; open: the ring, since the tables are being fetched.
      if (details.open) details.append(loadingLine('Đang nạp danh sách bảng…'));
      else {
        const hint = document.createElement('div');
        hint.className = 'empty';
        hint.textContent = 'Mở để nạp danh sách bảng…';
        details.append(hint);
      }
      return;
    }
    const visible = database.tables.filter((t) => displayName(t).toLowerCase().includes(filter));
    const group = (title: string, tables: SchemaTable[], open: boolean) => {
      const { details: folder } = node('group', 'folder', `${title} (${tables.length})`, open);
      folder.append(...tables.map((t) => tableNode(connection.id, database.name, t)));
      return folder;
    };
    details.append(
      group('Bảng', visible.filter((t) => !t.isView), true),
      // With a filter typed, matching views should be visible without another click.
      group('View', visible.filter((t) => t.isView), filter !== ''),
    );
  }

  function databaseNode(connection: ExplorerConnection, database: ExplorerDatabase): HTMLDetailsElement {
    const key = databaseKey(connection.id, database.name);
    if (connection.databases.length === 1) openDatabases.add(key);
    const { details, summary } = node('database', 'database', database.name, openDatabases.has(key));
    details.classList.toggle('current', connection.id === currentId && database.name === currentDatabase);
    summary.title = 'Nhấp để chọn làm CSDL cho truy vấn mới';
    summary.addEventListener('click', () => actions.select(connection.id, database.name));
    details.addEventListener('toggle', () => {
      if (details.open) openDatabases.add(key);
      else openDatabases.delete(key);
      if (!database.tables) {
        fillDatabase(details, connection, database);
        if (details.open) actions.loadDatabase(connection.id, database.name);
      }
    });
    databaseNodes.set(key, { details, connection, database });
    fillDatabase(details, connection, database);
    if (details.open && !database.tables) actions.loadDatabase(connection.id, database.name);
    return details;
  }

  function connectionNode(connection: ExplorerConnection): HTMLDetailsElement {
    const server = node('server', 'server', connectionLabel(connection), !closedServers.has(connection.id));
    server.details.addEventListener('toggle', () => (server.details.open ? closedServers.delete(connection.id) : closedServers.add(connection.id)));
    server.details.classList.toggle('current', connection.id === currentId);
    server.summary.title = 'Nhấp để chọn làm kết nối cho truy vấn mới; nhấp phải để xem thêm lệnh';
    server.summary.addEventListener('click', () => actions.select(connection.id));
    server.summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Dùng cho tab đang mở', icon: 'useForTab', run: () => actions.useForActiveTab(connection.id) },
        { label: 'Làm mới', icon: 'refresh', run: () => actions.refresh(connection.id) },
        { label: 'Ngắt kết nối', icon: 'disconnect', run: () => actions.disconnect(connection.id) },
        { label: 'Xóa khỏi danh sách', icon: 'remove', run: () => actions.remove(connection.id) },
      ]),
    );
    if (connection.loading) server.details.append(loadingLine('Đang nạp danh sách cơ sở dữ liệu…'));
    server.details.append(...connection.databases.map((database) => databaseNode(connection, database)));
    serverNodes.set(connection.id, server.details);
    return server.details;
  }

  /** A remembered connection that is not open: one line, opened with a double-click. */
  function offlineNode(registration: Registration): HTMLDetailsElement {
    const { details, summary } = node('server', 'serverOffline', registrationLabel(registration));
    details.classList.add('offline');
    summary.title = 'Chưa kết nối. Nhấp đúp để kết nối; nhấp phải để xem thêm lệnh';
    summary.addEventListener('click', (event) => event.preventDefault());
    summary.addEventListener('dblclick', () => actions.connect(registration.id));
    summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Kết nối', icon: 'connect', run: () => actions.connect(registration.id) },
        { label: 'Xóa khỏi danh sách', icon: 'remove', run: () => actions.remove(registration.id) },
      ]),
    );
    return details;
  }

  /** Rebuilds the whole tree: only when connections come or go, or the filter changes. */
  function render(): void {
    closeContextMenu();
    cursorsNode = undefined;
    serverNodes.clear();
    databaseNodes.clear();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Kết nối SQL Server hoặc mở CSDL FoxPro để xem danh sách bảng và view.';
      host.replaceChildren(empty);
      return;
    }
    // A rebuild must not move what the user is looking at.
    const scrollTop = host.scrollTop;
    host.replaceChildren(...entries.map((entry) => (entry.connection ? connectionNode(entry.connection) : offlineNode(entry.registration))));
    host.scrollTop = scrollTop;
    placeCursors();
  }

  /** Marks the connection and database new queries use, without touching anything else. */
  function markCurrent(): void {
    for (const [id, details] of serverNodes) details.classList.toggle('current', id === currentId);
    // Only the marks change: the click that chose a node is also the click that opens or closes it.
    for (const { details, connection, database } of databaseNodes.values()) {
      details.classList.toggle('current', connection.id === currentId && database.name === currentDatabase);
    }
  }

  render();
  return {
    setEntries(next: ExplorerEntry[], current: string | undefined, database: string | undefined): void {
      entries = next;
      currentId = current;
      currentDatabase = database;
      if (current && database) openDatabases.add(databaseKey(current, database));
      render();
    },
    /** The connection and database new queries use changed; nodes keep their state. */
    setCurrent(current: string | undefined, database: string | undefined): void {
      currentId = current;
      currentDatabase = database;
      markCurrent();
    },
    /** The tables of a database arrived; its node is filled where it stands. */
    databaseLoaded(connectionId: string, database: string): void {
      const entry = databaseNodes.get(databaseKey(connectionId, database));
      if (!entry) return;
      fillDatabase(entry.details, entry.connection, entry.database);
      if (connectionId === cursorsConnectionId && database === cursorsDatabase) placeCursors();
    },
    setFilter(text: string): void {
      filter = text.trim().toLowerCase();
      render();
    },
    /** Cursors change after almost every run, so they are redrawn without touching the rest of the tree. */
    setCursors(connectionId: string | undefined, database: string | undefined, names: string[], current: string | undefined): void {
      cursors = names;
      currentCursor = current;
      if (connectionId !== cursorsConnectionId || database !== cursorsDatabase) {
        cursorsConnectionId = connectionId;
        cursorsDatabase = database;
        if (connectionId && database) {
          openDatabases.add(databaseKey(connectionId, database));
          const target = databaseNodes.get(databaseKey(connectionId, database));
          if (target) target.details.open = true;
        }
        placeCursors();
      } else {
        renderCursors();
      }
    },
  };
}
