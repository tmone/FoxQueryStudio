import type sqlTypes from 'mssql';
import type { CellValue, ConnectionProfile, DbBackend, ExecuteResult, ResultSet, SchemaTable } from '../shared/types';

/** The parts of the `mssql` package used here; `mssql/msnodesqlv8` offers the same ones. */
export type SqlDriver = Pick<typeof sqlTypes, 'ConnectionPool'>;
type Pool = sqlTypes.ConnectionPool;

export const SCHEMA_QUERY = `
SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;

/** Groups the rows of SCHEMA_QUERY into tables with their columns. */
export function schemaFromRows(rows: Record<string, unknown>[]): SchemaTable[] {
  const tables = new Map<string, SchemaTable>();
  for (const row of rows) {
    const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    let table = tables.get(key);
    if (!table) {
      table = { schema: String(row.TABLE_SCHEMA), name: String(row.TABLE_NAME), isView: row.TABLE_TYPE === 'VIEW', columns: [] };
      tables.set(key, table);
    }
    table.columns.push({
      name: String(row.COLUMN_NAME),
      dataType: String(row.DATA_TYPE),
      maxLength: row.CHARACTER_MAXIMUM_LENGTH as number | null,
      nullable: row.IS_NULLABLE === 'YES',
    });
  }
  return [...tables.values()];
}

const REQUEST_TIMEOUT_MS = 120_000;
/** How long to wait for the driver to finish a request after it has reported an error. */
const ERROR_GRACE_MS = 1500;

/** Connection settings for the default driver (tedious, TCP). */
export function tediousConfig(p: ConnectionProfile): sqlTypes.config {
  return {
    server: p.server,
    port: p.port,
    database: p.database,
    user: p.user,
    password: p.password,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // min 1 keeps the connection (and its temp tables) alive while the tab is open.
    pool: { min: 1, max: 1 },
    options: {
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
  /** Checks the profile by opening a connection; the connection itself is kept per session. */
  connect(profile: ConnectionProfile): Promise<void>;
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
      await pool.close();
      profile = p;
    },

    disconnect,

    async closeSession(sessionId) {
      const pool = sessions.get(sessionId);
      sessions.delete(sessionId);
      await pool?.close();
    },

    async loadSchema() {
      const pool = await openPool(requireProfile());
      try {
        const { recordset } = await pool.request().query(SCHEMA_QUERY);
        return schemaFromRows(recordset);
      } finally {
        await pool.close();
      }
    },

    async execute(sessionId, sqlText, maxRows): Promise<ExecuteResult> {
      const started = Date.now();
      const resultSets: ResultSet[] = [];
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
        });
        request.on('row', (row: unknown[]) => {
          const current = resultSets[resultSets.length - 1];
          if (current.rows.length < maxRows) {
            current.rows.push(row.map(toCell));
          } else if (!truncated) {
            truncated = true;
            request.cancel();
          }
        });
        request.on('info', (info: { message: string }) => messages.push(info.message));
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
        void request.batch(sqlText).catch(() => undefined);
      });

      // A stalled request still holds the session's only connection, so the session is replaced.
      if (stalled) {
        sessions.delete(sessionId);
        void pool.close().catch(() => undefined);
      }
      return { resultSets, messages, error, truncated, sessionReset: stalled || undefined, elapsedMs: Date.now() - started };
    },
  };
}
