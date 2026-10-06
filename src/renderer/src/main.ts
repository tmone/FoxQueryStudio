import './style.css';
import type { Diagnostic } from '../../converter';
import { columnKindResolver } from '../../shared/column-kind';
import { commandForShortcut, shortcutOf, type AppCommand } from '../../shared/commands';
import { runFoxQuery, type QueryOutcome } from '../../shared/run-query';
import type { ConnectionProfile, ExecuteResult, SchemaTable } from '../../shared/types';
import { updateActionLabel, type UpdateStatus } from '../../shared/update';
import { createEditor, createModel, monaco, qualifiedName, setSchema } from './editor';
import { createExplorer, type ExplorerConnection } from './explorer';
import { renderGrid } from './grid';

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 100;
const PROFILE_STORAGE_KEY = 'fqs.profile';
const MARKER_OWNER = 'foxpro';
const MIN_EXPLORER_WIDTH = 160;
const MIN_OUTPUT_HEIGHT = 80;
const DEFAULT_EXTENSION = '.prg';

type PaneName = 'results' | 'messages' | 'tsql';

interface Tab {
  id: string;
  title: string;
  /** File the tab was opened from or saved to. */
  filePath?: string;
  model: monaco.editor.ITextModel;
  cursors: string[];
  currentCursor?: string;
  result?: ExecuteResult;
  messages: string;
  tsql: string;
  activeSet: number;
  pane: PaneName;
}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Strips the wrapper Electron adds to errors thrown by main-process handlers. */
const ipcErrorMessage = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (\w+: )?/, '');
const fileName = (path: string) => path.split(/[\\/]/).pop()!;
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} giây`;

const tabsHost = el('tabs');
const runButton = el<HTMLButtonElement>('btn-run');
const disconnectButton = el<HTMLButtonElement>('btn-disconnect');
const resultSetsHost = el('result-sets');
const panes: Record<PaneName, HTMLElement> = {
  results: el('pane-results'),
  messages: el('pane-messages'),
  tsql: el('pane-tsql'),
};
const explorerFilter = el<HTMLInputElement>('explorer-filter');
const connectDialog = el<HTMLDialogElement>('connect-dialog');
const connectForm = el<HTMLFormElement>('connect-form');
const connectError = el('connect-error');
const connectSubmit = el<HTMLButtonElement>('connect-submit');
const statusBar = el('statusbar');
const statusState = el('status-state');
const connectionStatus = el('connection-status');
const statusCursor = el('status-cursor');
const statusRows = el('status-rows');
const runStatus = el('run-status');
const statusPosition = el('status-position');
const updateButton = el<HTMLButtonElement>('btn-update');
const versionButton = el<HTMLButtonElement>('app-version');

const editor = createEditor(el('editor'));
const tabs: Tab[] = [];
let active: Tab;
let tabCounter = 0;
let connection: ExplorerConnection | undefined;
let running = false;
let resolveColumnKind = columnKindResolver([]);

const insertIntoEditor = (text: string) => {
  editor.trigger('explorer', 'type', { text });
  editor.focus();
};

const explorer = createExplorer(el('explorer-tree'), {
  insertText: insertIntoEditor,
  selectTop: (table) => {
    newTab(`SELECT TOP ${PREVIEW_ROWS} * FROM ${qualifiedName(table)} ORDER BY 1`);
    void run();
  },
  refresh: () => void refreshSchema(),
});

// ---------- Status bar ----------

function renderStatus(): void {
  statusBar.classList.toggle('connected', connection !== undefined);
  statusState.textContent = connection ? 'Đã kết nối' : 'Chưa kết nối';
  connectionStatus.textContent = connection ? `${connection.user} @ ${connection.server} / ${connection.database}` : '';
  statusCursor.textContent = active.currentCursor ? `Cursor: ${active.currentCursor}` : '';

  const result = active.result;
  const current = result?.resultSets[active.activeSet];
  statusRows.textContent = current ? `${current.rows.length} dòng${result!.truncated ? ' (đã cắt)' : ''}` : '';
  runStatus.textContent = running ? 'Đang chạy…' : result ? (result.error ? 'Lỗi' : seconds(result.elapsedMs)) : '';

  const position = editor.getPosition();
  statusPosition.textContent = position ? `Dòng ${position.lineNumber}, Cột ${position.column}` : '';

  runButton.disabled = !connection || running;
  disconnectButton.disabled = !connection;
}

// ---------- Tabs ----------

function renderTabs(): void {
  tabsHost.replaceChildren(
    ...tabs.map((tab) => {
      const item = document.createElement('div');
      item.className = `tab${tab === active ? ' active' : ''}`;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(tab === active));
      item.tabIndex = 0;
      item.textContent = tab.title;
      if (tab.filePath) item.title = tab.filePath;
      item.addEventListener('click', () => activate(tab));
      item.addEventListener('keydown', (e) => e.key === 'Enter' && activate(tab));

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Đóng ${tab.title}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab);
      });
      item.append(close);
      return item;
    }),
  );
}

function activate(tab: Tab): void {
  active = tab;
  editor.setModel(tab.model);
  editor.focus();
  renderTabs();
  renderOutput();
  explorer.setCursors(tab.cursors, tab.currentCursor);
}

function newTab(text = '', filePath?: string): void {
  tabCounter++;
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: filePath ? fileName(filePath) : `Truy vấn ${tabCounter}`,
    filePath,
    model: createModel(text),
    cursors: [],
    messages: '',
    tsql: '',
    activeSet: 0,
    pane: 'results',
  };
  tabs.push(tab);
  activate(tab);
}

function closeTab(tab: Tab): void {
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  tab.model.dispose();
  void window.db.closeSession(tab.id);
  if (!tabs.length) newTab();
  else if (tab === active) activate(tabs[Math.min(index, tabs.length - 1)]);
  else renderTabs();
}

// ---------- Files ----------

async function openFile(): Promise<void> {
  const file = await window.app.openFile();
  if (file) newTab(file.content, file.path);
}

async function saveFile(askForPath: boolean): Promise<void> {
  const tab = active;
  const path = await window.app.saveFile(askForPath ? undefined : tab.filePath, tab.model.getValue(), tab.filePath ?? `${tab.title}${DEFAULT_EXTENSION}`);
  if (!path) return;
  tab.filePath = path;
  tab.title = fileName(path);
  renderTabs();
}

// ---------- Output ----------

function showPane(name: PaneName): void {
  active.pane = name;
  for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== name;
  document.querySelectorAll<HTMLButtonElement>('.output-tabs > button').forEach((button) => {
    button.classList.toggle('active', button.dataset.pane === name);
  });
}

function placeholder(text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'placeholder';
  div.textContent = text;
  return div;
}

function renderOutput(): void {
  const sets = active.result?.resultSets ?? [];
  panes.messages.textContent = active.messages;
  panes.tsql.textContent = active.tsql;

  resultSetsHost.replaceChildren(
    ...(sets.length > 1
      ? sets.map((_, i) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = `Bảng ${i + 1}`;
          button.classList.toggle('active', i === active.activeSet);
          button.addEventListener('click', () => {
            active.activeSet = i;
            active.pane = 'results';
            renderOutput();
          });
          return button;
        })
      : []),
  );

  const current = sets[active.activeSet];
  if (current) renderGrid(panes.results, current);
  else panes.results.replaceChildren(placeholder('Chưa có kết quả. Viết lệnh SELECT rồi nhấn F5.'));
  showPane(active.pane);
  renderStatus();
}

// ---------- Run ----------

function setMarkers(tab: Tab, errors: Diagnostic[], warnings: Diagnostic[]): void {
  const toMarker = (d: Diagnostic, severity: monaco.MarkerSeverity): monaco.editor.IMarkerData => ({
    severity,
    message: d.message,
    startLineNumber: d.line,
    startColumn: 1,
    endLineNumber: d.line,
    endColumn: tab.model.getLineMaxColumn(Math.min(d.line, tab.model.getLineCount())),
  });
  monaco.editor.setModelMarkers(tab.model, MARKER_OWNER, [
    ...errors.map((d) => toMarker(d, monaco.MarkerSeverity.Error)),
    ...warnings.map((d) => toMarker(d, monaco.MarkerSeverity.Warning)),
  ]);
}

const formatDiagnostics = (label: string, list: Diagnostic[]) => list.map((d) => `${label} dòng ${d.line}: ${d.message}`);

/** IPC errors arrive wrapped by Electron; rethrow them with the server's own message. */
async function executeOnServer(sessionId: string, sql: string, maxRows: number): Promise<ExecuteResult> {
  try {
    return await window.db.execute(sessionId, sql, maxRows);
  } catch (e) {
    throw new Error(ipcErrorMessage(e));
  }
}

async function run(): Promise<void> {
  if (!connection || running) return;
  const tab = active;
  const selection = editor.getSelection();
  const useSelection = selection !== null && !selection.isEmpty();
  const source = useSelection ? tab.model.getValueInRange(selection) : tab.model.getValue();
  const lineOffset = useSelection ? selection.startLineNumber - 1 : 0;
  const shift = (list: Diagnostic[]) => list.map((d) => ({ ...d, line: d.line + lineOffset }));

  let outcome: QueryOutcome;
  try {
    outcome = await runFoxQuery(executeOnServer, tab, source, {
      maxRows: MAX_ROWS,
      resolveColumnKind,
      onExecute: () => {
        running = true;
        renderStatus();
      },
    });
  } finally {
    running = false;
  }

  const { conversion, result } = outcome;
  const errors = shift(conversion.errors);
  const warnings = shift(conversion.warnings);
  setMarkers(tab, errors, warnings);

  const lines = [...formatDiagnostics('Lỗi', errors), ...formatDiagnostics('Cảnh báo', warnings)];
  tab.activeSet = 0;
  tab.tsql = conversion.sql;
  tab.result = result;

  if (!result) {
    if (!errors.length) lines.push('Không có lệnh nào cần gửi lên máy chủ.');
    tab.pane = 'messages';
  } else {
    lines.push(...result.messages);
    if (result.error) {
      lines.push(`Lỗi máy chủ: ${result.error}`);
      if (result.sessionReset) lines.push('Phiên làm việc đã được mở lại sau lỗi, các cursor trước đó không còn.');
    } else {
      result.resultSets.forEach((set, i) => lines.push(`Bảng ${i + 1}: ${set.rows.length} dòng`));
      if (!result.resultSets.length) lines.push('Lệnh đã chạy xong, không trả về bảng kết quả.');
      if (result.truncated) lines.push(`Kết quả bị cắt ở ${MAX_ROWS} dòng. Hãy thêm điều kiện lọc.`);
    }
    lines.push(`Thời gian: ${seconds(result.elapsedMs)}`);
    tab.pane = result.error || !result.resultSets.length ? 'messages' : 'results';
  }

  tab.messages = lines.join('\n');
  if (tab === active) {
    renderOutput();
    explorer.setCursors(tab.cursors, tab.currentCursor);
  }
}

// ---------- Connection ----------

function loadSavedProfile(): Partial<ConnectionProfile> {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveProfile(profile: ConnectionProfile): void {
  // The password is never persisted.
  const { password: _password, ...rest } = profile;
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // Storage is a convenience only.
  }
}

function field(name: string): HTMLInputElement {
  return connectForm.elements.namedItem(name) as HTMLInputElement;
}

function openConnectDialog(): void {
  const saved = loadSavedProfile();
  field('server').value = saved.server ?? '';
  field('port').value = saved.port ? String(saved.port) : '';
  field('database').value = saved.database ?? '';
  field('user').value = saved.user ?? '';
  field('password').value = '';
  field('encrypt').checked = saved.encrypt ?? true;
  field('trust').checked = saved.trustServerCertificate ?? false;
  connectError.hidden = true;
  connectDialog.showModal();
}

/** A new or dropped connection closes every server session, so no cursor survives it. */
function forgetCursors(): void {
  for (const tab of tabs) {
    tab.cursors = [];
    tab.currentCursor = undefined;
  }
}

function applySchema(next: ExplorerConnection | undefined, tables: SchemaTable[]): void {
  connection = next;
  setSchema(tables);
  resolveColumnKind = columnKindResolver(tables);
  explorer.setConnection(next, tables);
  explorer.setCursors(active.cursors, active.currentCursor);
  renderStatus();
}

async function submitConnection(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const profile: ConnectionProfile = {
    server: field('server').value.trim(),
    port: field('port').value ? Number(field('port').value) : undefined,
    database: field('database').value.trim(),
    user: field('user').value.trim(),
    password: field('password').value,
    encrypt: field('encrypt').checked,
    trustServerCertificate: field('trust').checked,
  };
  connectSubmit.disabled = true;
  connectError.hidden = true;
  try {
    await window.db.connect(profile);
    const tables = await window.db.loadSchema();
    saveProfile(profile);
    forgetCursors();
    applySchema({ server: profile.server, user: profile.user, database: profile.database }, tables);
    connectDialog.close();
    editor.focus();
  } catch (e) {
    connectError.textContent = `Không kết nối được: ${ipcErrorMessage(e)}`;
    connectError.hidden = false;
  } finally {
    connectSubmit.disabled = false;
  }
}

async function disconnect(): Promise<void> {
  if (!connection) return;
  await window.db.disconnect();
  forgetCursors();
  applySchema(undefined, []);
}

async function refreshSchema(): Promise<void> {
  if (!connection) return;
  try {
    applySchema(connection, await window.db.loadSchema());
  } catch (e) {
    active.messages = `Không nạp lại được danh sách đối tượng: ${ipcErrorMessage(e)}`;
    active.pane = 'messages';
    renderOutput();
  }
}

// ---------- Updates ----------

const UPDATE_HINTS: Partial<Record<UpdateStatus['state'], string>> = {
  checking: 'Đang kiểm tra bản mới…',
  'not-available': 'Đang dùng bản mới nhất. Nhấn để kiểm tra lại.',
  idle: 'Nhấn để kiểm tra cập nhật.',
};

function renderUpdate(status: UpdateStatus): void {
  const label = updateActionLabel(status);
  updateButton.hidden = label === undefined;
  updateButton.textContent = label ?? '';
  updateButton.disabled = status.state === 'downloading';
  updateButton.dataset.state = status.state;

  versionButton.textContent = `v${status.currentVersion}`;
  versionButton.disabled = status.state === 'disabled' || status.state === 'checking' || status.state === 'downloading';
  versionButton.classList.toggle('failed', status.state === 'error');
  versionButton.title = status.state === 'error' ? `Không kiểm tra được bản mới: ${status.message}` : (status.message ?? UPDATE_HINTS[status.state] ?? '');
}

function onUpdateAction(): void {
  if (updateButton.dataset.state === 'available') void window.updates.download();
  else if (updateButton.dataset.state === 'downloaded') void window.updates.install();
}

// ---------- Commands ----------

function togglePanel(className: string, button: HTMLElement): void {
  const hidden = document.body.classList.toggle(className);
  button.setAttribute('aria-pressed', String(!hidden));
}

function showOutput(pane: PaneName): void {
  if (document.body.classList.contains('hide-output')) togglePanel('hide-output', el('btn-toggle-output'));
  showPane(pane);
}

/** One handler per command, shared by the menu, the toolbar and the keyboard. */
const HANDLERS: Record<AppCommand, () => void> = {
  'file.new': () => newTab(),
  'file.open': () => void openFile(),
  'file.save': () => void saveFile(false),
  'file.saveAs': () => void saveFile(true),
  'file.closeTab': () => closeTab(active),
  'connection.connect': openConnectDialog,
  'connection.disconnect': () => void disconnect(),
  'connection.refresh': () => void refreshSchema(),
  'query.run': () => void run(),
  'view.explorer': () => togglePanel('hide-explorer', el('btn-toggle-explorer')),
  'view.output': () => togglePanel('hide-output', el('btn-toggle-output')),
  'view.results': () => showOutput('results'),
  'view.messages': () => showOutput('messages'),
  'view.tsql': () => showOutput('tsql'),
  'help.checkUpdates': () => void window.updates.check(),
  'help.about': () => void window.app.about(),
};

// ---------- Splitters ----------

function dragSplitter(handle: HTMLElement, onMove: (e: PointerEvent) => void): void {
  handle.addEventListener('pointerdown', (down) => {
    handle.setPointerCapture(down.pointerId);
    const stop = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', stop);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', stop);
  });
}

// ---------- Wiring ----------

document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
  button.addEventListener('click', () => HANDLERS[button.dataset.command as AppCommand]());
});
window.app.onCommand((command) => HANDLERS[command]());

// Captured before the editor sees the key, so a shortcut never also types or runs twice.
window.addEventListener(
  'keydown',
  (event) => {
    const command = commandForShortcut(shortcutOf(event));
    if (!command || connectDialog.open) return;
    event.preventDefault();
    event.stopPropagation();
    HANDLERS[command]();
  },
  true,
);

el('connect-cancel').addEventListener('click', () => connectDialog.close());
connectForm.addEventListener('submit', (e) => void submitConnection(e));
explorerFilter.addEventListener('input', () => explorer.setFilter(explorerFilter.value));
editor.onDidChangeCursorPosition(renderStatus);

document.querySelectorAll<HTMLButtonElement>('.output-tabs > button').forEach((button) => {
  button.addEventListener('click', () => showPane(button.dataset.pane as PaneName));
});

dragSplitter(el('split-explorer'), (e) => {
  const width = Math.max(MIN_EXPLORER_WIDTH, Math.min(e.clientX, window.innerWidth / 2));
  document.documentElement.style.setProperty('--explorer-width', `${width}px`);
});
dragSplitter(el('split-output'), (e) => {
  const statusHeight = statusBar.offsetHeight;
  const height = Math.max(MIN_OUTPUT_HEIGHT, Math.min(window.innerHeight - statusHeight - e.clientY, window.innerHeight - 200));
  document.documentElement.style.setProperty('--output-height', `${height}px`);
});

updateButton.addEventListener('click', onUpdateAction);
versionButton.addEventListener('click', () => void window.updates.check());
window.updates.onStatus(renderUpdate);
void window.updates.getStatus().then(renderUpdate);

newTab();
