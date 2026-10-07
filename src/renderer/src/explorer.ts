import type { Registration } from '../../shared/registry';
import type { ConnectionInfo, SchemaTable } from '../../shared/types';
import { displayName, qualifiedName } from './editor';

/** A connection as the explorer shows it: its identity and the objects loaded from it. */
export interface ExplorerConnection extends ConnectionInfo {
  tables: SchemaTable[];
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
  /** Opens a new query on the connection that reads the first rows of the table. */
  selectTop(connectionId: string, table: SchemaTable): void;
  /** Makes the connection the one new queries use. */
  select(connectionId: string): void;
  /** Moves the active query tab onto the connection. */
  useForActiveTab(connectionId: string): void;
  refresh(connectionId: string): void;
  disconnect(connectionId: string): void;
}

interface MenuAction {
  label: string;
  icon: MenuIcon;
  run(): void;
}

type MenuIcon = 'connect' | 'disconnect' | 'remove' | 'refresh' | 'useForTab' | 'preview' | 'insertName' | 'insertColumns';

/** Small line icons for the context menu, 16×16, drawn with the text colour. */
const MENU_ICONS: Record<MenuIcon, string> = {
  connect: '<path d="M2.5 8h7M7 5l3 3-3 3"/><path d="M11 3.5h2.5v9H11"/>',
  disconnect: '<path d="M5 3.5H2.5v9H5"/><path d="M13.5 8h-7M9.5 5l-3 3 3 3"/>',
  remove: '<path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.7 9h5.6l.7-9"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
  useForTab: '<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 6.5h11M5.5 3.5v3"/><path d="M6 10h4"/>',
  preview: '<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 6.5h11M6 6.5v6M10 6.5v6"/>',
  insertName: '<path d="M3 12.5h10"/><path d="M4.5 10l3.5-7 3.5 7M5.7 7.5h4.6"/>',
  insertColumns: '<path d="M3 2.5h3v11H3zM6.5 2.5h3v11h-3zM10 2.5h3v11h-3z"/>',
};

function menuIcon(name: MenuIcon): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = MENU_ICONS[name];
  return svg;
}

type NodeKind = 'server' | 'database' | 'group' | 'table' | 'view' | 'folder' | 'cursors';

/** A tree node: a collapsible `details` whose summary carries an icon and a label. */
function node(kind: NodeKind, label: string, open = false): { details: HTMLDetailsElement; summary: HTMLElement } {
  const details = document.createElement('details');
  // `table` is kept on views too: both are objects whose columns can be listed.
  details.className = kind === 'view' ? 'node table view' : `node ${kind}`;
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = label;
  details.append(summary);
  return { details, summary };
}

function leaf(className: string, label: string, detail = ''): HTMLLIElement {
  const item = document.createElement('li');
  item.className = className;
  item.append(label);
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
 * Object explorer laid out like SSMS: one root per open connection, each with its database,
 * folders for tables and views, and the cursors of the active query tab under the
 * connection that tab runs on.
 */
export function createExplorer(host: HTMLElement, actions: ExplorerActions) {
  let entries: ExplorerEntry[] = [];
  /** The connection new queries use. */
  let currentId: string | undefined;
  let filter = '';
  /** Cursors of the active tab, shown under its connection. */
  let cursors: string[] = [];
  let currentCursor: string | undefined;
  let cursorsConnectionId: string | undefined;
  let cursorsNode: HTMLDetailsElement | undefined;
  let contextMenu: HTMLElement | undefined;

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
      button.append(menuIcon(item.icon), item.label);
      button.addEventListener('click', item.run);
      menu.append(button);
    }
    document.body.append(menu);
    // Keep the menu inside the window.
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4)}px`;
    contextMenu = menu;
  }

  function tableNode(connectionId: string, table: SchemaTable): HTMLDetailsElement {
    const { details, summary } = node(table.isView ? 'view' : 'table', displayName(table));
    summary.title = 'Nhấp đúp để chèn tên; nhấp phải để xem thêm lệnh';
    summary.addEventListener('dblclick', () => actions.insertText(qualifiedName(table)));
    summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Xem 100 dòng đầu', icon: 'preview', run: () => actions.selectTop(connectionId, table) },
        { label: 'Chèn tên vào truy vấn', icon: 'insertName', run: () => actions.insertText(qualifiedName(table)) },
        { label: 'Chèn danh sách cột', icon: 'insertColumns', run: () => actions.insertText(table.columns.map((c) => c.name).join(', ')) },
      ]),
    );
    // Columns are built on first expand to keep large schemas light.
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('.folder')) return;
      const folder = node('folder', `Cột (${table.columns.length})`, true);
      const list = document.createElement('ul');
      for (const column of table.columns) {
        const item = leaf('column', column.name, `${column.display ?? column.dataType}${column.nullable ? ', null' : ''}`);
        item.addEventListener('dblclick', () => actions.insertText(column.name));
        list.append(item);
      }
      folder.details.append(list);
      details.append(folder.details);
    });
    return details;
  }

  function renderCursors(): void {
    if (!cursorsNode) return;
    const list = document.createElement('ul');
    for (const name of cursors) {
      const item = leaf('cursor', name, name === currentCursor ? 'đang chọn' : '');
      item.addEventListener('dblclick', () => actions.insertText(name));
      list.append(item);
    }
    cursorsNode.querySelector('summary')!.textContent = `Cursor của tab (${cursors.length})`;
    cursorsNode.querySelector('ul')?.remove();
    cursorsNode.append(list);
  }

  function connectionNode(connection: ExplorerConnection): HTMLDetailsElement {
    const visible = connection.tables.filter((t) => displayName(t).toLowerCase().includes(filter));
    const group = (title: string, tables: SchemaTable[], open: boolean) => {
      const { details } = node('group', `${title} (${tables.length})`, open);
      details.append(...tables.map((t) => tableNode(connection.id, t)));
      return details;
    };

    const server = node('server', connectionLabel(connection), true);
    server.details.classList.toggle('current', connection.id === currentId);
    server.summary.title = connection.id === currentId ? 'Kết nối của truy vấn mới' : 'Nhấp để chọn làm kết nối cho truy vấn mới';
    server.summary.addEventListener('click', () => actions.select(connection.id));
    server.summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Dùng cho tab đang mở', icon: 'useForTab', run: () => actions.useForActiveTab(connection.id) },
        { label: 'Làm mới', icon: 'refresh', run: () => actions.refresh(connection.id) },
        { label: 'Ngắt kết nối', icon: 'disconnect', run: () => actions.disconnect(connection.id) },
        { label: 'Xóa khỏi danh sách', icon: 'remove', run: () => actions.remove(connection.id) },
      ]),
    );
    const database = node('database', connection.database, true);
    database.details.append(
      group('Bảng', visible.filter((t) => !t.isView), true),
      // With a filter typed, matching views should be visible without another click.
      group('View', visible.filter((t) => t.isView), filter !== ''),
    );
    if (connection.id === cursorsConnectionId) {
      cursorsNode = node('cursors', '', true).details;
      database.details.append(cursorsNode);
    }
    server.details.append(database.details);
    return server.details;
  }

  /** A remembered connection that is not open: one line, opened with a double-click. */
  function offlineNode(registration: Registration): HTMLDetailsElement {
    const { details, summary } = node('server', registrationLabel(registration));
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

  function render(): void {
    closeContextMenu();
    cursorsNode = undefined;
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Kết nối SQL Server hoặc mở CSDL FoxPro để xem danh sách bảng và view.';
      host.replaceChildren(empty);
      return;
    }
    host.replaceChildren(...entries.map((entry) => (entry.connection ? connectionNode(entry.connection) : offlineNode(entry.registration))));
    renderCursors();
  }

  render();
  return {
    setEntries(next: ExplorerEntry[], current: string | undefined): void {
      entries = next;
      currentId = current;
      render();
    },
    setFilter(text: string): void {
      filter = text.trim().toLowerCase();
      render();
    },
    /** Cursors change after almost every run, so they are redrawn without touching the rest of the tree. */
    setCursors(connectionId: string | undefined, names: string[], current: string | undefined): void {
      cursors = names;
      currentCursor = current;
      if (connectionId !== cursorsConnectionId) {
        cursorsConnectionId = connectionId;
        render();
      } else {
        renderCursors();
      }
    },
  };
}
