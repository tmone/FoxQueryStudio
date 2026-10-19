import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFoxDatabase, type FoxTable } from '../src/dbf/database';
import { execFileSync } from 'node:child_process';
import { prepareFoxBatch } from '../src/shared/fox-prepare';
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
    const expensive = records('products').filter((p) => Number(p.unitprice) > 50).length;
    // The cursor's rows are shown right away, and the cursor stays for the next statement.
    expect(made.result!.resultSets[0].rows).toHaveLength(expensive);
    expect(tab.cursors).toEqual(['dat']);
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

  it('opens a table with USE and answers SUM, COUNT, AVERAGE, CALCULATE and BROWSE on it, as FoxPro commands', async () => {
    const tab = session('xbase');
    const german = records('orders').filter((o) => text(o.shipcountry) === 'Germany');
    const freight = Number(german.reduce((sum, o) => sum + Number(o.freight), 0).toFixed(2));
    const outcome = await run(tab, 'USE orders\nSUM freight, freight * 2 FOR ALLTRIM(shipcountry) = "Germany" TO a, b\nCOUNT FOR ALLTRIM(shipcountry) = "Germany"');
    const [sums, count] = outcome.result!.resultSets;
    expect(sums.columns).toEqual(['freight', 'freight * 2']);
    expect(sums.rows).toEqual([[freight, Number((freight * 2).toFixed(2))]]);
    expect(count).toEqual({ columns: ['count'], rows: [[german.length]] });
    expect(tab.currentTable).toBe('orders');

    // The table stays current across runs; a plain SUM covers every numeric field.
    const all = await run(tab, 'SUM');
    expect(all.result!.resultSets[0].columns).toEqual(['orderid', 'employeeid', 'shipvia', 'freight']);
    expect(await rows(tab, 'BROWSE FIELDS orderid, shipcountry FOR orderid = 10248')).toEqual([[10248, 'France']]);
    expect(await rows(tab, 'CALCULATE CNT(), MAX(freight) FOR freight > 500')).toEqual([[records('orders').filter((o) => Number(o.freight) > 500).length, 1007.64]]);
    expect(await rows(tab, 'AVERAGE freight FOR orderid = 10248')).toEqual([[32.38]]);

    // The customer's check: stored amount minus the formula should sum to 0; otherwise the rows at fault are offered.
    const check = await run(tab, 'SUM freight - freight FOR orderid < 10250');
    expect(check.result!.resultSets[0].rows).toEqual([[0]]);
    expect(check.result!.messages).toEqual([]);
    const off = await run(tab, 'SUM freight - freight * 2 FOR orderid < 10250');
    expect(off.result!.messages[0]).toMatch(/^freight - freight \* 2 = -\d+(\.\d+)?, khác 0.*SELECT \*, freight - freight \* 2 AS lech FROM orders WHERE \(orderid < 10250\) AND ABS\(freight - freight \* 2\) > 0\.005$/);
    expect((await rows(tab, off.result!.messages[0].split('Liệt kê các dòng lệch: ')[1])).length).toBe(2);

    const closed = await run(tab, 'USE');
    expect(closed.result!.resultSets).toEqual([]);
    expect(tab.currentTable).toBeUndefined();
    const none = await engine.execute(tab.id, 'SUM freight', MAX_ROWS);
    expect(none.error).toMatch(/No table is open/i);
  });

  it('lets comments say anything, and refuses only statements with characters outside Windows-1252', async () => {
    expect(await rows(session('cp'), '* Thay bảng lương của tháng rồi chạy && ghi chú có dấu\nSELECT COUNT(*) FROM region')).toEqual([[records('region').length]]);
    const refused = await engine.execute('cp', 'SELECT * FROM region WHERE regiondescription = "Miền Bắc"', MAX_ROWS);
    expect(refused.error).toMatch(/ngoài bảng mã Windows-1252.*Miền Bắc/);
  });

  it("runs a customer's payroll checks as typed: parameters asked for, table found, wrong row listed", async () => {
    const folder = resolve('test', 'fixtures', 'lamthao');
    // The sample table is generated, not stored: fixtures are not in the repository.
    if (!existsSync(join(folder, 'bangluong.dbf'))) execFileSync(process.execPath, ['scripts/make-luong-sample.mjs'], { stdio: 'ignore' });
    const payroll = createFoxEngine(() => VFP_EXE);
    await payroll.openDatabase(join(folder, 'bangluong.dbf'));
    const tables = await payroll.loadSchema();
    const tab = session('lamthao');
    const asked: string[] = [];
    const typed = [
      'SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/Công chế độ*HSL',
      'SUM TCD-LC*HSDC*2700000*CD/26*0.35*HSTN',
      'SUM TTT-FTN/100*2700000*NC1/Công chế độ*HSTN',
      'SUM TIEN1-LC*HSDC*DIEM*NC1/Công chế độ*HS',
      'SUM THUONG-LC*HSDC*DIEM*(Công chế độ-CO-CTD-CDE)/Công chế độ*HSTG',
    ].join('\n');
    const prepared = await prepareFoxBatch(typed, { tables, hasWorkArea: false, ask: async (name) => (asked.push(name), '25') });
    expect(asked).toEqual(['Công chế độ']);
    expect(prepared.notes).toEqual(['Công chế độ = 25', 'Đã mở bảng bangluong (có đủ các cột của lệnh).']);
    try {
      const outcome = await runOnFoxPro(payroll.execute, tab, prepared.source, 'foxpro', { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth });
      expect(outcome.result!.error).toBeUndefined();
      // Four checks come out 0; the first finds the one row whose stored TP is 1000 too high.
      expect(outcome.result!.resultSets.map((set) => set.rows[0][0])).toEqual([1000, 0, 0, 0, 0]);
      expect(outcome.result!.resultSets[0].columns).toEqual(['TP-LC*HSDC*2700000*DIEMP/9.8*CP/(25)*HSL']);
      expect(outcome.result!.messages).toHaveLength(1);
      const listing = outcome.result!.messages[0].split('Liệt kê các dòng lệch: ')[1];
      const wrong = await runOnFoxPro(payroll.execute, tab, listing, 'foxpro', { maxRows: MAX_ROWS, resolveColumnKind, resolveColumnWidth });
      expect(wrong.result!.resultSets[0].rows.map((r) => [r[0], r[r.length - 1]])).toEqual([['NV004', 1000]]);
      expect(tab.currentTable).toBe('bangluong');
    } finally {
      await payroll.disconnect();
    }
  });

  it('shows a General (OLE) field as binary instead of failing the row', async () => {
    const outcome = await run(session('general'), 'SELECT TOP 2 categoryid, picture FROM categories ORDER BY categoryid');
    expect(outcome.result!.resultSets[0].rows).toEqual([[1, '(nhị phân)'], [2, '(nhị phân)']]);
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
    const attempts = [
      'DELETE FROM region',
      'UPDATE region SET regiondescription = "x"',
      'REPLACE regiondescription WITH "x"',
      'USE region EXCLUSIVE',
      'SELECT * FROM region INTO TABLE c:\\x',
      'ZAP',
      // Functions with side effects inside a query, and a line that mimics the request framing.
      'SELECT EXECSCRIPT("ZAP") FROM region',
      'SELECT * FROM region ;\n#S|0\nZAP',
    ];
    for (const source of attempts) {
      const result = await engine.execute('readonly', source, MAX_ROWS);
      expect(result.error, source).toMatch(/Chỉ|không được dùng|không được phép|SHARED NOUPDATE/);
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
