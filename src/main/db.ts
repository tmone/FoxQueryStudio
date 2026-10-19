import type sqlTypes from 'mssql';
import { parseServerName } from '../shared/server-name';
import type { SchemaKey, CellValue, ConnectionProfile, DbBackend, ExecuteResult, ResultSet, SchemaTable } from '../shared/types';

/** The parts of the `mssql` package used here; `mssql/msnodesqlv8` offers the same ones. */
export type SqlDriver = Pick<typeof sqlTypes, 'ConnectionPool' | 'Table' | 'MAX'>;
type Pool = sqlTypes.ConnectionPool;

/** Three result sets: columns, key constraints, indexes — what the object explorer shows for a table. */
export const SCHEMA_QUERY = `
SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;
SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME
WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
ORDER BY tc.TABLE_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;
SELECT s.name AS TABLE_SCHEMA, o.name AS TABLE_NAME, i.name AS INDEX_NAME, i.type_desc AS INDEX_TYPE, i.is_unique AS IS_UNIQUE, i.is_primary_key AS IS_PRIMARY, c.name AS COLUMN_NAME
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.name IS NOT NULL AND o.type IN ('U', 'V') AND ic.is_included_column = 0
ORDER BY s.name, o.name, i.name, ic.key_ordinal;
SELECT r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.PARAMETER_NAME, p.DATA_TYPE, p.CHARACTER_MAXIMUM_LENGTH, p.NUMERIC_PRECISION, p.NUMERIC_SCALE
FROM INFORMATION_SCHEMA.ROUTINES r
LEFT JOIN INFORMATION_SCHEMA.PARAMETERS p ON p.SPECIFIC_SCHEMA = r.SPECIFIC_SCHEMA AND p.SPECIFIC_NAME = r.SPECIFIC_NAME AND p.PARAMETER_MODE <> 'OUT' AND p.PARAMETER_NAME <> ''
WHERE r.ROUTINE_TYPE = 'PROCEDURE'
ORDER BY r.ROUTINE_SCHEMA, r.ROUTINE_NAME, p.ORDINAL_POSITION`;

type Row = Record<string, unknown>;
const KEY_KIND: Record<string, SchemaKey['kind']> = { 'PRIMARY KEY': 'PK', 'FOREIGN KEY': 'FK', UNIQUE: 'UQ' };

/** The type as SSMS shows it: nvarchar(150), varchar(max), decimal(18,2), int. */
export function displayType(row: Row): string {
  const type = String(row.DATA_TYPE);
  const length = row.CHARACTER_MAXIMUM_LENGTH as number | null;
  if (length !== null && length !== undefined) return `${type}(${length === -1 ? 'max' : length})`;
  if (['decimal', 'numeric'].includes(type)) return `${type}(${row.NUMERIC_PRECISION},${row.NUMERIC_SCALE})`;
  return type;
}

/** Groups the result sets of SCHEMA_QUERY into tables with their columns, keys and indexes, then the procedures. */
export function schemaFromRows(columns: Row[], keys: Row[] = [], indexes: Row[] = [], procedures: Row[] = []): SchemaTable[] {
  const tables = new Map<string, SchemaTable>();
  const tableOf = (row: Row) => tables.get(`${row.TABLE_SCHEMA}.${row.TABLE_NAME}`);
  for (const row of columns) {
    const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    let table = tables.get(key);
    if (!table) {
      table = { schema: String(row.TABLE_SCHEMA), name: String(row.TABLE_NAME), isView: row.TABLE_TYPE === 'VIEW', columns: [], keys: [], indexes: [] };
      tables.set(key, table);
    }
    table.columns.push({
      name: String(row.COLUMN_NAME),
      dataType: String(row.DATA_TYPE),
      display: displayType(row),
      maxLength: row.CHARACTER_MAXIMUM_LENGTH as number | null,
      nullable: row.IS_NULLABLE === 'YES',
    });
  }
  for (const row of keys) {
    const table = tableOf(row);
    if (!table) continue;
    const name = String(row.CONSTRAINT_NAME);
    const kind = KEY_KIND[String(row.CONSTRAINT_TYPE)];
    let key = table.keys!.find((k) => k.name === name);
    if (!key) table.keys!.push((key = { name, kind, columns: [] }));
    key.columns.push(String(row.COLUMN_NAME));
    const column = table.columns.find((c) => c.name === row.COLUMN_NAME);
    // A column in both keys is shown as primary; SSMS does the same.
    if (column && kind !== 'UQ' && column.keyRole !== 'PK') column.keyRole = kind;
  }
  for (const row of indexes) {
    const table = tableOf(row);
    if (!table) continue;
    const name = String(row.INDEX_NAME);
    let index = table.indexes!.find((i) => i.name === name);
    if (!index) table.indexes!.push((index = { name, unique: !!row.IS_UNIQUE, clustered: String(row.INDEX_TYPE).toUpperCase() === 'CLUSTERED', primary: !!row.IS_PRIMARY, columns: [] }));
    index.columns.push(String(row.COLUMN_NAME));
  }
  const routines = new Map<string, SchemaTable>();
  for (const row of procedures) {
    const key = `${row.ROUTINE_SCHEMA}.${row.ROUTINE_NAME}`;
    let routine = routines.get(key);
    if (!routine) routines.set(key, (routine = { schema: String(row.ROUTINE_SCHEMA), name: String(row.ROUTINE_NAME), isView: false, columns: [], kind: 'procedure', parameters: [] }));
    if (row.PARAMETER_NAME) routine.parameters!.push({ name: String(row.PARAMETER_NAME), display: displayType(row) });
  }
  return [...tables.values(), ...routines.values()];
}

/**
 * The EXEC inside a transaction that is always rolled back: whatever the procedure wrote is
 * undone, its result sets still come back. A procedure that rolled back on its own leaves
 * no transaction, hence the @@TRANCOUNT check; an error is passed on as it was.
 */
export function rolledBack(statement: string): string {
  return `BEGIN TRAN;\nBEGIN TRY\n${statement};\nIF @@TRANCOUNT > 0 ROLLBACK TRAN;\nEND TRY\nBEGIN CATCH\nIF @@TRANCOUNT > 0 ROLLBACK TRAN;\nTHROW;\nEND CATCH`;
}

/** What the driver tells about a result column, enough to make a table that holds the rows. */
interface ColumnMeta {
  name: string;
  type: unknown;
  length?: number;
  precision?: number;
  scale?: number;
}

const withoutRaw = ({ raw: _raw, ...result }: ExecuteResult & { raw: unknown }): ExecuteResult => result;

/** Lengths above this (and 0 or -1) mean (max). */
const MAX_LENGTH_THRESHOLD = 8000;
const SIZED_TYPES = /^(n?var)?(char|binary)$/i;
const SCALED_TYPES = /^(decimal|numeric)$/i;

/** The column's type with its size, as the driver's type factories take it: nvarchar(50), decimal(18,2), int. */
function sizedType(column: ColumnMeta, max: number): unknown {
  const factory = column.type as ((...args: number[]) => unknown) & { declaration?: string };
  if (typeof factory !== 'function') return column.type;
  const declaration = factory.declaration ?? '';
  if (SIZED_TYPES.test(declaration)) {
    const length = column.length === undefined || column.length <= 0 || column.length > MAX_LENGTH_THRESHOLD ? max : column.length;
    return factory(length);
  }
  if (SCALED_TYPES.test(declaration) && column.precision !== undefined) return factory(column.precision, column.scale ?? 0);
  return factory();
}

const DATABASES_QUERY = 'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name';
/** The message the server sends for USE; it is not news to the user. */
const CONTEXT_CHANGED = /Changed database context to /;

const quoteName = (name: string) => `[${name.replace(/]/g, ']]')}]`;
/** Puts the batch in the database the tab works in; the session keeps that context afterwards. */
const inDatabase = (sql: string, database?: string) => (database ? `USE ${quoteName(database)};\n${sql}` : sql);

const REQUEST_TIMEOUT_MS = 120_000;
/** How long to wait for the driver to finish a request after it has reported an error. */
const ERROR_GRACE_MS = 1500;

/** Connection settings for the default driver (tedious, TCP). */
export function tediousConfig(p: ConnectionProfile): sqlTypes.config {
  const { host, instance, port } = parseServerName(p.server);
  return {
    // A port names the endpoint outright; without one, a named instance is looked up through SQL Browser.
    server: host,
    port,
    database: p.database || undefined,
    user: p.user,
    password: p.password,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // min 1 keeps the connection (and its temp tables) alive while the tab is open.
    pool: { min: 1, max: 1 },
    options: {
      instanceName: port ? undefined : instance,
      encrypt: p.encrypt,
      trustServerCertificate: p.trustServerCertificate,
      appName: 'FoxQueryStudio',
      readOnlyIntent: true,
    },
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Values cross IPC as plain display-ready primitives. */
function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // The driver returns dates as UTC wall-clock values.
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const ms = value.getUTCMilliseconds();
    const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
    if (time === '00:00:00' && ms === 0) return date;
    return `${date} ${time}${ms ? `.${pad(ms, 3)}` : ''}`;
  }
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

/**
 * Creates the database service. The driver and its connection settings are passed in
 * so tests can run the same code against LocalDB, which the default driver cannot reach.
 */
export interface SqlDatabase extends DbBackend {
  /** Checks the profile by opening a connection and returns the database it lands in (the login's default when none was named). */
  connect(profile: ConnectionProfile): Promise<string>;
}

export function createDatabase(driver: SqlDriver, buildConfig: (profile: ConnectionProfile) => sqlTypes.config): SqlDatabase {
  let profile: ConnectionProfile | undefined;
  /** One single-connection pool per query tab, so #temp cursors survive between runs. */
  const sessions = new Map<string, Pool>();

  const openPool = (p: ConnectionProfile): Promise<Pool> => new driver.ConnectionPool(buildConfig(p)).connect();

  function requireProfile(): ConnectionProfile {
    if (!profile) throw new Error('Chưa kết nối máy chủ.');
    return profile;
  }

  async function getSession(sessionId: string): Promise<Pool> {
    let pool = sessions.get(sessionId);
    if (!pool) {
      pool = await openPool(requireProfile());
      sessions.set(sessionId, pool);
    }
    return pool;
  }

  async function disconnect(): Promise<void> {
    const pools = [...sessions.values()];
    sessions.clear();
    profile = undefined;
    await Promise.allSettled(pools.map((pool) => pool.close()));
  }

  return {
    async connect(p) {
      await disconnect();
      const pool = await openPool(p);
      try {
        // With both an instance name and a port, the port decides where the connection went;
        // it must be the instance the user named, not whichever one listens there.
        const { instance, port } = parseServerName(p.server);
        const { recordset } = await pool.request().query('SELECT @@SERVICENAME AS name, DB_NAME() AS db');
        const actual = String(recordset[0]?.name ?? '');
        if (instance && port && actual.toLowerCase() !== instance.toLowerCase()) throw new Error(`Cổng ${port} là instance ${actual}, không phải ${instance}. Sửa tên instance hoặc cổng.`);
        profile = p;
        return String(recordset[0]?.db ?? p.database ?? '');
      } finally {
        await pool.close();
      }
    },

    disconnect,

    async closeSession(sessionId) {
      const pool = sessions.get(sessionId);
      sessions.delete(sessionId);
      await pool?.close();
    },

    async listDatabases() {
      const pool = await openPool(requireProfile());
      try {
        const { recordset } = await pool.request().query(DATABASES_QUERY);
        return recordset.map((row: { name: string }) => row.name);
      } finally {
        await pool.close();
      }
    },

    async loadSchema(database) {
      const pool = await openPool(requireProfile());
      try {
        const { recordsets } = (await pool.request().batch(inDatabase(SCHEMA_QUERY, database))) as unknown as { recordsets: Row[][] };
        return schemaFromRows(recordsets[0] ?? [], recordsets[1], recordsets[2], recordsets[3]);
      } finally {
        await pool.close();
      }
    },

    // The raw rows stay in this process: the driver's column metadata cannot cross IPC.
    execute: async (sessionId, sqlText, maxRows, database) => withoutRaw(await runBatch(sessionId, sqlText, maxRows, database)),

    async callProcedure(sessionId, statement, maxRows, database, cursor): Promise<ExecuteResult> {
      const started = Date.now();
      const { raw, ...outcome } = await runBatch(sessionId, rolledBack(statement), maxRows, database, true);
      if (outcome.error || !cursor) return { ...outcome, elapsedMs: Date.now() - started };
      const first = raw[0];
      if (!first) return { ...outcome, error: 'Thủ tục không trả về bảng kết quả nào để đưa vào cursor.', elapsedMs: Date.now() - started };
      // The first result set becomes the session's cursor: a #temp table shaped like it, filled in one bulk load.
      const pool = await getSession(sessionId);
      const table = new driver.Table(`#${cursor}`);
      table.create = true;
      for (const column of first.columns) table.columns.add(column.name, sizedType(column, driver.MAX as number) as never, { nullable: true });
      for (const row of first.rows) table.rows.add(...(row as never[]));
      try {
        await pool.request().batch(inDatabase(`DROP TABLE IF EXISTS [#${cursor}]`, database));
        await pool.request().bulk(table);
      } catch (e) {
        return { ...outcome, error: `Không tạo được cursor ${cursor} từ kết quả thủ tục: ${(e as Error).message}`, elapsedMs: Date.now() - started };
      }
      return { ...outcome, messages: [...outcome.messages, `Cursor ${cursor}: ${first.rows.length} dòng từ kết quả thủ tục.`], elapsedMs: Date.now() - started };
    },
  };

  /**
   * Runs a batch in the session and collects what comes back; with `keepRaw` the result sets are
   * also kept as the driver gave them (values and column metadata), for building a cursor.
   */
  async function runBatch(sessionId: string, sqlText: string, maxRows: number, database?: string, keepRaw = false): Promise<ExecuteResult & { raw: { columns: ColumnMeta[]; rows: unknown[][] }[] }> {
      const started = Date.now();
      const resultSets: ResultSet[] = [];
      const raw: { columns: ColumnMeta[]; rows: unknown[][] }[] = [];
      const messages: string[] = [];
      let error: string | undefined;
      let truncated = false;
      let stalled = false;

      const pool = await getSession(sessionId);
      const request = pool.request();
      request.stream = true;
      request.arrayRowMode = true;

      await new Promise<void>((resolve) => {
        request.on('recordset', (columns: unknown) => {
          const list = Array.isArray(columns) ? columns : Object.values(columns as object);
          resultSets.push({ columns: list.map((c: { name: string }) => c.name), rows: [] });
          if (keepRaw) raw.push({ columns: list as ColumnMeta[], rows: [] });
        });
        request.on('row', (row: unknown[]) => {
          const current = resultSets[resultSets.length - 1];
          if (current.rows.length < maxRows) {
            current.rows.push(row.map(toCell));
            if (keepRaw) raw[raw.length - 1].rows.push(row);
          } else if (!truncated) {
            truncated = true;
            request.cancel();
          }
        });
        request.on('info', (info: { message: string }) => {
          if (!CONTEXT_CHANGED.test(info.message)) messages.push(info.message);
        });
        // 'done' is documented as always the last event. A driver that fails to send it after
        // an error would leave the tab waiting forever, so the request is given up on instead.
        let grace: ReturnType<typeof setTimeout> | undefined;
        request.on('error', (err: Error) => {
          // The cancel we issue at the row limit surfaces as an error; it is not a failure.
          if (truncated) return;
          error = error ? `${error}\n${err.message}` : err.message;
          clearTimeout(grace);
          grace = setTimeout(() => {
            stalled = true;
            resolve();
          }, ERROR_GRACE_MS);
        });
        request.on('done', () => {
          clearTimeout(grace);
          resolve();
        });
        void request.batch(inDatabase(sqlText, database)).catch(() => undefined);
      });

      // A stalled request still holds the session's only connection, so the session is replaced.
      if (stalled) {
        sessions.delete(sessionId);
        void pool.close().catch(() => undefined);
      }
      return { resultSets, messages, error, truncated, sessionReset: stalled || undefined, elapsedMs: Date.now() - started, raw };
  }
}
