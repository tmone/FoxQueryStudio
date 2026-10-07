import './style.css';
import { convertFoxPro, type Diagnostic } from '../../converter';
import { convertTsql } from '../../converter/reverse';
import { columnKindResolver, columnWidthResolver } from '../../shared/column-kind';
import type { ColumnKindResolver } from '../../converter';
import { commandForShortcut, shortcutOf, type AppCommand } from '../../shared/commands';
import { runFoxQuery, runOnFoxPro, runTsqlQuery } from '../../shared/run-query';
import type { ConnectionInfo, ConnectionProfile, ExecuteResult, SchemaTable } from '../../shared/types';
import { updateActionLabel, type UpdateStatus } from '../../shared/update';
import { createCompareEditor, createEditor, createModel, LANGUAGE_ID, monaco, qualifiedName, setSchema, TSQL_LANGUAGE_ID } from './editor';
import type { Registration } from '../../shared/registry';
import { connectionLabel, createExplorer, registrationLabel, type ExplorerConnection } from './explorer';
import { renderGrid } from './grid';

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 100;
/** The app's own signal that a remembered SQL connection has no stored password. */
const NEEDS_PASSWORD = 'NEEDS_PASSWORD';
const MARKER_OWNER = 'foxpro';
const MIN_EXPLORER_WIDTH = 160;
const MIN_OUTPUT_HEIGHT = 80;
const COMPARE_DELAY_MS = 250;

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
  /** The connection the tab runs on; unset until one is chosen. */
  connectionId?: string;
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

/** An open connection with the objects loaded from it and the column lookups the converters need. */
interface Connection extends ExplorerConnection {
  resolveColumnKind: ColumnKindResolver;
  resolveColumnWidth: ReturnType<typeof columnWidthResolver>;
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
const connections: Connection[] = [];
/** Every remembered connection, open or not; the explorer shows them all. */
let registrations: Registration[] = [];
/** The connection new tabs are bound to. */
let currentConnectionId: string | undefined;
let running = false;
const NO_CONNECTION: Pick<Connection, 'tables' | 'resolveColumnKind' | 'resolveColumnWidth'> = { tables: [], resolveColumnKind: columnKindResolver([]), resolveColumnWidth: columnWidthResolver([]) };

const findConnection = (id: string | undefined) => connections.find((c) => c.id === id);
/** The connection of a tab, if it is still open. */
const connectionOf = (tab: Tab) => findConnection(tab.connectionId);
const lookups = (tab: Tab) => connectionOf(tab) ?? NO_CONNECTION;

const insertIntoEditor = (text: string) => {
  editor.trigger('explorer', 'type', { text });
  editor.focus();
};

const explorer = createExplorer(el('explorer-tree'), {
  insertText: insertIntoEditor,
  selectTop: (connectionId, table) => {
    newTab(`SELECT TOP ${PREVIEW_ROWS} * FROM ${qualifiedName(table)} ORDER BY 1`, undefined, undefined, connectionId);
    void run();
  },
  connect: (registrationId) => void connectSaved(registrationId),
  remove: (registrationId) => void removeRegistration(registrationId),
  select: selectConnection,
  useForActiveTab: (connectionId) => bindTab(active, connectionId),
  refresh: (connectionId) => void refreshSchema(connectionId),
  disconnect: (connectionId) => void disconnect(connectionId),
});

// ---------- Status bar ----------

function renderStatus(): void {
  const connection = connectionOf(active);
  statusBar.classList.toggle('connected', connection !== undefined);
  statusState.textContent = connection ? 'Đã kết nối' : 'Chưa kết nối';
  connectionStatus.textContent = !connection ? '' : connection.kind === 'foxpro' ? `FoxPro: ${connection.localPath}` : `${connection.user} @ ${connection.server} / ${connection.database}`;
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
  disconnectButton.title = connection ? `Ngắt ${connectionLabel(connection)}` : 'Ngắt kết nối';
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
  setSchema(lookups(tab).tables);
  explorer.setCursors(tab.connectionId, tab.cursors, tab.currentCursor);
}

const languageOfFile = (path: string): QueryLanguage => (path.toLowerCase().endsWith(LANGUAGES.tsql.extension) ? 'tsql' : 'foxpro');

/** A new query starts in the language of the tab it was opened from. */
function newTab(text = '', filePath?: string, language: QueryLanguage = filePath ? languageOfFile(filePath) : (active?.language ?? 'foxpro'), connectionId = currentConnectionId): void {
  tabCounter++;
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: filePath ? fileName(filePath) : `Truy vấn ${tabCounter}`,
    filePath,
    language,
    connectionId,
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
  if (tab.connectionId) void window.db.closeSession(tab.connectionId, tab.id);
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

/** Runs on one connection; IPC errors arrive wrapped by Electron and are rethrown with the server's own message. */
const executeOn =
  (connectionId: string) =>
  async (sessionId: string, sql: string, maxRows: number): Promise<ExecuteResult> => {
    try {
      return await window.db.execute(connectionId, sessionId, sql, maxRows);
    } catch (e) {
      throw new Error(ipcErrorMessage(e));
    }
  };

async function run(): Promise<void> {
  const tab = active;
  const connection = connectionOf(tab);
  if (!connection || running) return;
  const { resolveColumnKind, resolveColumnWidth } = connection;
  const executeOnServer = executeOn(connection.id);
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
    if (connection.kind === 'foxpro') {
      // On a FoxPro database FoxPro is the engine: T-SQL has to translate before it can run.
      const outcome = await runOnFoxPro(executeOnServer, tab, source, tab.language, { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth, onExecute });
      result = outcome.result;
      errors = shift(outcome.errors);
      warnings = shift(outcome.warnings);
      tab.translation = outcome.translation;
      const other = LANGUAGES[LANGUAGES[tab.language].other].name;
      lines.push(...formatDiagnostics(`Không chạy được vì chưa chuyển được sang ${other},`, errors), ...formatDiagnostics(`Lưu ý khi dịch sang ${other},`, warnings));
    } else if (tab.language === 'foxpro') {
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
      lines.push(`Lỗi từ ${connection.kind === 'foxpro' ? 'FoxPro' : 'máy chủ'}: ${result.error}`);
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
    explorer.setCursors(tab.connectionId, tab.cursors, tab.currentCursor);
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
  const { resolveColumnKind, resolveColumnWidth } = lookups(tab);
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

function field(name: string): HTMLInputElement {
  return connectForm.elements.namedItem(name) as HTMLInputElement;
}

const savedSelect = el<HTMLSelectElement>('saved-connections');
const sqlRegistrations = () => registrations.filter((r): r is Registration & { kind: 'sql' } => r.kind === 'sql');

/** Fills the form from a remembered connection; a stored password need not be typed again. */
function fillConnectForm(saved: (Registration & { kind: 'sql' }) | undefined): void {
  const profile = saved?.profile;
  field('server').value = profile?.server ?? '';
  field('port').value = profile?.port ? String(profile.port) : '';
  field('database').value = profile?.database ?? '';
  field('user').value = profile?.user ?? '';
  field('password').value = '';
  field('password').placeholder = saved?.hasPassword ? '(đã lưu, để trống để dùng lại)' : '';
  field('password').required = !saved?.hasPassword;
  field('encrypt').checked = profile?.encrypt ?? true;
  field('trust').checked = profile?.trustServerCertificate ?? false;
  field('remember').checked = saved?.hasPassword ?? false;
}

function openConnectDialog(registrationId?: string): void {
  const saved = sqlRegistrations();
  savedSelect.replaceChildren(
    new Option('(mới)', ''),
    ...saved.map((r) => new Option(`${registrationLabel(r)} / ${r.profile.database}`, r.id)),
  );
  const chosen = saved.find((r) => r.id === registrationId) ?? saved[saved.length - 1];
  savedSelect.value = chosen?.id ?? '';
  fillConnectForm(chosen);
  connectError.hidden = true;
  connectDialog.showModal();
}

async function loadRegistrations(): Promise<void> {
  registrations = await window.registry.list();
  renderExplorer();
}

/** Makes the connection the one new tabs use; the first connection also takes the tabs opened before it. */
function selectConnection(connectionId: string): void {
  currentConnectionId = connectionId;
  for (const tab of tabs) {
    if (!tab.connectionId) tab.connectionId = connectionId;
  }
  renderExplorer();
  renderStatus();
}

/** Moves a tab onto another connection; its cursors stay behind with the old session. */
function bindTab(tab: Tab, connectionId: string): void {
  if (tab.connectionId === connectionId) return;
  if (tab.connectionId) void window.db.closeSession(tab.connectionId, tab.id);
  tab.connectionId = connectionId;
  tab.cursors = [];
  tab.currentCursor = undefined;
  currentConnectionId = connectionId;
  if (tab === active) activate(tab);
  renderExplorer();
}

function renderExplorer(): void {
  explorer.setEntries(
    registrations.map((registration) => ({ registration, connection: findConnection(registration.id) })),
    currentConnectionId,
  );
  explorer.setCursors(active.connectionId, active.cursors, active.currentCursor);
}

function withSchema(info: ConnectionInfo, tables: SchemaTable[]): Connection {
  return { ...info, tables, resolveColumnKind: columnKindResolver(tables), resolveColumnWidth: columnWidthResolver(tables) };
}

/** Adds (or replaces) a connection with its objects and makes it current. */
function addConnection(info: ConnectionInfo, tables: SchemaTable[]): void {
  const index = connections.findIndex((c) => c.id === info.id);
  const connection = withSchema(info, tables);
  if (index < 0) connections.push(connection);
  else connections[index] = connection;
  selectConnection(info.id);
  setSchema(lookups(active).tables);
  renderCompare();
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
  const saved = sqlRegistrations().find((r) => r.id === savedSelect.value);
  connectSubmit.disabled = true;
  connectError.hidden = true;
  try {
    // An empty password means "the one stored with the remembered connection".
    const info = !profile.password && saved?.hasPassword ? await window.db.connectSaved(saved.id) : await window.db.connect(profile, field('remember').checked);
    const tables = await window.db.loadSchema(info.id);
    await loadRegistrations();
    addConnection(info, tables);
    connectDialog.close();
    editor.focus();
  } catch (e) {
    connectError.textContent = `Không kết nối được: ${ipcErrorMessage(e)}`;
    connectError.hidden = false;
  } finally {
    connectSubmit.disabled = false;
  }
}

function report(tab: Tab, message: string): void {
  tab.messages = message;
  tab.pane = 'messages';
  tab.hasOutput = true;
  if (tab === active) renderOutput();
}

/** Opens a FoxPro database file as a connection of its own, run by FoxPro itself. */
async function openFoxPro(): Promise<void> {
  if (running) return;
  const tab = active;
  running = true;
  renderStatus();
  try {
    const info = await window.db.openFoxPro();
    if (!info) return;
    const tables = await window.db.loadSchema(info.id);
    await loadRegistrations();
    addConnection(info, tables);
    report(tab, `Đã mở ${info.localPath}: ${tables.length} bảng. Truy vấn chạy bằng chính FoxPro; T-SQL được chuyển sang FoxPro trước khi chạy.`);
  } catch (e) {
    report(tab, `Không mở được CSDL FoxPro: ${ipcErrorMessage(e)}`);
  } finally {
    running = false;
    renderStatus();
  }
}

/** Reopens a remembered connection; a SQL one without a stored password asks for it. */
async function connectSaved(registrationId: string): Promise<void> {
  if (running) return;
  const tab = active;
  running = true;
  renderStatus();
  try {
    const info = await window.db.connectSaved(registrationId);
    const tables = await window.db.loadSchema(info.id);
    await loadRegistrations();
    addConnection(info, tables);
  } catch (e) {
    const message = ipcErrorMessage(e);
    if (message.includes(NEEDS_PASSWORD)) openConnectDialog(registrationId);
    else report(tab, `Không kết nối được: ${message}`);
  } finally {
    running = false;
    renderStatus();
  }
}

async function removeRegistration(registrationId: string): Promise<void> {
  await disconnect(registrationId);
  await window.registry.remove(registrationId);
  await loadRegistrations();
}

async function chooseVfpPath(): Promise<void> {
  const chosen = await window.app.chooseVfpPath();
  if (chosen) report(active, `Visual FoxPro 9: ${chosen}`);
}

/** Closes a connection; tabs that ran on it keep their text and wait for another one. */
async function disconnect(connectionId: string | undefined = active.connectionId): Promise<void> {
  const index = connections.findIndex((c) => c.id === connectionId);
  if (index < 0) return;
  connections.splice(index, 1);
  await window.db.disconnect(connectionId!).catch(() => undefined);
  for (const tab of tabs) {
    if (tab.connectionId !== connectionId) continue;
    tab.connectionId = undefined;
    tab.cursors = [];
    tab.currentCursor = undefined;
  }
  if (currentConnectionId === connectionId) currentConnectionId = connections[connections.length - 1]?.id;
  renderExplorer();
  setSchema(lookups(active).tables);
  renderCompare();
  renderStatus();
}

async function refreshSchema(connectionId: string | undefined = active.connectionId): Promise<void> {
  const connection = findConnection(connectionId);
  if (!connection) return;
  try {
    const tables = await window.db.loadSchema(connection.id);
    Object.assign(connection, withSchema(connection, tables));
    renderExplorer();
    setSchema(lookups(active).tables);
  } catch (e) {
    report(active, `Không nạp lại được danh sách đối tượng: ${ipcErrorMessage(e)}`);
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
  'connection.connect': () => openConnectDialog(),
  'connection.disconnect': () => void disconnect(),
  'connection.refresh': () => void refreshSchema(),
  'local.vfpPath': () => void chooseVfpPath(),
  'local.open': () => void openFoxPro(),
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

savedSelect.addEventListener('change', () => fillConnectForm(sqlRegistrations().find((r) => r.id === savedSelect.value)));
newTab();
void loadRegistrations();
