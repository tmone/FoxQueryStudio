import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type sqlTypes from 'mssql';
import sqlv8 from 'mssql/msnodesqlv8';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFoxDatabase, type FoxTable } from '../src/dbf/database';
import { createDatabase } from '../src/main/db';
import { loadTables } from '../src/main/local-db';
import { columnKindResolver, columnWidthResolver } from '../src/shared/column-kind';
import { describeDatabase, referencedTables, type LocalDatabase } from '../src/shared/local-db';
import { runFoxQuery, runTsqlQuery, type QuerySession } from '../src/shared/run-query';
import type { CellValue, ConnectionProfile, DbApi } from '../src/shared/types';
import { isLocalDbAvailable } from '../tools/sqlrun';

// A local FoxPro database (the Northwind sample that ships with Visual FoxPro) loaded into the
// #temp tables of a query session on a real SQL Server, then read in both languages the way a
// tab does. Expected values are computed from the .dbf records themselves.

const FIXTURES = join('test', 'fixtures', 'northwind');
const MAX_ROWS = 5000;
const PROFILE: ConnectionProfile = { server: '(localdb)\\MSSQLLocalDB', database: 'tempdb', user: '', password: '', encrypt: false, trustServerCertificate: true };
const buildConfig = (p: ConnectionProfile) =>
  ({
    connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=${p.server};Database=${p.database};Trusted_Connection=yes;`,
    pool: { min: 1, max: 1 },
  }) as unknown as sqlTypes.config;

const available = existsSync(join(FIXTURES, 'orders.dbf')) && isLocalDbAvailable();

describe.skipIf(!available)('local FoxPro database in a query session', () => {
  let db: DbApi;
  let tables: FoxTable[];
  let local: LocalDatabase;
  let resolveColumnKind: ReturnType<typeof columnKindResolver>;
  let resolveColumnWidth: ReturnType<typeof columnWidthResolver>;

  const records = (name: string) => tables.find((t) => t.name === name)!.records;
  const text = (value: unknown) => String(value).trimEnd();
  /** A tab session that already knows the local tables as cursors, as the app sets it up. */
  const session = (id: string): QuerySession => ({ id, cursors: local.tables.map((t) => t.name) });
  const load = (id: string, names: string[]) => loadTables(db.execute, id, tables.filter((t) => names.includes(t.name)));

  async function fox(tab: QuerySession, source: string): Promise<CellValue[][]> {
    const outcome = await runFoxQuery(db.execute, tab, source, { maxRows: MAX_ROWS, resolveColumnKind });
    expect(outcome.conversion.errors, 'converter errors').toEqual([]);
    expect(outcome.result?.error, outcome.conversion.sql).toBeUndefined();
    return outcome.result!.resultSets[0].rows;
  }

  beforeAll(async () => {
    tables = loadFoxDatabase(FIXTURES);
    local = describeDatabase(FIXTURES, tables);
    resolveColumnKind = columnKindResolver([], local.tables);
    resolveColumnWidth = columnWidthResolver([], local.tables);
    db = createDatabase(sqlv8, buildConfig);
    await db.connect(PROFILE);
  }, 120_000);

  afterAll(async () => {
    await db?.disconnect();
  });

  it('describes the tables with the long field names of the .dbc', () => {
    const customers = local.tables.find((t) => t.name === 'customers')!;
    expect(customers.rowCount).toBe(records('customers').length);
    expect(customers.columns.find((c) => c.name === 'companyname')).toMatchObject({ kind: 'string', dataType: expect.stringMatching(/^nchar\(\d+\)$/) });
    expect(local.tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'orderdate')!.kind).toMatch(/^date/);
  });

  it('finds the local tables a query mentions, in either spelling', () => {
    expect(referencedTables('SELECT * FROM Customers c JOIN orders o ON 1 = 1', local.tables)).toEqual(['customers', 'orders']);
    expect(referencedTables('SELECT * FROM #products', local.tables)).toEqual(['products']);
    expect(referencedTables('SELECT customersx FROM dbo.NhanVien', local.tables)).toEqual([]);
  });

  it('reads the loaded tables with FoxPro source', async () => {
    const tab = session('fox');
    await load(tab.id, ['customers', 'orders']);

    expect(await fox(tab, 'SELECT COUNT(*) FROM customers')).toEqual([[records('customers').length]]);

    // FoxPro compares up to the shorter string: "Ger" matches Germany.
    const german = records('customers').filter((c) => text(c.country).startsWith('Ger')).map((c) => text(c.customerid)).sort();
    expect(german.length).toBeGreaterThan(0);
    const rows = await fox(tab, 'SELECT ALLTRIM(customerid) FROM customers WHERE country = "Ger" ORDER BY 1');
    expect(rows.map((r) => r[0])).toEqual(german);

    const perCustomer = new Map<string, number>();
    for (const o of records('orders')) perCustomer.set(text(o.customerid), (perCustomer.get(text(o.customerid)) ?? 0) + 1);
    const top = [...perCustomer.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    const joined = await fox(
      tab,
      'SELECT TOP 1 ALLTRIM(c.customerid) AS ma, COUNT(*) AS n FROM customers c JOIN orders o ON o.customerid = c.customerid ;\n  GROUP BY c.customerid ORDER BY 2 DESC, 1',
    );
    expect(joined).toEqual([top]);
  }, 120_000);

  it('reads the same tables with T-SQL and gives the FoxPro form', async () => {
    const tab = session('tsql');
    await load(tab.id, ['orders']);
    const expected = records('orders').filter((o) => o.orderdate instanceof Date && o.orderdate.getUTCFullYear() >= 1997).length;
    expect(expected).toBeGreaterThan(0);

    const outcome = await runTsqlQuery(db.execute, tab, "SELECT COUNT(*) FROM #orders WHERE orderdate >= '1997-01-01'", { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth });
    expect(outcome.result?.error).toBeUndefined();
    expect(outcome.result!.resultSets[0].rows).toEqual([[expected]]);
    expect(outcome.conversion.errors).toEqual([]);
    expect(outcome.conversion.foxpro).toBe('SELECT COUNT(*) FROM orders WHERE orderdate >= {^1997-01-01}');

    // The FoxPro form, run through the other direction, reads the same rows.
    expect(await fox(tab, outcome.conversion.foxpro)).toEqual([[expected]]);
  }, 120_000);

  it('keeps cursors made from local tables apart from the tables themselves', async () => {
    const tab = session('cursor');
    await load(tab.id, ['products']);
    const made = await runFoxQuery(db.execute, tab, 'SELECT productname, unitprice FROM products WHERE unitprice > 50 INTO CURSOR dat', { maxRows: MAX_ROWS, resolveColumnKind });
    expect(made.result?.error).toBeUndefined();
    expect(tab.cursors).toContain('dat');
    const expensive = records('products').filter((p) => Number(p.unitprice) > 50).length;
    expect(await fox(tab, 'SELECT COUNT(*) FROM dat')).toEqual([[expensive]]);
  }, 120_000);

  it('loads per session: another tab does not see the tables until they are loaded there', async () => {
    const before = await runFoxQuery(db.execute, session('other'), 'SELECT COUNT(*) FROM region', { maxRows: MAX_ROWS, resolveColumnKind });
    expect(before.result?.error).toMatch(/#region/);
    // The app builds the session's cursor list anew for every run, so a reset session knows the local tables again.
    const other = session('other');
    await load(other.id, ['region']);
    expect(await fox(other, 'SELECT COUNT(*) FROM region')).toEqual([[records('region').length]]);
    // Loading again replaces the copy instead of doubling it.
    await load(other.id, ['region']);
    expect(await fox(other, 'SELECT COUNT(*) FROM region')).toEqual([[records('region').length]]);
  }, 120_000);
});
