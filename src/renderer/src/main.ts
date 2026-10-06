import './style.css';
import { convertFoxPro, type Diagnostic } from '../../converter';
import { convertTsql } from '../../converter/reverse';
import { columnKindResolver, columnWidthResolver } from '../../shared/column-kind';
import { commandForShortcut, shortcutOf, type AppCommand } from '../../shared/commands';
import { runFoxQuery, runTsqlQuery } from '../../shared/run-query';
import type { ConnectionProfile, ExecuteResult, SchemaTable } from '../../shared/types';
import { updateActionLabel, type UpdateStatus } from '../../shared/update';
import { createCompareEditor, createEditor, createModel, LANGUAGE_ID, monaco, qualifiedName, setSchema, TSQL_LANGUAGE_ID } from './editor';
import { createExplorer, type ExplorerConnection } from './explorer';
import { renderGrid } from './grid';

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 100;
const PROFILE_STORAGE_KEY = 'fqs.profile';
const MARKER_OWNER = 'foxpro';
const MIN_EXPLORER_WIDTH = 160;
const MIN_OUTPUT_HEIGHT = 80;
const COMPARE_DELAY_MS = 250;
const LOCAL_SERVER = 'FoxPro cục bộ';

/** The language a tab is written in; the other one is always derived from it. */
type QueryLanguage = 'foxpro' | 'tsql';

const LANGUAGES: Record<QueryLanguage, { label: string; name: string; monacoId: string; extension: string; other: QueryLanguage }> = {
  foxpro: { label: 'FOX-SQL', name: 'FoxPro', monacoId: LANGUAGE_ID, extension: '.prg', other: 'tsql' },
  tsql: { label: 'T-SQL', name: 'T-SQL', monacoId: TSQL_LANGUAGE_ID, extension: '.sql', other: 'foxpro' },
};

type PaneName = 'results' | 'messages' | 'tsql';

interface Tab {
  id: string;
  title: string;
  /** File the tab was opened from or saved to. */
  filePath?: string;
  language: QueryLanguage;
  model: monaco.editor.ITextModel;
  cursors: string[];
  currentCursor?: string;
  result?: ExecuteResult;
  messages: string;
  /** The last run's source in the other language. */
  translation: string;
  activeSet: number;
  pane: PaneName;
  /** False until the tab has something to show below the editor; the pane stays closed meanwhile. */
  hasOutput: boolean;
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
const queryStatus = el('query-status');
const queryState = el('query-state');
const statusState = el('status-state');
const connectionStatus = el('connection-status');
const statusCursor = el('status-cursor');
const statusRows = el('status-rows');
const runStatus = el('run-status');
const statusPosition = el('status-position');
const updateButton = el<HTMLButtonElement>('btn-update');
const versionButton = el<HTMLButtonElement>('app-version');
const statusLanguage = el('status-language');
const languageButtons = [...document.querySelectorAll<HTMLButtonElement>('.language-switch button')];
const sourceTitle = el('source-title');
const translationTab = el<HTMLButtonElement>('tab-translation');
const compareTitle = el('compare-title');

const editor = createEditor(el('editor'));
const compareEditor = createCompareEditor(el('compare-editor'));
const tabs: Tab[] = [];
let active: Tab;
let tabCounter = 0;
let connection: ExplorerConnection | undefined;
let running = false;
let resolveColumnKind = columnKindResolver([]);
let resolveColumnWidth = columnWidthResolver([]);

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
  connectionStatus.textContent = !connection ? '' : connection.localPath ? `FoxPro cục bộ: ${connection.localPath}` : `${connection.user} @ ${connection.server} / ${connection.database}`;
  statusCursor.textContent = active.currentCursor ? `Cursor: ${active.currentCursor}` : '';

  const result = active.result;
  const current = result?.resultSets[active.activeSet];
  statusRows.textContent = current ? `${current.rows.length} dòng${result!.truncated ? ' (đã cắt)' : ''}` : '';
  runStatus.textContent = running ? 'Đang chạy…' : result ? (result.error ? 'Lỗi' : seconds(result.elapsedMs)) : '';
  queryState.textContent = running ? 'Đang chạy truy vấn…' : !result ? 'Chưa chạy truy vấn' : result.error ? 'Truy vấn có lỗi' : 'Truy vấn chạy xong';
  queryStatus.classList.toggle('failed', !running && result?.error !== undefined);

  const position = editor.getPosition();
  statusPosition.textContent = position ? `Dòng ${position.lineNumber}, Cột ${position.column}` : '';
  statusLanguage.textContent = LANGUAGES[active.language].label;
  for (const button of languageButtons) button.setAttribute('aria-pressed', String(button.dataset.language === active.language));

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
  renderCompare();
  explorer.setCursors(tab.cursors, tab.currentCursor);
}

const languageOfFile = (path: string): QueryLanguage => (path.toLowerCase().endsWith(LANGUAGES.tsql.extension) ? 'tsql' : 'foxpro');

/** A new query starts in the language of the tab it was opened from. */
function newTab(text = '', filePath?: string, language: QueryLanguage = filePath ? languageOfFile(filePath) : (active?.language ?? 'foxpro')): void {
  tabCounter++;
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: filePath ? fileName(filePath) : `Truy vấn ${tabCounter}`,
    filePath,
    language,
    model: createModel(text, LANGUAGES[language].monacoId),
    cursors: [],
    messages: '',
    translation: '',
    activeSet: 0,
    pane: 'results',
    hasOutput: false,
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
  const path = await window.app.saveFile(askForPath ? undefined : tab.filePath, tab.model.getValue(), tab.filePath ?? `${tab.title}${LANGUAGES[tab.language].extension}`);
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
  document.body.classList.toggle('empty-output', !active.hasOutput);
  panes.messages.textContent = active.messages;
  panes.tsql.textContent = active.translation;
  translationTab.textContent = `${LANGUAGES[LANGUAGES[active.language].other].name} đã dịch`;

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

  const onExecute = () => {
    running = true;
    renderStatus();
  };

  let result: ExecuteResult | undefined;
  let errors: Diagnostic[] = [];
  let warnings: Diagnostic[];
  const lines: string[] = [];
  try {
    if (tab.language === 'foxpro') {
      const outcome = await runFoxQuery(executeOnServer, tab, source, { maxRows: MAX_ROWS, resolveColumnKind, onExecute });
      result = outcome.result;
      errors = shift(outcome.conversion.errors);
      warnings = shift(outcome.conversion.warnings);
      tab.translation = outcome.conversion.sql;
      lines.push(...formatDiagnostics('Lỗi', errors), ...formatDiagnostics('Cảnh báo', warnings));
    } else {
      // T-SQL runs as written; what FoxPro cannot express only limits the translation.
      const outcome = await runTsqlQuery(executeOnServer, tab, source, { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth, onExecute });
      result = outcome.result;
      warnings = shift([...outcome.conversion.errors, ...outcome.conversion.warnings]);
      tab.translation = outcome.conversion.foxpro;
      lines.push(...formatDiagnostics('Chưa dịch được sang FoxPro,', shift(outcome.conversion.errors)), ...formatDiagnostics('Cảnh báo', shift(outcome.conversion.warnings)));
    }
  } finally {
    running = false;
  }
  setMarkers(tab, errors, warnings);

  tab.activeSet = 0;
  tab.result = result;
  tab.hasOutput = true;

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
    renderCompare();
    explorer.setCursors(tab.cursors, tab.currentCursor);
  }
}

// ---------- Translation ----------

interface Translation {
  text: string;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** The tab's source in the other language, without running anything. */
function translate(tab: Tab, source: string): Translation {
  if (tab.language === 'foxpro') {
    const { sql, errors, warnings } = convertFoxPro(source, { knownCursors: tab.cursors, currentCursor: tab.currentCursor, resolveColumnKind });
    return { text: sql, errors, warnings };
  }
  const { foxpro, errors, warnings } = convertTsql(source, { resolveColumnKind, resolveColumnWidth });
  return { text: foxpro, errors, warnings };
}

const compareShown = () => document.body.classList.contains('show-compare');

/** Fills the compare column with the live translation of the active tab. */
function renderCompare(): void {
  if (!compareShown()) return;
  const source = LANGUAGES[active.language];
  const target = LANGUAGES[source.other];
  const { text, errors } = translate(active, active.model.getValue());
  sourceTitle.textContent = `${source.label} · đang soạn`;
  compareTitle.textContent = `${target.label} · ${errors.length ? 'chưa dịch được' : 'bản dịch, chỉ đọc'}`;
  monaco.editor.setModelLanguage(compareEditor.getModel()!, target.monacoId);
  compareEditor.setValue(errors.length ? formatDiagnostics('Lỗi', errors).join('\n') : text);
}

let compareTimer: number | undefined;
function scheduleCompare(): void {
  window.clearTimeout(compareTimer);
  compareTimer = window.setTimeout(renderCompare, COMPARE_DELAY_MS);
}

function toggleCompare(): void {
  const shown = document.body.classList.toggle('show-compare');
  el('btn-toggle-compare').setAttribute('aria-pressed', String(shown));
  renderCompare();
}

/**
 * Rewrites the tab in the other language. A tab that does not translate keeps its text and
 * its language, so the label never disagrees with the content.
 */
function switchLanguage(): void {
  const tab = active;
  const target = LANGUAGES[tab.language].other;
  const source = tab.model.getValue();
  if (source.trim()) {
    const { text, errors, warnings } = translate(tab, source);
    setMarkers(tab, errors, warnings);
    if (errors.length) {
      tab.messages = [`Chưa đổi sang ${LANGUAGES[target].label} được, nội dung giữ nguyên:`, ...formatDiagnostics('Lỗi', errors)].join('\n');
      tab.hasOutput = true;
      tab.pane = 'messages';
      renderOutput();
      editor.focus();
      return;
    }
    // One undoable edit, so Ctrl+Z brings the original text back.
    tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text }], () => null);
    tab.model.pushStackElement();
  }
  tab.language = target;
  monaco.editor.setModelLanguage(tab.model, LANGUAGES[target].monacoId);
  monaco.editor.setModelMarkers(tab.model, MARKER_OWNER, []);
  renderOutput();
  renderCompare();
  editor.focus();
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
  resolveColumnWidth = columnWidthResolver(tables);
  renderCompare();
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

/** Opens a folder of .dbf files in the app's own engine; from then on it is the connection. */
async function openLocal(): Promise<void> {
  if (running) return;
  const tab = active;
  const report = (message: string) => {
    tab.messages = message;
    tab.pane = 'messages';
    tab.hasOutput = true;
    if (tab === active) renderOutput();
  };
  running = true;
  renderStatus();
  try {
    const opened = await window.localDb.open();
    if (!opened) return;
    const tables = await window.db.loadSchema();
    forgetCursors();
    applySchema({ server: LOCAL_SERVER, user: '', database: opened.name, localPath: opened.path }, tables);
    report([`Đã mở ${opened.path}: ${opened.tableCount} bảng, ${opened.rowCount} dòng.`, ...opened.notes.map((note) => `Lưu ý: ${note}`)].join('\n'));
  } catch (e) {
    report(`Không mở được CSDL FoxPro: ${ipcErrorMessage(e)}`);
  } finally {
    running = false;
    renderStatus();
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
    active.hasOutput = true;
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

const HIDE_OUTPUT = 'hide-output';

/** Opens the pane below the editor on the given tab, even for a query that has not run yet. */
function showOutput(pane: PaneName): void {
  document.body.classList.remove(HIDE_OUTPUT);
  active.hasOutput = true;
  active.pane = pane;
  renderOutput();
}

function toggleOutput(): void {
  if (active.hasOutput) document.body.classList.toggle(HIDE_OUTPUT);
  else showOutput(active.pane);
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
  'local.open': () => void openLocal(),
  'query.run': () => void run(),
  'query.switchLanguage': switchLanguage,
  'view.compare': toggleCompare,
  'view.explorer': () => document.body.classList.toggle('hide-explorer'),
  'view.output': toggleOutput,
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
for (const button of languageButtons) {
  button.addEventListener('click', () => button.dataset.language !== active.language && switchLanguage());
}
editor.onDidChangeCursorPosition(renderStatus);
editor.onDidChangeModelContent(scheduleCompare);

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
