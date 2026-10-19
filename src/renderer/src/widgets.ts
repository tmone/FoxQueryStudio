/** Icons and the context menu shared by the object explorer and the history/bookmark lists. */

export interface MenuAction {
  label: string;
  icon: IconName;
  run(): void;
}

export type IconName =
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
  | 'insertColumns'
  | 'history'
  | 'bookmark'
  | 'run'
  | 'openTab'
  | 'copy'
  | 'rename'
  | 'key'
  | 'foreignKey'
  | 'index';

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
  history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.3"/>',
  bookmark: '<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8L2.5 6.5l3.8-.5z"/>',
  run: '<path d="M4.5 3l8 5-8 5z"/>',
  openTab: '<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 6.5h11M5.5 3.5v3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-3h-8v8h3"/>',
  rename: '<path d="M3 12.5h10"/><path d="M4.5 10l6-6 1.5 1.5-6 6H4.5z"/>',
  key: '<circle cx="5" cy="11" r="2.5"/><path d="M6.8 9.2l6.2-6.2M11 5l1.5 1.5M9 7l1.5 1.5"/>',
  foreignKey: '<circle cx="5" cy="11" r="2.5"/><path d="M6.8 9.2l6.2-6.2M11 5l1.5 1.5M9 7l1.5 1.5"/><path d="M1.5 2.5h3v3" stroke-dasharray="1 1"/>',
  index: '<path d="M3 3.5h10M3 6.5h10M3 9.5h6M3 12.5h4"/><path d="M11.5 9.5v4M10 12l1.5 1.5L13 12"/>',
};

export function icon(name: IconName): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.innerHTML = ICONS[name];
  return svg;
}

let contextMenu: HTMLElement | undefined;

export const closeContextMenu = (): void => {
  contextMenu?.remove();
  contextMenu = undefined;
};
document.addEventListener('click', closeContextMenu);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeContextMenu());
window.addEventListener('blur', closeContextMenu);

export function showContextMenu(event: MouseEvent, items: MenuAction[]): void {
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
