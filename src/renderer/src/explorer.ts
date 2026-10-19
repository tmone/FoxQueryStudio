import type { Registration } from '../../shared/registry';
import type { ConnectionInfo, SchemaColumn, SchemaIndex, SchemaKey, SchemaTable } from '../../shared/types';
import { displayName, qualifiedName } from './editor';
import { closeContextMenu, icon, showContextMenu, type IconName } from './widgets';

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
  /** Makes the table the one the active tab works on, as USE does: SUM, COUNT, BROWSE… need no name then. */
  useTable(connectionId: string, database: string, table: SchemaTable): void;
  /** Makes the connection (and database, when given) the one new queries use. */
  select(connectionId: string, database?: string): void;
  /** Loads the tables of a database the first time its node is opened. */
  loadDatabase(connectionId: string, database: string): void;
  /** Moves the active query tab onto the connection. */
  useForActiveTab(connectionId: string): void;
  refresh(connectionId: string): void;
  disconnect(connectionId: string): void;
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
  /** Nodes the user opened or closed, so a rebuild keeps the tree as it was. */
  const openDatabases = new Set<string>();
  const closedServers = new Set<string>();
  const databaseKey = (connectionId: string, database: string) => `${connectionId}\n${database}`;
  /** Live nodes, for updates in place. */
  const serverNodes = new Map<string, HTMLDetailsElement>();
  const databaseNodes = new Map<string, { details: HTMLDetailsElement; connection: ExplorerConnection; database: ExplorerDatabase }>();

  function tableNode(connectionId: string, database: string, table: SchemaTable): HTMLDetailsElement {
    const { details, summary } = node(table.isView ? 'view' : 'table', table.isView ? 'view' : 'table', displayName(table));
    summary.title = 'Nhấp để chọn làm bảng làm việc của tab (như USE); nhấp đúp để chèn tên; nhấp phải để xem thêm lệnh';
    summary.addEventListener('click', () => actions.useTable(connectionId, database, table));
    summary.addEventListener('dblclick', () => actions.insertText(qualifiedName(table)));
    details.dataset.table = `${connectionId}\n${database}\n${displayName(table).toLowerCase()}`;
    summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Xem 100 dòng đầu', icon: 'preview', run: () => actions.selectTop(connectionId, database, table) },
        { label: 'Chèn tên vào truy vấn', icon: 'insertName', run: () => actions.insertText(qualifiedName(table)) },
        { label: 'Chèn danh sách cột', icon: 'insertColumns', run: () => actions.insertText(table.columns.map((c) => c.name).join(', ')) },
      ]),
    );
    // Columns, keys and indexes are built on first expand to keep large schemas light.
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('.folder')) return;
      details.append(columnsFolder(table), keysFolder(table.keys ?? []), indexesFolder(table.indexes ?? []));
    });
    return details;
  }

  /** `name (PK, nvarchar(150), not null)`, as the SSMS object explorer labels a column. */
  function columnDetail(column: SchemaColumn): string {
    const parts = [column.keyRole, column.display ?? column.dataType, column.nullable ? 'null' : 'not null'].filter(Boolean);
    return `(${parts.join(', ')})`;
  }

  function columnsFolder(table: SchemaTable): HTMLDetailsElement {
    const folder = node('folder', 'folder', `Cột (${table.columns.length})`, true);
    const list = document.createElement('ul');
    for (const column of table.columns) {
      const item = leaf('column', column.keyRole === 'PK' ? 'key' : column.keyRole === 'FK' ? 'foreignKey' : 'column', column.name, columnDetail(column));
      item.addEventListener('dblclick', () => actions.insertText(column.name));
      list.append(item);
    }
    folder.details.append(list);
    return folder.details;
  }

  function keysFolder(keys: SchemaKey[]): HTMLDetailsElement {
    const folder = node('folder', 'folder', `Khóa (${keys.length})`);
    const list = document.createElement('ul');
    for (const key of keys) list.append(leaf('key', key.kind === 'FK' ? 'foreignKey' : 'key', key.name, `(${key.kind}: ${key.columns.join(', ')})`));
    folder.details.append(list);
    return folder.details;
  }

  function indexesFolder(indexes: SchemaIndex[]): HTMLDetailsElement {
    const folder = node('folder', 'folder', `Chỉ mục (${indexes.length})`);
    const list = document.createElement('ul');
    for (const index of indexes) {
      const kind = [index.primary ? 'PK' : index.unique ? 'Unique' : undefined, index.clustered ? 'Clustered' : 'Non-Clustered'].filter(Boolean).join(', ');
      list.append(leaf('index', 'index', index.name, `(${kind}: ${index.columns.join(', ')})`));
    }
    folder.details.append(list);
    return folder.details;
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
    /** Marks the table the active tab works on. */
    setCurrentTable(connectionId: string | undefined, database: string | undefined, name: string | undefined): void {
      const key = connectionId && name ? `${connectionId}\n${database ?? ''}\n${name.toLowerCase()}` : undefined;
      for (const details of host.querySelectorAll<HTMLDetailsElement>('.table')) details.classList.toggle('current', details.dataset.table === key);
    },

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
