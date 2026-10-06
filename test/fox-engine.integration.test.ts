import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFoxDatabase, type FoxTable } from '../src/dbf/database';
import { createFoxEngine, type FoxEngine } from '../src/main/fox-engine';
import { columnKindResolver, columnWidthResolver } from '../src/shared/column-kind';
import { runOnFoxPro, type QuerySession } from '../src/shared/run-query';
import type { CellValue, SchemaTable } from '../src/shared/types';
import { isVfpAvailable, VFP_EXE } from '../tools/vfp/oracle';

// A FoxPro database opened from disk and queried with Visual FoxPro itself, no SQL Server
// anywhere: the Northwind sample that ships with Visual FoxPro, read in both languages the
// way a query tab does. Expected values are computed from the .dbf records.

const FIXTURES = resolve('test', 'fixtures', 'northwind');
const MAX_ROWS = 5000;
const available = existsSync(join(FIXTURES, 'orders.dbf')) && isVfpAvailable();

describe.skipIf(!available)('FoxPro engine for databases opened from disk', () => {
  let engine: FoxEngine;
  let tables: FoxTable[];
  let schema: SchemaTable[];
  let resolveColumnKind: ReturnType<typeof columnKindResolver>;
  let resolveColumnWidth: ReturnType<typeof columnWidthResolver>;

  const records = (name: string) => tables.find((t) => t.name === name)!.records;
  const text = (value: unknown) => String(value).trimEnd();
  const session = (id: string): QuerySession => ({ id, cursors: [] });

  async function run(tab: QuerySession, source: string, language: 'foxpro' | 'tsql' = 'foxpro') {
    const outcome = await runOnFoxPro(engine.execute, tab, source, language, { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth });
    expect(outcome.errors, 'translation errors').toEqual([]);
    expect(outcome.result?.error, source).toBeUndefined();
    return outcome;
  }
  const rows = async (tab: QuerySession, source: string, language: 'foxpro' | 'tsql' = 'foxpro'): Promise<CellValue[][]> => (await run(tab, source, language)).result!.resultSets[0].rows;

  beforeAll(async () => {
    tables = loadFoxDatabase(FIXTURES);
    engine = createFoxEngine(() => VFP_EXE);
    await engine.openDatabase(join(FIXTURES, 'northwind.dbc'));
    schema = await engine.loadSchema();
    resolveColumnKind = columnKindResolver(schema);
    resolveColumnWidth = columnWidthResolver(schema);
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  it('lists the tables of the container with their FoxPro field types', () => {
    expect(schema.map((t) => t.name)).toEqual(tables.map((t) => t.name).sort());
    const customers = schema.find((t) => t.name === 'customers')!;
    expect(customers.schema).toBe('');
    expect(customers.columns.find((c) => c.name === 'companyname')).toMatchObject({ dataType: 'char', display: 'C(40)', maxLength: 40 });
    const orders = schema.find((t) => t.name === 'orders')!;
    expect(orders.columns.find((c) => c.name === 'orderdate')!.dataType).toMatch(/^date/);
    expect(orders.columns.find((c) => c.name === 'orderid')!.dataType).toBe('int');
  });

  it('runs FoxPro source as written, with FoxPro semantics', async () => {
    const tab = session('fox');
    expect(await rows(tab, 'SELECT COUNT(*) FROM customers')).toEqual([[records('customers').length]]);

    // "Ger" matches Germany: FoxPro compares up to the shorter string. No conversion is involved here.
    const german = records('customers').filter((c) => text(c.country).startsWith('Ger')).map((c) => text(c.customerid)).sort();
    expect(german.length).toBeGreaterThan(0);
    expect((await rows(tab, 'SELECT customerid FROM customers WHERE country = "Ger" ORDER BY 1')).map((r) => r[0])).toEqual(german);

    // Functions only FoxPro has run too, and a continued line.
    const padded = await rows(tab, 'SELECT TOP 1 PADL(ALLTRIM(customerid), 8, "*") AS ma, ;\n  EMPTY("  ") AS trong FROM customers ORDER BY customerid');
    expect(padded).toEqual([['***ALFKI', true]]);
  });

  it('keeps a cursor between runs of one tab and away from other tabs', async () => {
    const tab = session('cursor');
    const made = await run(tab, 'SELECT productname, unitprice FROM products WHERE unitprice > 50 INTO CURSOR dat');
    expect(made.result!.resultSets).toEqual([]);
    expect(tab.cursors).toEqual(['dat']);
    const expensive = records('products').filter((p) => Number(p.unitprice) > 50).length;
    expect(await rows(tab, 'SELECT COUNT(*) FROM dat')).toEqual([[expensive]]);

    const other = await engine.execute('other', 'SELECT COUNT(*) FROM dat', MAX_ROWS);
    expect(other.error).toBeDefined();
    await engine.closeSession('other');
  });

  it('runs T-SQL by turning it into FoxPro first', async () => {
    const tab = session('tsql');
    const expected = records('orders').filter((o) => o.orderdate instanceof Date && o.orderdate.getUTCFullYear() >= 1997).length;
    const outcome = await run(tab, "SELECT COUNT(*) AS n FROM dbo.orders WHERE orderdate >= '1997-01-01'", 'tsql');
    expect(outcome.translation).toBe('SELECT COUNT(*) AS n FROM orders WHERE orderdate >= {^1997-01-01}');
    expect(outcome.result!.resultSets[0]).toEqual({ columns: ['n'], rows: [[expected]] });

    // SQL Server compares text without regard to case; the FoxPro form has to keep that.
    const london = records('customers').filter((c) => text(c.city).toUpperCase() === 'LONDON').length;
    expect(london).toBeGreaterThan(0);
    expect(await rows(tab, "SELECT COUNT(*) FROM customers WHERE city = 'london'", 'tsql')).toEqual([[london]]);

    // A #temp table is a cursor of the tab.
    await run(tab, "SELECT customerid, country INTO #kh FROM customers WHERE country = 'Germany'", 'tsql');
    expect(tab.cursors).toEqual(['kh']);
    const german = records('customers').filter((c) => text(c.country) === 'Germany').length;
    expect(await rows(tab, 'SELECT COUNT(*) FROM #kh', 'tsql')).toEqual([[german]]);
  });

  it('does not run T-SQL that FoxPro has no form for, and says why', async () => {
    const outcome = await runOnFoxPro(engine.execute, session('cte'), 'WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'tsql', { maxRows: MAX_ROWS });
    expect(outcome.result).toBeUndefined();
    expect(outcome.errors[0].message).toMatch(/CTE/);
  });

  it('shows values in display form: text, numbers, dates, logicals, nulls', async () => {
    const [row] = await rows(session('values'), 'SELECT TOP 1 orderid, customerid, orderdate, freight, shipregion FROM orders ORDER BY orderid');
    const first = [...records('orders')].sort((a, b) => Number(a.orderid) - Number(b.orderid))[0];
    const date = first.orderdate as Date;
    expect(row).toEqual([first.orderid, text(first.customerid), date.toISOString().slice(0, 10), first.freight, first.shipregion === null ? null : text(first.shipregion)]);
    expect(await rows(session('values'), 'SELECT .T. AS co, {^2026-02-03 04:05:06} AS gio, 12.5 AS so, "Königlich" AS ten FROM region WHERE regionid = 1')).toEqual([[true, '2026-02-03 04:05:06', 12.5, 'Königlich']]);
  });

  it('cuts results at the row limit and returns several result sets', async () => {
    const cut = await engine.execute('limits', 'SELECT * FROM orderdetails', 10);
    expect(cut.error).toBeUndefined();
    expect(cut.truncated).toBe(true);
    expect(cut.resultSets[0].rows).toHaveLength(10);

    const several = await engine.execute('limits', 'SELECT COUNT(*) AS a FROM region\nSELECT COUNT(*) AS b FROM shippers', MAX_ROWS);
    expect(several.resultSets.map((set) => set.rows)).toEqual([[[records('region').length]], [[records('shippers').length]]]);
  });

  it('reports a FoxPro error and keeps the tab usable', async () => {
    const failed = await engine.execute('errors', 'SELECT * FROM khong_co_bang', MAX_ROWS);
    expect(failed.error).toMatch(/khong_co_bang/i);
    expect((await engine.execute('errors', 'SELECT COUNT(*) FROM region', MAX_ROWS)).resultSets[0].rows).toEqual([[records('region').length]]);
  });

  it('only reads: refuses statements that change data or write files', async () => {
    for (const source of ['DELETE FROM region', 'UPDATE region SET regiondescription = "x"', 'USE region', 'SELECT * FROM region INTO TABLE c:\\x', 'ZAP']) {
      const result = await engine.execute('readonly', source, MAX_ROWS);
      expect(result.error, source).toMatch(/Chỉ/);
    }
    expect((await engine.execute('readonly', 'SELECT COUNT(*) FROM region', MAX_ROWS)).resultSets[0].rows).toEqual([[records('region').length]]);
  });

  it('opens a folder of free tables from one of its .dbf files', async () => {
    await engine.openDatabase(join(FIXTURES, 'region.dbf'));
    const free = await engine.loadSchema();
    expect(free.map((t) => t.name)).toContain('region');
    expect((await engine.execute('free', 'SELECT COUNT(*) FROM region', MAX_ROWS)).resultSets[0].rows).toEqual([[records('region').length]]);
  }, 120_000);
});
