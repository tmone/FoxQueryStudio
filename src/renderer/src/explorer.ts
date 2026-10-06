import type { SchemaTable } from '../../shared/types';
import { qualifiedName } from './editor';

export interface ExplorerConnection {
  server: string;
  user: string;
  database: string;
}

export interface ExplorerActions {
  insertText(text: string): void;
  /** Opens a new query that reads the first rows of the table. */
  selectTop(table: SchemaTable): void;
  refresh(): void;
}

interface MenuAction {
  label: string;
  run(): void;
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

/**
 * Object explorer laid out like SSMS: server, database, then folders for tables,
 * views and the cursors of the active query tab.
 */
export function createExplorer(host: HTMLElement, actions: ExplorerActions) {
  let connection: ExplorerConnection | undefined;
  let schema: SchemaTable[] = [];
  let filter = '';
  let cursors: string[] = [];
  let currentCursor: string | undefined;
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
      button.textContent = item.label;
      button.addEventListener('click', item.run);
      menu.append(button);
    }
    document.body.append(menu);
    // Keep the menu inside the window.
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 4)}px`;
    contextMenu = menu;
  }

  function tableNode(table: SchemaTable): HTMLDetailsElement {
    const { details, summary } = node(table.isView ? 'view' : 'table', `${table.schema}.${table.name}`);
    summary.title = 'Nhấp đúp để chèn tên; nhấp phải để xem thêm lệnh';
    summary.addEventListener('dblclick', () => actions.insertText(qualifiedName(table)));
    summary.addEventListener('contextmenu', (event) =>
      showContextMenu(event, [
        { label: 'Xem 100 dòng đầu', run: () => actions.selectTop(table) },
        { label: 'Chèn tên vào truy vấn', run: () => actions.insertText(qualifiedName(table)) },
        { label: 'Chèn danh sách cột', run: () => actions.insertText(table.columns.map((c) => c.name).join(', ')) },
      ]),
    );
    // Columns are built on first expand to keep large schemas light.
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('.folder')) return;
      const folder = node('folder', `Cột (${table.columns.length})`, true);
      const list = document.createElement('ul');
      for (const column of table.columns) {
        const item = leaf('column', column.name, `${column.dataType}${column.nullable ? ', null' : ''}`);
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

  function render(): void {
    closeContextMenu();
    if (!connection) {
      cursorsNode = undefined;
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Kết nối để xem danh sách bảng và view.';
      host.replaceChildren(empty);
      return;
    }

    const visible = schema.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(filter));
    const group = (title: string, tables: SchemaTable[], open: boolean) => {
      const { details } = node('group', `${title} (${tables.length})`, open);
      details.append(...tables.map(tableNode));
      return details;
    };

    const server = node('server', `${connection.server} (${connection.user})`, true);
    server.summary.addEventListener('contextmenu', (event) => showContextMenu(event, [{ label: 'Làm mới', run: actions.refresh }]));
    const database = node('database', connection.database, true);
    cursorsNode = node('cursors', '', true).details;
    database.details.append(
      group('Bảng', visible.filter((t) => !t.isView), true),
      // With a filter typed, matching views should be visible without another click.
      group('View', visible.filter((t) => t.isView), filter !== ''),
      cursorsNode,
    );
    server.details.append(database.details);
    host.replaceChildren(server.details);
    renderCursors();
  }

  render();
  return {
    setConnection(next: ExplorerConnection | undefined, tables: SchemaTable[]): void {
      connection = next;
      schema = tables;
      render();
    },
    setFilter(text: string): void {
      filter = text.trim().toLowerCase();
      render();
    },
    /** Cursors change after almost every run, so they are redrawn without touching the rest of the tree. */
    setCursors(names: string[], current: string | undefined): void {
      cursors = names;
      currentCursor = current;
      renderCursors();
    },
  };
}
