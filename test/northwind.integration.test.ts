import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertFoxPro } from '../src/converter';
import { loadFoxDatabase, type FoxTable } from '../src/dbf/database';
import { migratedFields } from '../src/dbf/to-sql';
import { isLocalDbAvailable, runBatches, type SqlBatchResult } from '../tools/sqlrun';
import { isVfpAvailable, runInVfp, type VfpResult } from '../tools/vfp/oracle';
import { CASES, DEVIATIONS, type Tables } from './northwind/cases';
import { columnKindResolver, importDatabase, normalizeRows } from './support/harness';

// End-to-end check of the conversion logic on a real FoxPro database:
//   1. read the Visual FoxPro Northwind tables (.dbf/.fpt/.dbc),
//   2. migrate them to SQL Server LocalDB,
//   3. run FoxPro queries through the converter and compare every row with the
//      result computed straight from the .dbf data.
// Fetch the fixtures first: node scripts/fetch-northwind.mjs

const FIXTURES = join('test', 'fixtures', 'northwind');
const DATABASE = 'FqsNorthwind';
const IMPORT_TIMEOUT_MS = 180_000;
const available = existsSync(join(FIXTURES, 'orders.dbf')) && isLocalDbAvailable();

describe.skipIf(!available)('FoxPro Northwind migrated to SQL Server', () => {
  let tables: FoxTable[];
  let data: Tables;
  let results: Map<string, SqlBatchResult>;
  const converted = new Map<string, ReturnType<typeof convertFoxPro>>();

  beforeAll(() => {
    tables = loadFoxDatabase(FIXTURES);
    data = Object.fromEntries(tables.map((t) => [t.name, t.records]));

    importDatabase(DATABASE, tables);
    const resolveColumnKind = columnKindResolver(tables);

    const batches = [
      ...tables.map((t) => ({ id: `table ${t.name}`, sql: `SELECT ${migratedFields(t).map((f) => `[${f.name}]`).join(', ')} FROM dbo.[${t.name}]` })),
      ...[...CASES, ...DEVIATIONS].map((c) => {
        const result = convertFoxPro(c.fox, { resolveColumnKind });
        converted.set(c.name, result);
        return { id: `case ${c.name}`, sql: result.sql || 'SELECT 1 WHERE 1 = 0' };
      }),
    ];
    results = new Map(runBatches(DATABASE, batches).map((r) => [r.id, r]));
  }, IMPORT_TIMEOUT_MS);

  describe('migration', () => {
    it('reads the standard Northwind row counts from the .dbf files', () => {
      const counts = Object.fromEntries(tables.map((t) => [t.name, t.records.length]));
      expect(counts).toEqual({
        categories: 8, customers: 91, employees: 9, employeeterritories: 49, orderdetails: 2155, orders: 830,
        products: 77, region: 4, shippers: 3, suppliers: 29, territories: 53,
      });
    });

    it('restores long field names from the database container', () => {
      expect(tables.find((t) => t.name === 'orders')!.fields.map((f) => f.name)).toEqual([
        'orderid', 'customerid', 'employeeid', 'orderdate', 'requireddate', 'shippeddate', 'shipvia', 'freight',
        'shipname', 'shipaddress', 'shipcity', 'shipregion', 'shippostalcode', 'shipcountry',
      ]);
    });

    it('matches well-known Northwind facts', () => {
      const revenue = data.orderdetails.reduce((total, d) => total + d.unitprice * d.quantity * (1 - d.discount), 0);
      expect(revenue).toBeCloseTo(1265793.04, 1);
      expect(data.products.filter((p) => p.discontinued).map((p) => p.productid)).toEqual([5, 9, 17, 24, 28, 29, 42, 53]);
      expect(data.orders.find((o) => o.orderid === 10248)).toMatchObject({ customerid: 'VINET', orderdate: new Date(Date.UTC(1996, 6, 4)) });
      expect(data.customers.filter((c) => !data.orders.some((o) => o.customerid === c.customerid)).map((c) => c.customerid)).toEqual(['FISSA', 'PARIS']);
    });

    it('stores every cell of every table unchanged in SQL Server', () => {
      for (const table of tables) {
        const result = results.get(`table ${table.name}`)!;
        expect(result.error, table.name).toBeNull();
        const fields = migratedFields(table);
        const expected = table.records.map((record) => fields.map((f) => record[f.name]));
        expect(normalizeRows(result.resultSets[0].rows, false), table.name).toEqual(normalizeRows(expected, false));
      }
    });
  });

  describe.skipIf(!isVfpAvailable())('converted queries return the same rows as a real Visual FoxPro 9', () => {
    let vfp: Map<string, VfpResult>;

    beforeAll(() => {
      const scripts = [...CASES, ...DEVIATIONS].map((c) => ({ id: c.name, source: c.fox }));
      vfp = new Map(runInVfp(scripts, { database: join(FIXTURES, 'northwind.dbc') }).map((r) => [r.id, r]));
      // FQS_DUMP=<file> saves both sides for inspecting a mismatch row by row.
      if (process.env.FQS_DUMP) {
        const dump = CASES.map((c) => ({
          name: c.name,
          sql: converted.get(c.name)!.sql,
          foxPro: vfp.get(c.name),
          sqlServer: results.get(`case ${c.name}`),
        }));
        writeFileSync(process.env.FQS_DUMP, JSON.stringify(dump, null, 1));
      }
    }, IMPORT_TIMEOUT_MS);

    it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
      const oracle = vfp.get(testCase.name)!;
      expect(oracle.errors, 'FoxPro errors').toEqual([]);

      const ordered = testCase.ordered ?? true;
      const sqlServer = results.get(`case ${testCase.name}`)!.resultSets.map((set) => normalizeRows(set.rows, ordered, testCase.decimals));
      const foxPro = oracle.resultSets.map((set) => normalizeRows(set.rows, ordered, testCase.decimals));
      expect(sqlServer, converted.get(testCase.name)!.sql).toEqual(foxPro);
    });

    // Each documented difference must still be observable; a pass here that turns into a
    // failure means the README list is out of date.
    it.each(DEVIATIONS.map((d) => [d.name, d] as const))('still differs as documented: %s', (_name, deviation) => {
      const oracle = vfp.get(deviation.name)!;
      const result = results.get(`case ${deviation.name}`)!;
      expect(oracle.errors, 'FoxPro errors').toEqual([]);
      expect(result.error, 'SQL Server error').toBeNull();
      const sqlServer = result.resultSets.map((set) => normalizeRows(set.rows, true));
      const foxPro = oracle.resultSets.map((set) => normalizeRows(set.rows, true));
      expect(sqlServer, deviation.reason).not.toEqual(foxPro);
    });
  });

  describe('converted queries return the same rows as FoxPro semantics', () => {
    it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
      const conversion = converted.get(testCase.name)!;
      expect(conversion.errors, 'converter errors').toEqual([]);

      const result = results.get(`case ${testCase.name}`)!;
      expect(result.error, `SQL Server rejected:\n${conversion.sql}`).toBeNull();

      const ordered = testCase.ordered ?? true;
      const actual = result.resultSets.map((set) => normalizeRows(set.rows, ordered, testCase.decimals));
      const expected = testCase.expected(data).map((rows) => normalizeRows(rows, ordered, testCase.decimals));
      expect(actual, conversion.sql).toEqual(expected);
    });
  });
});
