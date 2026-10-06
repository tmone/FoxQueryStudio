import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFoxDatabase, type FoxTable } from '../src/dbf/database';
import { openLocalDatabase } from '../src/main/local-db';
import { createLocalEngine, type LocalEngine } from '../src/main/local-engine';
import { columnKindResolver, columnWidthResolver } from '../src/shared/column-kind';
import type { LocalDatabase } from '../src/shared/local-db';
import { runFoxQuery, runTsqlQuery, type QuerySession } from '../src/shared/run-query';
import type { CellValue, SchemaTable } from '../src/shared/types';
import { isLocalDbAvailable } from '../tools/sqlrun';

// The app's own engine for local FoxPro databases, with no server connection involved:
// the Northwind sample that ships with Visual FoxPro is opened from its folder and read in
// both languages the way a query tab does. Expected values come from the .dbf records.

const FIXTURES = join('test', 'fixtures', 'northwind');
const MAX_ROWS = 5000;
const available = existsSync(join(FIXTURES, 'orders.dbf')) && isLocalDbAvailable();

describe.skipIf(!available)('local engine for FoxPro databases', () => {
  let engine: LocalEngine;
  let tables: FoxTable[];
  let opened: LocalDatabase;
  let schema: SchemaTable[];
  let resolveColumnKind: ReturnType<typeof columnKindResolver>;
  let resolveColumnWidth: ReturnType<typeof columnWidthResolver>;

  const records = (name: string) => tables.find((t) => t.name === name)!.records;
  const text = (value: unknown) => String(value).trimEnd();
  const session = (id: string): QuerySession => ({ id, cursors: [] });

  async function fox(tab: QuerySession, source: string): Promise<CellValue[][]> {
    const outcome = await runFoxQuery(engine.execute, tab, source, { maxRows: MAX_ROWS, resolveColumnKind });
    expect(outcome.conversion.errors, 'converter errors').toEqual([]);
    expect(outcome.result?.error, outcome.conversion.sql).toBeUndefined();
    return outcome.result!.resultSets[0].rows;
  }

  beforeAll(async () => {
    tables = loadFoxDatabase(FIXTURES);
    engine = createLocalEngine();
    opened = await openLocalDatabase(engine, FIXTURES);
    schema = await engine.loadSchema();
    resolveColumnKind = columnKindResolver(schema);
    resolveColumnWidth = columnWidthResolver(schema);
  }, 180_000);

  afterAll(async () => {
    await engine?.disconnect();
    engine?.shutdown();
  });

  it('loads every table of the folder and reports what it left out', () => {
    expect(opened).toMatchObject({ name: 'FoxQuery_northwind', tableCount: tables.length, rowCount: tables.reduce((sum, t) => sum + t.records.length, 0) });
    expect(opened.notes).toContain('employees: bỏ cột kiểu nhị phân photo');
  });

  it('lists the tables with the long field names of the .dbc', () => {
    expect(schema.map((t) => t.name).sort()).toEqual(tables.map((t) => t.name).sort());
    const customers = schema.find((t) => t.name === 'customers')!;
    expect(customers.columns.find((c) => c.name === 'companyname')).toMatchObject({ dataType: 'nchar' });
    expect(schema.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'orderdate')!.dataType).toMatch(/^date/);
  });

  it('answers FoxPro source', async () => {
    const tab = session('fox');
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
  });

  it('answers T-SQL on the same tables and gives its FoxPro form', async () => {
    const tab = session('tsql');
    const expected = records('orders').filter((o) => o.orderdate instanceof Date && o.orderdate.getUTCFullYear() >= 1997).length;
    expect(expected).toBeGreaterThan(0);

    const outcome = await runTsqlQuery(engine.execute, tab, "SELECT COUNT(*) FROM dbo.orders WHERE orderdate >= '1997-01-01'", { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth });
    expect(outcome.result?.error).toBeUndefined();
    expect(outcome.result!.resultSets[0].rows).toEqual([[expected]]);
    expect(outcome.conversion.errors).toEqual([]);
    expect(outcome.conversion.foxpro).toBe('SELECT COUNT(*) FROM orders WHERE orderdate >= {^1997-01-01}');
    // The FoxPro form, run through the other direction, reads the same rows.
    expect(await fox(tab, outcome.conversion.foxpro)).toEqual([[expected]]);
  });

  it('keeps a cursor between runs of one tab and away from other tabs', async () => {
    const tab = session('cursor');
    const made = await runFoxQuery(engine.execute, tab, 'SELECT productname, unitprice FROM products WHERE unitprice > 50 INTO CURSOR dat', { maxRows: MAX_ROWS, resolveColumnKind });
    expect(made.result?.error).toBeUndefined();
    expect(tab.cursors).toEqual(['dat']);
    const expensive = records('products').filter((p) => Number(p.unitprice) > 50).length;
    expect(await fox(tab, 'SELECT COUNT(*) FROM dat')).toEqual([[expensive]]);

    const other = await engine.execute('other', 'SELECT COUNT(*) FROM #dat', MAX_ROWS);
    expect(other.error).toMatch(/#dat/);
    await engine.closeSession('other');
  });

  it('formats values like the server driver: text, numbers, dates, bits, nulls', async () => {
    const result = await engine.execute(
      'values',
      "SELECT N'Nguyễn Thị Ỷ' AS ten, CAST(12.5 AS decimal(9,2)) AS so, CAST(7 AS int) AS nguyen, CAST('2026-02-03' AS date) AS ngay, CAST('2026-02-03 04:05:06' AS datetime) AS gio, CAST(1 AS bit) AS co, CAST(NULL AS int) AS rong, CAST(0x00FF10 AS varbinary(3)) AS nhi",
      MAX_ROWS,
    );
    expect(result.error).toBeUndefined();
    expect(result.resultSets[0].columns).toEqual(['ten', 'so', 'nguyen', 'ngay', 'gio', 'co', 'rong', 'nhi']);
    expect(result.resultSets[0].rows).toEqual([['Nguyễn Thị Ỷ', 12.5, 7, '2026-02-03', '2026-02-03 04:05:06', true, null, '0x00ff10']]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('cuts results at the row limit, returns several result sets and server messages', async () => {
    const cut = await engine.execute('limits', 'SELECT * FROM orderdetails', 10);
    expect(cut.error).toBeUndefined();
    expect(cut.truncated).toBe(true);
    expect(cut.resultSets[0].rows).toHaveLength(10);

    const several = await engine.execute('limits', "PRINT N'xin chào'; SELECT 1 AS a; SELECT 2 AS b, 3 AS c", MAX_ROWS);
    expect(several.resultSets.map((set) => set.rows)).toEqual([[[1]], [[2, 3]]]);
    expect(several.messages).toEqual(['xin chào']);
  });

  it('reports a server error and keeps the session usable', async () => {
    const failed = await engine.execute('errors', 'SELECT * FROM khong_co_bang', MAX_ROWS);
    expect(failed.error).toMatch(/khong_co_bang/);
    expect(failed.sessionReset).toBeUndefined();
    expect((await engine.execute('errors', 'SELECT 1', MAX_ROWS)).resultSets[0].rows).toEqual([[1]]);
  });

  it('reopening a folder replaces the database instead of adding to it', async () => {
    await openLocalDatabase(engine, FIXTURES);
    expect(await fox(session('again'), 'SELECT COUNT(*) FROM region')).toEqual([[records('region').length]]);
  }, 180_000);
});
