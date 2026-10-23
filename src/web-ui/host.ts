/**
 * The desktop renderer inside the HRM web page: the five bridges the preload script exposes in
 * Electron (db, app, registry, updates, journal) are provided here instead, on top of the page's
 * host object (`lvXBaseHost`, set by the OpenUI5 controller that embeds this page in an iframe).
 * One "connection" exists: the user's own HRM database through the KiemTraLuong API.
 */
import type { AppApi } from '../shared/commands';
import type { Bookmark, HistoryEntry, HistoryFilter, JournalApi } from '../shared/journal';
import type { Registration, RegistryApi } from '../shared/registry';
import type { ConnectionInfo, DbApi, ExecuteResult, SchemaTable } from '../shared/types';
import type { UpdateApi, UpdateStatus } from '../shared/update';
import { buildWorkbook } from '../shared/xlsx';

/** What the embedding page gives this one. */
export interface WebHost {
  /** Calls a method of the KiemTraLuong API with the given fields; resolves with the server's JSON. */
  call(method: string, data: Record<string, unknown>): Promise<unknown>;
  user: string;
  customer: string;
  /** Shown as the connection's server name. */
  siteName?: string;
  version?: string;
  permissions?: { write?: boolean; export?: boolean };
}

interface ServerResultSet {
  Columns: string[];
  Rows: unknown[][];
}
interface ServerResult {
  ResultSets?: ServerResultSet[];
  Messages?: string[];
  ErrorMessage?: string;
  Truncated?: boolean;
  ElapsedMs?: number;
  Cursor?: string;
}
interface ServerObject {
  Name: string;
  Schema: string;
  ObjectName: string;
  Type: string;
  Parameters?: { Name: string; Type: string; Label?: string | null; Example?: string | null; Default?: string | null }[];
  Columns?: { Name: string; Type: string }[];
}
interface ServerBookmark {
  RecID: string;
  UserID: string | null;
  Name: string;
  Language: string;
  Sql: string;
  Params?: string | null;
}

const CONNECTION_ID = 'site';
const HISTORY_LIMIT = 500;

function host(): WebHost {
  const w = window as unknown as { lvXBaseHost?: WebHost; parent?: { lvXBaseHost?: WebHost } };
  const found = w.lvXBaseHost ?? (window.parent !== window ? (window.parent as unknown as { lvXBaseHost?: WebHost }).lvXBaseHost : undefined);
  if (!found) throw new Error('Trang chưa được nhúng vào màn Kiểm tra lương (thiếu lvXBaseHost).');
  return found;
}

const toResult = (raw: ServerResult | undefined): ExecuteResult => ({
  resultSets: (raw?.ResultSets ?? []).map((s) => ({ columns: s.Columns ?? [], rows: (s.Rows ?? []) as ExecuteResult['resultSets'][0]['rows'] })),
  messages: [...(raw?.Messages ?? [])],
  error: raw?.ErrorMessage || undefined,
  truncated: !!raw?.Truncated,
  elapsedMs: raw?.ElapsedMs ?? 0,
});

/** `EXEC schema.name @a = 1, @b = N'x'` → the whitelisted name and its values as the server binds them. */
export function parseExecCall(statement: string): { name: string; params: Record<string, string> } | undefined {
  const m = /^\s*EXEC(?:UTE)?\s+([\w[\]]+\.[\w[\]]+)\s*([\s\S]*)$/i.exec(statement.replace(/\s+/g, ' ').trim());
  if (!m) return undefined;
  const params: Record<string, string> = {};
  const re = /@(\w+)\s*=\s*(N?'(?:[^']|'')*'|[^,]+)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[2] ?? '')) !== null) {
    const value = hit[2].trim();
    const str = /^N?'([\s\S]*)'$/.exec(value);
    params[hit[1]] = str ? str[1].replace(/''/g, "'") : value;
  }
  return { name: m[1].replace(/[[\]]/g, ''), params };
}

const connectionInfo = (): ConnectionInfo => ({ id: CONNECTION_ID, kind: 'sql', server: host().siteName ?? 'HRM', user: host().user, database: host().customer });

const db: DbApi = {
  connect: async () => connectionInfo(),
  connectSaved: async () => connectionInfo(),
  openFoxPro: async () => undefined,
  disconnect: async () => {
    await host().call('CloseSession', {});
  },
  listDatabases: async () => [host().customer],
  loadSchema: async () => {
    const data = (await host().call('GetObjects', {})) as { Objects?: ServerObject[] };
    return (data.Objects ?? []).map<SchemaTable>((o) =>
      o.Type === 'P'
        ? { schema: o.Schema, name: o.ObjectName, isView: false, columns: [], kind: 'procedure', parameters: (o.Parameters ?? []).map((p) => ({ name: p.Name, display: p.Type, label: p.Label || undefined, example: p.Example || undefined, defaultValue: p.Default || undefined })) }
        : { schema: o.Schema, name: o.ObjectName, isView: o.Type === 'V', columns: (o.Columns ?? []).map((c) => ({ name: c.Name, dataType: c.Type, maxLength: null, nullable: true })), keys: [], indexes: [] },
    );
  },
  execute: async (_id, sessionId, sql) => toResult((await host().call('RunQuery', { TSql: sql, Source: sql, Session: sessionId })) as ServerResult),
  callProcedure: async (_id, sessionId, statement, _maxRows, _database, cursor) => {
    const parsed = parseExecCall(statement);
    if (!parsed) return { resultSets: [], messages: [], error: `Không đọc được lệnh EXEC: ${statement}`, truncated: false, elapsedMs: 0 };
    return toResult((await host().call('RunProcedure', { ObjectName: parsed.name, Params: parsed.params, Cursor: cursor ?? '', Source: statement, Session: sessionId })) as ServerResult);
  },
  closeSession: async (_id, sessionId) => {
    await host().call('CloseSession', { Session: sessionId });
  },
};

const registry: RegistryApi = {
  list: async (): Promise<Registration[]> => [
    { id: CONNECTION_ID, kind: 'sql', profile: { server: host().siteName ?? 'HRM', database: host().customer, user: host().user, encrypt: true, trustServerCertificate: true }, hasPassword: true },
  ],
  startup: async () => [CONNECTION_ID],
  remove: async () => undefined,
};

const historyKey = () => `ktl.history.${host().customer}.${host().user}`;
function readHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(historyKey()) ?? '[]') as HistoryEntry[];
  } catch {
    return [];
  }
}
function writeHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(historyKey(), JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Storage may be full or blocked; the list is a convenience.
  }
}

/** The server keeps one JSON per bookmark: parameter values, plus the procedure under "$procedure". */
const PROCEDURE_KEY = '$procedure';
function parseParams(json: string | null | undefined): { params?: Record<string, string>; procedure?: string } {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const procedure = parsed[PROCEDURE_KEY] ? String(parsed[PROCEDURE_KEY]) : undefined;
    const params = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== PROCEDURE_KEY).map(([k, v]) => [k, String(v)]));
    return { params: Object.keys(params).length ? params : undefined, procedure };
  } catch {
    return {};
  }
}
const paramsJson = (bookmark: { params?: Record<string, string>; procedure?: string }) => JSON.stringify({ ...(bookmark.params ?? {}), ...(bookmark.procedure ? { [PROCEDURE_KEY]: bookmark.procedure } : {}) });

const toBookmark = (b: ServerBookmark): Bookmark => ({ id: b.RecID, name: b.Name, language: b.Language === 'tsql' ? 'tsql' : 'foxpro', sql: b.Sql, ...parseParams(b.Params), createdAt: '' });

const journal: JournalApi = {
  history: async (filter?: HistoryFilter) => {
    const text = filter?.text?.toLowerCase();
    return readHistory().filter((e) => !text || `${e.sql} ${e.connection} ${e.database ?? ''}`.toLowerCase().includes(text));
  },
  record: async (entry) => {
    const saved: HistoryEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() };
    writeHistory([saved, ...readHistory()]);
    return saved;
  },
  clearHistory: async () => writeHistory([]),
  historyPath: async () => 'localStorage',
  bookmarks: async () => ((await host().call('GetBookmarks', {})) as ServerBookmark[]).map(toBookmark),
  saveBookmark: async (bookmark) => {
    const data = (await host().call('SaveBookmark', { BookmarkID: bookmark.id ?? '', Name: bookmark.name, Sql: bookmark.sql, QueryLanguage: bookmark.language, ParamsJson: paramsJson(bookmark) })) as { RecID: string };
    return { id: data.RecID, name: bookmark.name, language: bookmark.language, sql: bookmark.sql, params: bookmark.params, procedure: bookmark.procedure, createdAt: new Date().toISOString() };
  },
  removeBookmark: async (id) => {
    await host().call('DeleteBookmark', { BookmarkID: id });
  },
};

const updates: UpdateApi = {
  getStatus: async (): Promise<UpdateStatus> => ({ state: 'disabled', currentVersion: host().version ?? '', message: 'Bản web: cập nhật cùng site.' }),
  check: async () => undefined,
  download: async () => undefined,
  install: async () => undefined,
  onStatus: () => () => undefined,
};

/** Hands the browser a file to save. */
function download(name: string, bytes: Uint8Array, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const app: AppApi & { about(): Promise<void> } = {
  onCommand: () => () => undefined,
  openFile: async () => undefined,
  saveFile: async () => undefined,
  about: async () => undefined,
  exportExcel: async (sheets, suggestedName) => {
    download(suggestedName, buildWorkbook(sheets), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return suggestedName;
  },
  getVfpPath: async () => undefined,
  chooseVfpPath: async () => undefined,
};

/** Installs the bridges the renderer expects on `window`, before the renderer script runs. */
export function installHost(): void {
  const w = window as unknown as Record<string, unknown>;
  w.db = db;
  w.app = app;
  w.registry = registry;
  w.updates = updates;
  w.journal = journal;
  const p = host().permissions ?? {};
  document.body.classList.add('web');
  if (p.write === false) document.body.classList.add('no-write');
  if (p.export === false) document.body.classList.add('no-export');
}
