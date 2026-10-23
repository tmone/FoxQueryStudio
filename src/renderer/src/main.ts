import './style.css';
import { convertFoxPro, type Diagnostic } from '../../converter';
import { convertTsql } from '../../converter/reverse';
import { columnKindResolver, columnWidthResolver } from '../../shared/column-kind';
import type { ColumnKindResolver } from '../../converter';
import { commandForShortcut, shortcutOf, type AppCommand } from '../../shared/commands';
import { runFoxQuery, runOnFoxPro, runTsqlQuery } from '../../shared/run-query';
import { isProcedure, type ConnectionInfo, type ConnectionProfile, type ExecuteResult, type SchemaTable } from '../../shared/types';
import { updateActionLabel, type UpdateStatus } from '../../shared/update';
import { queryTitle } from '../../shared/journal';
import { findParameters, prepareFoxBatch } from '../../shared/fox-prepare';
import { cursorNameFor, execStatement, execTemplate } from '../../shared/procedures';
import { createCompareEditor, createEditor, createModel, displayName, LANGUAGE_ID, monaco, qualifiedName, setSchema, TSQL_LANGUAGE_ID } from './editor';
import type { Registration } from '../../shared/registry';
import { connectionLabel, createExplorer, registrationLabel, type ExplorerConnection } from './explorer';
import { renderGrids } from './grid';
import { createJournal } from './journal';
import type { Bookmark } from '../../shared/journal';

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
  /** The connection and database the tab runs on; unset until one is chosen. */
  connectionId?: string;
  database?: string;
  model: monaco.editor.ITextModel;
  cursors: string[];
  currentCursor?: string;
  currentTable?: string;
  result?: ExecuteResult;
  messages: string;
  /** The last run's source in the other language. */
  translation: string;
  activeSet: number;
  pane: PaneName;
  /** False until the tab has something to show below the editor; the pane stays closed meanwhile. */
  hasOutput: boolean;
  /** True while the tab's query is on its way; other tabs are free to run meanwhile. */
  running: boolean;
  /** Parameter values the bookmark that opened the tab carries; they are used without asking. */
  params?: Record<string, string>;
  /** The procedure whose result is the tab's cursor, kept so a bookmark saved from it can rebuild that cursor. */
  procedure?: string;
}

/** The objects of one database and the column lookups the converters need for it. */
interface Lookups {
  tables: SchemaTable[];
  resolveColumnKind: ColumnKindResolver;
  resolveColumnWidth: ReturnType<typeof columnWidthResolver>;
}

/** An open connection: its databases, with lookups for those whose objects were loaded. */
interface Connection extends ExplorerConnection {
  lookups: Record<string, Lookups>;
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
const statusConnection = el('status-connection');
const statusCursor = el('status-cursor');
const statusRows = el('status-rows');
const runStatus = el('run-status');
const statusPosition = el('status-position');
const updateButton = el<HTMLButtonElement>('btn-update');
const updateLabel = el('btn-update-label');
const versionButton = el<HTMLButtonElement>('app-version');
const statusLanguage = el('status-language');
const languageButtons = [...document.querySelectorAll<HTMLButtonElement>('.language-switch button')];
const sourceTitle = el('source-title');
const translationTab = el<HTMLButtonElement>('tab-translation');
const exportButton = el<HTMLButtonElement>('btn-export');
const compareTitle = el('compare-title');
const sideButtons = [...document.querySelectorAll<HTMLButtonElement>('.side-tabs > button')];
const bookmarkDialog = el<HTMLDialogElement>('bookmark-dialog');
const bookmarkForm = el<HTMLFormElement>('bookmark-form');
const bookmarkPreview = el('bookmark-preview');
const bookmarkTitle = el('bookmark-title');
const paramDialog = el<HTMLDialogElement>('param-dialog');
const paramForm = el<HTMLFormElement>('param-form');
const paramName = el('param-name');
/** Values given to parameters (lower-cased name → value), offered again at the next run and kept across starts. */
const PARAMETER_STORE = 'fqs.parameters';
const parameterValues = new Map<string, string>(loadParameterValues());

function loadParameterValues(): [string, string][] {
  try {
    return Object.entries(JSON.parse(localStorage.getItem(PARAMETER_STORE) ?? '{}') as Record<string, string>);
  } catch {
    return [];
  }
}

function rememberParameter(name: string, value: string): void {
  parameterValues.set(name.toLowerCase(), value);
  try {
    localStorage.setItem(PARAMETER_STORE, JSON.stringify(Object.fromEntries(parameterValues)));
  } catch {
    // Browser storage can be unavailable; the value still holds for this run of the program.
  }
}

/** The three lists of the side pane. */
type SideName = 'objects' | 'history' | 'bookmarks';

const editor = createEditor(el('editor'));
const compareEditor = createCompareEditor(el('compare-editor'));
const tabs: Tab[] = [];
let active: Tab;
let tabCounter = 0;
const connections: Connection[] = [];
/** Every remembered connection, open or not; the explorer shows them all. */
let registrations: Registration[] = [];
/** The connection and database new tabs are bound to. */
let currentConnectionId: string | undefined;
let currentDatabase: string | undefined;
/** True while a connection is being opened; that is the only thing that waits on the whole window. */
let connecting = false;
const NO_LOOKUPS: Lookups = { tables: [], resolveColumnKind: columnKindResolver([]), resolveColumnWidth: columnWidthResolver([]) };

const findConnection = (id: string | undefined) => connections.find((c) => c.id === id);
/** The connection of a tab, if it is still open. */
const connectionOf = (tab: Tab) => findConnection(tab.connectionId);
const lookups = (tab: Tab) => connectionOf(tab)?.lookups[tab.database ?? ''] ?? NO_LOOKUPS;
const tabDatabaseSelect = el<HTMLSelectElement>('tab-database');

const insertIntoEditor = (text: string) => {
  editor.trigger('explorer', 'type', { text });
  editor.focus();
};

const explorer = createExplorer(el('explorer-tree'), {
  insertText: insertIntoEditor,
  selectTop: (connectionId, database, table) => {
    newTab(`SELECT TOP ${PREVIEW_ROWS} * FROM ${qualifiedName(table)} ORDER BY 1`, undefined, undefined, connectionId, database);
    void run();
  },
  useTable: (connectionId, database, table) => void useTable(connectionId, database, table),
  runProcedure: (connectionId, database, procedure) => {
    newTab(execTemplate(qualifiedName(procedure), procedure.parameters ?? [], 'kq'), undefined, 'tsql', connectionId, database);
  },
  useProcedure: (connectionId, database, procedure) => void useProcedure(connectionId, database, procedure),
  loadDatabase: (connectionId, database) => void loadDatabase(connectionId, database),
  connect: (registrationId) => void connectSaved(registrationId),
  remove: (registrationId) => void removeRegistration(registrationId),
  select: selectConnection,
  useForActiveTab: (connectionId) => bindTab(active, connectionId, currentConnectionId === connectionId ? currentDatabase : undefined),
  refresh: (connectionId) => void refreshSchema(connectionId),
  disconnect: (connectionId) => void disconnect(connectionId),
});

// ---------- Status bar ----------

function renderStatus(): void {
  const connection = connectionOf(active);
  // The app bar speaks for the whole window; the tab's own connection is on the strip under the editor.
  statusBar.classList.toggle('connected', connections.length > 0);
  statusState.textContent = connections.length ? `${connections.length} kết nối đang mở` : 'Chưa có kết nối';
  statusConnection.textContent = !connection ? 'Tab chưa gắn kết nối' : connection.kind === 'foxpro' ? `FoxPro: ${connection.localPath}` : `${connection.user} @ ${connection.server} / ${active.database ?? ''}`;
  renderDatabaseSelect(connection);
  statusCursor.textContent = active.currentCursor ? `Cursor: ${active.currentCursor}` : active.currentTable ? `Bảng: ${active.currentTable}` : '';
  statusCursor.title = active.currentTable ? 'Bảng làm việc của tab: SUM, COUNT, AVERAGE, CALCULATE, BROWSE chạy trên bảng này khi không nêu tên' : 'Cursor đang chọn của tab';

  const result = active.result;
  const total = result ? result.resultSets.reduce((n, set) => n + set.rows.length, 0) : 0;
  statusRows.textContent = result && result.resultSets.length ? `${total} dòng${result.resultSets.length > 1 ? ` / ${result.resultSets.length} bảng` : ''}${result.truncated ? ' (đã cắt)' : ''}` : '';
  const running = active.running;
  runStatus.textContent = running ? 'Đang chạy…' : result ? (result.error ? 'Lỗi' : seconds(result.elapsedMs)) : '';
  queryState.textContent = running ? 'Đang chạy truy vấn…' : !result ? 'Chưa chạy truy vấn' : result.error ? 'Truy vấn có lỗi' : 'Truy vấn chạy xong';
  queryStatus.classList.toggle('failed', !running && result?.error !== undefined);

  const position = editor.getPosition();
  statusPosition.textContent = position ? `Dòng ${position.lineNumber}, Cột ${position.column}` : '';
  statusLanguage.textContent = LANGUAGES[active.language].label;
  for (const button of languageButtons) button.setAttribute('aria-pressed', String(button.dataset.language === active.language));

  runButton.disabled = !connection || running || connecting;
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
  explorer.setCursors(tab.connectionId, tab.database, tab.cursors, tab.currentCursor);
  explorer.setCurrentTable(tab.connectionId, tab.database, tab.currentTable);
}

const languageOfFile = (path: string): QueryLanguage => (path.toLowerCase().endsWith(LANGUAGES.tsql.extension) ? 'tsql' : 'foxpro');

/** A new query starts in the language of the tab it was opened from. */
function newTab(text = '', filePath?: string, language: QueryLanguage = filePath ? languageOfFile(filePath) : (active?.language ?? 'foxpro'), connectionId = currentConnectionId, database = currentDatabase): void {
  tabCounter++;
  const tab: Tab = {
    id: crypto.randomUUID(),
    title: filePath ? fileName(filePath) : `Truy vấn ${tabCounter}`,
    filePath,
    language,
    connectionId,
    database,
    model: createModel(text, LANGUAGES[language].monacoId),
    cursors: [],
    messages: '',
    translation: '',
    activeSet: 0,
    pane: 'results',
    hasOutput: false,
    running: false,
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

  // No per-set tabs: every set is stacked in the results pane, the way SSMS and the FoxPro screen show a batch.
  resultSetsHost.replaceChildren();
  exportButton.hidden = !sets.some((set) => set.rows.length);
  if (sets.length) renderGrids(panes.results, sets);
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
  (connectionId: string, database: string | undefined) =>
  async (sessionId: string, sql: string, maxRows: number): Promise<ExecuteResult> => {
    try {
      return await window.db.execute(connectionId, sessionId, sql, maxRows, database);
    } catch (e) {
      throw new Error(ipcErrorMessage(e));
    }
  };

async function run(): Promise<void> {
  const tab = active;
  const connection = connectionOf(tab);
  if (!connection || tab.running || connecting) return;
  const { resolveColumnKind, resolveColumnWidth } = lookups(tab);
  const executeOnServer = executeOn(connection.id, tab.database);
  const callProcedure = (sessionId: string, statement: string, maxRows: number, cursor?: string) => window.db.callProcedure(connection.id, sessionId, statement, maxRows, tab.database, cursor);
  const selection = editor.getSelection();
  const useSelection = selection !== null && !selection.isEmpty();
  let source = useSelection ? tab.model.getValueInRange(selection) : tab.model.getValue();
  const lineOffset = useSelection ? selection.startLineNumber - 1 : 0;
  const notes: string[] = [];
  if (tab.language === 'foxpro') {
    // Checks are typed the way the customer writes them, on FoxPro and SQL Server alike: phrases are
    // asked for, the table is found among the database's tables, which may still be on their way.
    if (connection.loading) {
      report(tab, 'Đang nạp danh sách bảng của CSDL, hãy chạy lại sau giây lát.');
      return;
    }
    await ensureLoaded(connection.id, tab.database);
    if (!tab.currentCursor && !tab.currentTable && tab.procedure) {
      // A bookmark saved on a procedure's result: run that procedure first (its values are asked for or come with the bookmark).
      const procedure = lookups(tab).tables.find((t) => isProcedure(t) && displayName(t) === tab.procedure);
      if (procedure) {
        await useProcedure(connection.id, tab.database!, procedure);
        if (!tab.currentCursor) return;
      }
    }
    const prepared = await prepareFoxBatch(source, { tables: lookups(tab).tables.filter((t) => !isProcedure(t)), hasWorkArea: !!(tab.currentTable || tab.currentCursor), ask: askOrPreset });
    if (prepared.cancelled) return;
    if (prepared.error) {
      report(tab, prepared.error);
      return;
    }
    source = prepared.source;
    notes.push(...prepared.notes);
  }
  const shift = (list: Diagnostic[]) => list.map((d) => ({ ...d, line: d.line + lineOffset }));

  const onExecute = () => {
    tab.running = true;
    renderStatus();
  };

  let result: ExecuteResult | undefined;
  let errors: Diagnostic[] = [];
  let warnings: Diagnostic[];
  const lines: string[] = [...notes];
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
      const outcome = await runFoxQuery(executeOnServer, tab, source, { maxRows: MAX_ROWS, resolveColumnKind, onExecute, callProcedure });
      result = outcome.result;
      errors = shift(outcome.conversion.errors);
      warnings = shift(outcome.conversion.warnings);
      tab.translation = outcome.conversion.sql;
      lines.push(...formatDiagnostics('Lỗi', errors), ...formatDiagnostics('Cảnh báo', warnings));
    } else {
      // T-SQL runs as written; what FoxPro cannot express only limits the translation.
      const outcome = await runTsqlQuery(executeOnServer, tab, source, { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth, onExecute, callProcedure });
      result = outcome.result;
      warnings = shift([...outcome.conversion.errors, ...outcome.conversion.warnings]);
      tab.translation = outcome.conversion.foxpro;
      lines.push(...formatDiagnostics('Chưa dịch được sang FoxPro,', shift(outcome.conversion.errors)), ...formatDiagnostics('Cảnh báo', shift(outcome.conversion.warnings)));
    }
  } finally {
    tab.running = false;
    renderStatus();
  }
  setMarkers(tab, errors, warnings);
  finishRun(tab, connection, source, result, errors, lines);
}

/** Shows a run's outcome in the tab (results or messages) and writes it to the history. */
function finishRun(tab: Tab, connection: Connection, source: string, result: ExecuteResult | undefined, errors: Diagnostic[], lines: string[]): void {
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
    explorer.setCursors(tab.connectionId, tab.database, tab.cursors, tab.currentCursor);
  }
  if (result || errors.length) void recordRun(tab, connection, source, result, errors);
}

/**
 * Makes the table the active tab's work area, as a click on a table does in FoxPro: on a FoxPro
 * database the tab's session really opens it (USE … SHARED NOUPDATE), on SQL Server the
 * converter reads it as the FROM of SUM, COUNT, BROWSE… Either way no name is needed in the command.
 */
async function useTable(connectionId: string, database: string, table: SchemaTable): Promise<void> {
  const tab = active;
  if (tab.running) return;
  bindTab(tab, connectionId, database);
  const connection = findConnection(connectionId);
  if (!connection) return;
  if (connection.kind === 'foxpro') {
    const result = await window.db.execute(connectionId, tab.id, `USE ${table.name}`, 1, database);
    if (result.error) {
      report(tab, `Không mở được bảng ${table.name}: ${result.error}`);
      return;
    }
    tab.currentTable = table.name.toLowerCase();
  } else {
    tab.currentTable = qualifiedName(table);
  }
  tab.currentCursor = undefined;
  renderStatus();
  explorer.setCurrentTable(connectionId, database, displayName(table));
}

/**
 * What a customer does with a payroll procedure: click it, answer its parameters, and get its
 * result as the tab's cursor, so the xBase checks that follow (SUM, COUNT, BROWSE…) need no
 * EXEC at all. The procedure runs rolled back; the values given are remembered per parameter.
 */
async function useProcedure(connectionId: string, database: string, procedure: SchemaTable): Promise<void> {
  const tab = active;
  if (tab.running) return;
  bindTab(tab, connectionId, database);
  const connection = findConnection(connectionId);
  if (!connection) return;
  const values: { name: string; value: string }[] = [];
  for (const parameter of procedure.parameters ?? []) {
    // The label and example come with the schema (the HRM web keeps them in HCSPR_XBaseParam); plain SQL Server has none.
    const value = tab.params?.[parameter.name] ?? (await askParameter(parameter.label ?? `${parameter.name} (${parameter.display})`, `${procedure.name}.${parameter.name}`, parameter.example, parameter.defaultValue));
    if (value === undefined) return;
    values.push({ name: parameter.name, value });
  }
  const statement = execStatement(qualifiedName(procedure), values);
  const cursor = cursorNameFor(procedure.name);
  tab.running = true;
  renderStatus();
  let result: ExecuteResult;
  try {
    result = await window.db.callProcedure(connectionId, tab.id, statement, MAX_ROWS, database, cursor);
  } catch (e) {
    result = { resultSets: [], messages: [], error: ipcErrorMessage(e), truncated: false, elapsedMs: 0 };
  } finally {
    tab.running = false;
    renderStatus();
  }
  const lines = [`Đã chạy ${displayName(procedure)} (mọi thay đổi của thủ tục được rollback).`];
  if (!result.error) {
    tab.cursors = [...new Set([...tab.cursors, cursor])];
    tab.currentCursor = cursor;
    tab.currentTable = undefined;
    tab.procedure = displayName(procedure);
    const first = result.resultSets[0];
    if (!first || !first.rows.length) lines.push(`Thủ tục không trả về dòng nào với giá trị đã nhập (${values.map((v) => `${v.name} = ${v.value}`).join(', ')}): kiểm tra lại kỳ lương hoặc tham số.`);
    else lines.push(`Kết quả là bảng làm việc "${cursor}": gõ SUM, COUNT, BROWSE FOR … hoặc SELECT … FROM ${cursor} rồi nhấn F5.`);
  }
  finishRun(tab, connection, `${statement} INTO CURSOR ${cursor}`, result, [], lines);
}

/** Writes the run to the history on disk, whatever its outcome, and refreshes the list when it is in view. */
async function recordRun(tab: Tab, connection: Connection, source: string, result: ExecuteResult | undefined, errors: Diagnostic[]): Promise<void> {
  const error = result?.error ?? (errors.length ? formatDiagnostics('Lỗi', errors).join('\n') : undefined);
  await window.journal.record({
    connection: connectionLabel(connection),
    database: tab.database,
    language: tab.language,
    sql: source,
    elapsedMs: result?.elapsedMs ?? 0,
    rows: error ? undefined : result?.resultSets.reduce((n, set) => n + set.rows.length, 0),
    error,
  });
  if (currentSide() === 'history') void journal.refreshHistory();
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
    const { sql, errors, warnings } = convertFoxPro(source, { knownCursors: tab.cursors, currentCursor: tab.currentCursor, currentTable: tab.currentTable, resolveColumnKind });
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
    ...saved.map((r) => new Option(`${registrationLabel(r)}${r.profile.database ? ` / ${r.profile.database}` : ''}`, r.id)),
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

/**
 * Makes the connection (and database) the one new tabs use; the first connection also takes
 * the tabs opened before it.
 */
function selectConnection(connectionId: string, database?: string): void {
  const connection = findConnection(connectionId);
  if (!connection) return;
  currentConnectionId = connectionId;
  currentDatabase = database ?? (currentDatabase && connection.databases.some((d) => d.name === currentDatabase) ? currentDatabase : connection.databases[0]?.name);
  for (const tab of tabs) {
    if (!tab.connectionId) {
      tab.connectionId = connectionId;
      tab.database = currentDatabase;
    }
  }
  // As in SSMS, choosing a node never moves an open query; the database box or the context menu does that.
  explorer.setCurrent(currentConnectionId, currentDatabase);
  renderStatus();
}

/** Moves a tab onto another connection; its cursors stay behind with the old session. */
function bindTab(tab: Tab, connectionId: string, database?: string): void {
  if (tab.connectionId === connectionId && (database === undefined || tab.database === database)) return;
  if (tab.connectionId && tab.connectionId !== connectionId) void window.db.closeSession(tab.connectionId, tab.id);
  tab.connectionId = connectionId;
  tab.database = database ?? findConnection(connectionId)?.databases[0]?.name;
  tab.cursors = [];
  tab.currentCursor = undefined;
  tab.currentTable = undefined;
  currentConnectionId = connectionId;
  currentDatabase = tab.database;
  void ensureLoaded(connectionId, tab.database).then(() => {
    if (tab === active) activate(tab);
    explorer.setCurrent(currentConnectionId, currentDatabase);
  });
}

/** Switches the tab to another database of its connection, as the SSMS database box does. Cursors stay in the session. */
function setTabDatabase(tab: Tab, database: string): void {
  if (!tab.connectionId || tab.database === database) return;
  tab.database = database;
  currentConnectionId = tab.connectionId;
  currentDatabase = database;
  void ensureLoaded(tab.connectionId, database).then(() => {
    if (tab === active) activate(tab);
    explorer.setCurrent(currentConnectionId, currentDatabase);
  });
}

function renderExplorer(): void {
  explorer.setEntries(
    registrations.map((registration) => ({ registration, connection: findConnection(registration.id) })),
    currentConnectionId,
    currentDatabase,
  );
  explorer.setCursors(active.connectionId, active.database, active.cursors, active.currentCursor);
}

/** The toolbar box with the databases of the active tab's connection, as in SSMS. */
function renderDatabaseSelect(connection: Connection | undefined): void {
  const shown = connection?.kind === 'sql' && connection.databases.length > 0;
  tabDatabaseSelect.hidden = !shown;
  if (!shown) return;
  const names = connection.databases.map((d) => d.name);
  if ([...tabDatabaseSelect.options].map((o) => o.value).join('\n') !== names.join('\n')) tabDatabaseSelect.replaceChildren(...names.map((name) => new Option(name, name)));
  tabDatabaseSelect.value = active.database ?? '';
}

const withLookups = (tables: SchemaTable[]): Lookups => ({ tables, resolveColumnKind: columnKindResolver(tables), resolveColumnWidth: columnWidthResolver(tables) });

/** Loads the objects of a database once; the explorer and the converters read them from the connection. */
async function ensureLoaded(connectionId: string, database: string | undefined): Promise<void> {
  const connection = findConnection(connectionId);
  if (!connection || !database || connection.lookups[database]) return;
  try {
    const tables = await window.db.loadSchema(connectionId, database);
    connection.lookups[database] = withLookups(tables);
    const entry = connection.databases.find((d) => d.name === database);
    if (entry) entry.tables = tables;
  } catch (e) {
    report(active, `Không nạp được danh sách đối tượng của ${database}: ${ipcErrorMessage(e)}`);
  }
}

async function loadDatabase(connectionId: string, database: string): Promise<void> {
  await ensureLoaded(connectionId, database);
  explorer.databaseLoaded(connectionId, database);
  if (active.connectionId === connectionId && active.database === database) setSchema(lookups(active).tables);
}

/**
 * Adds (or replaces) a connection: lists its databases, loads the one it starts in and makes
 * that the current one. `preferred` is the database the profile named, if any.
 */
async function addConnection(info: ConnectionInfo, preferred?: string): Promise<Connection> {
  // The connection shows up at once; its databases and objects arrive while the user carries on.
  const connection: Connection = { ...info, databases: [], lookups: {}, loading: true };
  const index = connections.findIndex((c) => c.id === info.id);
  if (index < 0) connections.push(connection);
  else connections[index] = connection;
  currentConnectionId = info.id;
  currentDatabase = undefined;
  for (const tab of tabs) {
    if (!tab.connectionId) tab.connectionId = info.id;
  }
  renderExplorer();
  renderStatus();

  let names: string[] = [];
  try {
    names = await window.db.listDatabases(info.id);
  } catch (e) {
    report(active, `Không liệt kê được cơ sở dữ liệu: ${ipcErrorMessage(e)}`);
  }
  if (!connections.includes(connection)) return connection;
  connection.databases = names.map((name) => ({ name }));
  connection.loading = false;
  const start = (preferred && names.find((n) => n.toLowerCase() === preferred.toLowerCase())) ?? names[0];
  if (currentConnectionId === info.id) currentDatabase = start;
  for (const tab of tabs) {
    if (tab.connectionId === info.id && !tab.database) tab.database = start;
  }
  renderExplorer();
  renderStatus();
  await ensureLoaded(info.id, start);
  if (!connections.includes(connection)) return connection;
  explorer.databaseLoaded(info.id, start ?? '');
  if (active.connectionId === info.id) activate(active);
  renderCompare();
  return connection;
}

async function submitConnection(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const profile: ConnectionProfile = {
    server: field('server').value.trim(),
    database: field('database').value.trim() || undefined,
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
    // The login is verified: the dialog goes away now; the tree fills in the background.
    connectDialog.close();
    editor.focus();
    await loadRegistrations();
    void addConnection(info, info.database);
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

/** Writes every result set of the active tab to an .xlsx, one sheet per set. */
async function exportExcel(): Promise<void> {
  const tab = active;
  const sets = tab.result?.resultSets ?? [];
  if (!sets.some((set) => set.rows.length)) {
    report(tab, 'Chưa có kết quả để xuất. Chạy truy vấn trước.');
    return;
  }
  try {
    const name = (tab.filePath ? fileName(tab.filePath).replace(/\.[^.]+$/, '') : tab.title).replace(/[\\/:*?"<>|]/g, ' ');
    const path = await window.app.exportExcel(
      sets.map((set, i) => ({ name: sets.length > 1 ? `Bảng ${i + 1}` : name, columns: set.columns, rows: set.rows })),
      `${name}.xlsx`,
    );
    if (path) report(tab, `Đã xuất ${sets.reduce((n, set) => n + set.rows.length, 0)} dòng ra ${path}`);
  } catch (e) {
    report(tab, `Không xuất được Excel: ${ipcErrorMessage(e)}`);
  }
}

/** Opens a FoxPro database file as a connection of its own, run by FoxPro itself. */
async function openFoxPro(): Promise<void> {
  if (connecting) return;
  const tab = active;
  connecting = true;
  renderStatus();
  try {
    const info = await window.db.openFoxPro();
    if (!info) return;
    await loadRegistrations();
    report(tab, `Đã mở ${info.localPath}. Truy vấn chạy bằng chính FoxPro; T-SQL được chuyển sang FoxPro trước khi chạy.`);
    void addConnection(info);
  } catch (e) {
    report(tab, `Không mở được CSDL FoxPro: ${ipcErrorMessage(e)}`);
  } finally {
    connecting = false;
    renderStatus();
  }
}

/** Reopens a remembered connection; a SQL one without a stored password asks for it. */
async function connectSaved(registrationId: string): Promise<void> {
  if (connecting) return;
  const tab = active;
  connecting = true;
  renderStatus();
  try {
    const info = await window.db.connectSaved(registrationId);
    await loadRegistrations();
    void addConnection(info, info.database);
  } catch (e) {
    const message = ipcErrorMessage(e);
    if (message.includes(NEEDS_PASSWORD)) openConnectDialog(registrationId);
    else report(tab, `Không kết nối được: ${message}`);
  } finally {
    connecting = false;
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
    tab.database = undefined;
    tab.cursors = [];
    tab.currentCursor = undefined;
    tab.currentTable = undefined;
  tab.currentTable = undefined;
  }
  if (currentConnectionId === connectionId) {
    currentConnectionId = connections[connections.length - 1]?.id;
    currentDatabase = connections[connections.length - 1]?.databases[0]?.name;
  }
  renderExplorer();
  setSchema(lookups(active).tables);
  renderCompare();
  renderStatus();
}

async function refreshSchema(connectionId: string | undefined = active.connectionId): Promise<void> {
  const connection = findConnection(connectionId);
  if (!connection) return;
  // Databases may have appeared or gone; the objects of the loaded ones are read again on demand.
  try {
    const names = await window.db.listDatabases(connection.id);
    connection.databases = names.map((name) => ({ name }));
    connection.lookups = {};
    await ensureLoaded(connection.id, active.connectionId === connection.id ? active.database : currentDatabase);
    renderExplorer();
    setSchema(lookups(active).tables);
    renderStatus();
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
  updateLabel.textContent = label ?? '';
  updateButton.title = status.state === 'available' ? `Có bản ${status.newVersion}; nhấn để tải về` : (label ?? '');
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
  'query.exportExcel': () => void exportExcel(),
  'query.bookmark': () => void saveBookmark(activeSource(), active.language),
  'view.compare': toggleCompare,
  'view.explorer': () => document.body.classList.toggle('hide-explorer'),
  'view.objects': () => showSide('objects'),
  'view.history': () => showSide('history'),
  'view.bookmarks': () => showSide('bookmarks'),
  'view.output': toggleOutput,
  'view.results': () => showOutput('results'),
  'view.messages': () => showOutput('messages'),
  'view.tsql': () => showOutput('tsql'),
  'help.checkUpdates': () => void window.updates.check(),
  'help.about': () => void window.app.about(),
};

// ---------- Side pane: objects, history, bookmarks ----------

const currentSide = (): SideName => (sideButtons.find((b) => b.classList.contains('active'))?.dataset.side as SideName | undefined) ?? 'objects';

function showSide(name: SideName): void {
  document.body.classList.remove('hide-explorer');
  for (const button of sideButtons) button.classList.toggle('active', button.dataset.side === name);
  for (const side of ['objects', 'history', 'bookmarks'] as const) el(`side-${side}`).hidden = side !== name;
  if (name === 'history') void journal.refreshHistory();
  if (name === 'bookmarks') void journal.refreshBookmarks();
}

/** Opens a journal entry in a new tab, on the connection it ran on when that one is still open. */
function openFromJournal(sql: string, language: QueryLanguage, connection?: string, database?: string, runIt = false, params?: Record<string, string>, inPlace = false, procedure?: string): void {
  if (inPlace) {
    // Into the current tab, keeping its connection, cursors and work area; the text is replaced as one undo step.
    active.model.pushEditOperations([], [{ range: active.model.getFullModelRange(), text: sql }], () => null);
    active.model.pushStackElement();
    if (active.language !== language) switchLanguage();
  } else {
    const target = connection ? connections.find((c) => connectionLabel(c) === connection) : undefined;
    newTab(sql, undefined, language, target?.id ?? currentConnectionId, target ? database : currentDatabase);
  }
  // A bookmark's values stay with its tab: every run of that tab uses them without asking.
  active.params = params;
  if (procedure && !active.currentCursor) active.procedure = procedure;
  if (params) for (const [name, value] of Object.entries(params)) rememberParameter(name, value);
  if (runIt) void run();
}

/** Asks for a name in the bookmark dialog; resolves with it, or undefined when cancelled. */
function askBookmarkName(title: string, sql: string, initial = ''): Promise<string | undefined> {
  return new Promise((resolve) => {
    bookmarkTitle.textContent = title;
    bookmarkPreview.textContent = sql;
    const input = bookmarkForm.elements.namedItem('name') as HTMLInputElement;
    input.value = initial;
    const done = () => {
      bookmarkDialog.removeEventListener('close', done);
      resolve(bookmarkDialog.returnValue === 'save' ? input.value.trim() || undefined : undefined);
    };
    bookmarkDialog.addEventListener('close', done);
    bookmarkDialog.showModal();
    input.select();
  });
}

/** The tab's bookmark value when it has one, else the dialog. */
function askOrPreset(name: string): Promise<string | undefined> {
  const preset = active.params?.[name];
  return preset ? Promise.resolve(preset) : askParameter(name);
}

/** Asks for a parameter's value, offering the one given last time; resolves undefined when cancelled. */
function askParameter(name: string, key = name, example?: string, defaultValue?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    paramName.textContent = name;
    const input = paramForm.elements.namedItem('value') as HTMLInputElement;
    input.placeholder = example ?? 'số, hoặc tên cột / biểu thức FoxPro';
    input.value = parameterValues.get(key.toLowerCase()) ?? defaultValue ?? '';
    const done = () => {
      paramDialog.removeEventListener('close', done);
      const value = paramDialog.returnValue === 'run' ? input.value.trim() : '';
      if (value) rememberParameter(key, value);
      resolve(value || undefined);
    };
    paramDialog.addEventListener('close', done);
    paramDialog.showModal();
    input.select();
  });
}

async function saveBookmark(sql: string, language: QueryLanguage, existing?: Bookmark): Promise<void> {
  if (!sql.trim()) {
    report(active, 'Chưa có lệnh nào để lưu làm dấu trang.');
    return;
  }
  const name = await askBookmarkName(existing ? 'Đổi tên dấu trang' : 'Lưu dấu trang', sql, existing?.name ?? queryTitle(sql, 60));
  if (!name) return;
  // The values last given for the sql's parameters are kept with the bookmark, so it runs without asking.
  const params: Record<string, string> = {};
  for (const phrase of findParameters(sql)) {
    const value = existing?.params?.[phrase] ?? parameterValues.get(phrase.toLowerCase());
    if (value) params[phrase] = value;
  }
  const procedure = active.currentCursor ? active.procedure : existing?.procedure;
  await window.journal.saveBookmark({ id: existing?.id, name, language, sql, params, procedure });
  showSide('bookmarks');
}

/** The active tab's selection when there is one, else its whole text. */
function activeSource(): string {
  const selection = editor.getSelection();
  return selection && !selection.isEmpty() ? active.model.getValueInRange(selection) : active.model.getValue();
}

const journal = createJournal({
  open: (sql, language, connection, database, runIt, params, inPlace, procedure) => openFromJournal(sql, language, connection, database, runIt, params, inPlace, procedure),
  bookmark: (sql, language) => void saveBookmark(sql, language),
  rename: (bookmark) => void saveBookmark(bookmark.sql, bookmark.language, bookmark),
  removeBookmark: (id) => void window.journal.removeBookmark(id).then(() => journal.refreshBookmarks()),
  clearHistory: () => {
    if (window.confirm('Xóa toàn bộ lịch sử truy vấn đã lưu?')) void window.journal.clearHistory().then(() => journal.refreshHistory());
  },
  copy: (text) => void navigator.clipboard.writeText(text),
});

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
    if (!command || connectDialog.open || bookmarkDialog.open || paramDialog.open) return;
    event.preventDefault();
    event.stopPropagation();
    HANDLERS[command]();
  },
  true,
);

el('connect-cancel').addEventListener('click', () => connectDialog.close());
el('bookmark-cancel').addEventListener('click', () => bookmarkDialog.close('cancel'));
bookmarkForm.addEventListener('submit', () => bookmarkDialog.close('save'));
el('param-cancel').addEventListener('click', () => paramDialog.close('cancel'));
paramForm.addEventListener('submit', () => paramDialog.close('run'));
for (const button of sideButtons) button.addEventListener('click', () => showSide(button.dataset.side as SideName));
el('btn-history-file').addEventListener('click', () => void window.journal.historyPath().then((path) => report(active, `Tệp lịch sử: ${path}`)));
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
tabDatabaseSelect.addEventListener('change', () => setTabDatabase(active, tabDatabaseSelect.value));
newTab();
void (async () => {
  const startup = await window.registry.startup();
  await loadRegistrations();
  for (const id of startup) await connectSaved(id);
})();
