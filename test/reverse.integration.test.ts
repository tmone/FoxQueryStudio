import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { convertTsql } from '../src/converter/reverse';
import { loadFoxDatabase } from '../tools/dbf/database';
import { isLocalDbAvailable, runBatches, type SqlBatchResult } from '../tools/sqlrun';
import { isVfpAvailable, runInVfp, type VfpResult } from '../tools/vfp/oracle';
import { columnKindResolver, columnWidthResolver, importDatabase, normalizeRows } from './support/harness';

// The reverse direction: T-SQL written by a developer runs on SQL Server; the FoxPro the
// converter produces runs in a real Visual FoxPro 9 on the same Northwind data as .dbf.
// Both must return the same rows.

const FIXTURES = join('test', 'fixtures', 'northwind');
const DATABASE = 'FqsNorthwindReverse';
const SETUP_TIMEOUT_MS = 300_000;

interface Case {
  name: string;
  tsql: string;
  ordered?: boolean;
  decimals?: number;
}

const CASES: Case[] = [
  { name: 'exact case-insensitive text match', tsql: "SELECT CustomerID FROM dbo.Customers WHERE Country = 'germany' AND City <> 'Berlin' ORDER BY CustomerID" },
  { name: 'IN list and LIKE', tsql: "SELECT CustomerID FROM Customers WHERE Country IN ('UK', 'usa') AND CompanyName LIKE 'b%' ORDER BY CustomerID" },
  { name: 'string functions', tsql: "SELECT CustomerID, LEN(City) AS n, UPPER(LEFT(CompanyName, 3)) AS u, SUBSTRING(ContactName, 2, 4) AS s, CHARINDEX('a', CompanyName) AS p, LTRIM(RTRIM(Region)) + '|' AS r FROM Customers WHERE Region IS NOT NULL ORDER BY CustomerID" },
  { name: 'ISNULL, COALESCE and CASE', tsql: "SELECT CustomerID, ISNULL(Region, '-') AS r, COALESCE(Fax, Phone, '') AS f, CASE WHEN Country = 'USA' THEN 1 WHEN Country = 'UK' THEN 2 ELSE 0 END AS c FROM Customers ORDER BY CustomerID" },
  { name: 'date parts and arithmetic', tsql: "SELECT OrderID, YEAR(OrderDate) AS y, MONTH(OrderDate) AS m, DAY(OrderDate) AS d, DATEADD(day, 30, OrderDate) AS due, DATEDIFF(day, OrderDate, ShippedDate) AS lag, DATEADD(month, 1, OrderDate) AS nm FROM Orders WHERE OrderDate >= '1998-04-01' AND ShippedDate IS NOT NULL ORDER BY OrderID" },
  { name: 'date formatting', tsql: "SELECT OrderID, CONVERT(varchar(10), OrderDate, 103) AS d1, CONVERT(varchar(8), OrderDate, 112) AS d2 FROM Orders WHERE OrderID < 10260 ORDER BY OrderID" },
  { name: 'integer division and modulo', tsql: 'SELECT OrderID, ProductID, Quantity / 7 AS q, Quantity % 7 AS r, 10 / 4 AS c FROM [Order Details] WHERE OrderID < 10255 ORDER BY OrderID, ProductID' },
  { name: 'aggregates with GROUP BY and HAVING', tsql: 'SELECT CustomerID, COUNT(*) AS n, MAX(Freight) AS f FROM Orders GROUP BY CustomerID HAVING COUNT(*) >= 15 ORDER BY CustomerID', ordered: true },
  { name: 'joins', tsql: "SELECT o.OrderID, e.LastName, s.CompanyName FROM Orders o INNER JOIN Employees e ON o.EmployeeID = e.EmployeeID LEFT JOIN Shippers s ON s.ShipperID = o.ShipVia WHERE o.OrderDate = '1997-08-12' ORDER BY o.OrderID" },
  { name: 'subqueries', tsql: 'SELECT ProductID FROM Products WHERE UnitPrice > (SELECT AVG(UnitPrice) FROM Products) AND CategoryID IN (SELECT CategoryID FROM Categories WHERE CategoryName <> \'Beverages\') ORDER BY ProductID' },
  { name: 'TOP, DISTINCT and UNION', tsql: "SELECT DISTINCT Country FROM Customers WHERE Country LIKE 'S%' UNION SELECT Country FROM Suppliers WHERE Country LIKE 'S%' ORDER BY Country" },
  { name: 'bit column', tsql: 'SELECT ProductID FROM Products WHERE Discontinued = 1 ORDER BY ProductID' },
  { name: 'temp table as cursor across statements', tsql: 'SELECT o.CustomerID, SUM(d.UnitPrice * d.Quantity) AS total INTO #t FROM Orders o JOIN [Order Details] d ON d.OrderID = o.OrderID GROUP BY o.CustomerID; SELECT CustomerID, total FROM #t WHERE total > 50000 ORDER BY total DESC', ordered: true },
];

/** The .dbf names differ from Northwind on SQL Server: no space in Order Details. */
const TABLE_RENAMES: Record<string, string> = { '[Order Details]': 'orderdetails' };
const toFoxTables = (sql: string) => Object.entries(TABLE_RENAMES).reduce((s, [from, to]) => s.split(from).join(to), sql);

const available = existsSync(join(FIXTURES, 'orders.dbf')) && isLocalDbAvailable() && isVfpAvailable();

describe.skipIf(!available)('T-SQL converted to FoxPro returns the same rows in Visual FoxPro 9', () => {
  let sqlServer: Map<string, SqlBatchResult>;
  let vfp: Map<string, VfpResult>;
  const converted = new Map<string, ReturnType<typeof convertTsql>>();

  beforeAll(() => {
    const tables = loadFoxDatabase(FIXTURES);
    importDatabase(DATABASE, tables);
    // SQL Server side keeps the real Northwind spelling for one table, to exercise bracketed names.
    runBatches(DATABASE, [{ id: 'rename', sql: "EXEC sp_rename 'dbo.orderdetails', 'Order Details'" }]);
    const resolveColumnKind = columnKindResolver(tables);
    const resolveColumnWidth = columnWidthResolver(tables);

    sqlServer = new Map(runBatches(DATABASE, CASES.map((c) => ({ id: c.name, sql: c.tsql }))).map((r) => [r.id, r]));
    const scripts = CASES.map((c) => {
      const result = convertTsql(toFoxTables(c.tsql), { resolveColumnKind, resolveColumnWidth });
      converted.set(c.name, result);
      return { id: c.name, source: result.foxpro || 'SELECT 1 FROM region WHERE .F.' };
    });
    vfp = new Map(runInVfp(scripts, { database: join(FIXTURES, 'northwind.dbc') }).map((r) => [r.id, r]));
  }, SETUP_TIMEOUT_MS);

  // FQS_REPORT=1 prints the first differing rows of each case.
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    if (process.env.FQS_REPORT) {
      const a = sqlServer.get(testCase.name)!.resultSets.map((s) => normalizeRows(s.rows, true));
      const b = vfp.get(testCase.name)!.resultSets.map((s) => normalizeRows(s.rows, true));
      a.forEach((rows, s) => rows.forEach((row, r) => { if (JSON.stringify(row) !== JSON.stringify(b[s]?.[r])) console.log(`${testCase.name} row ${r + 1}: SQL ${JSON.stringify(row)} | Fox ${JSON.stringify(b[s]?.[r])}`); }));
    }
    const conversion = converted.get(testCase.name)!;
    expect(conversion.errors, 'converter errors').toEqual([]);
    const sql = sqlServer.get(testCase.name)!;
    expect(sql.error, 'SQL Server error').toBeNull();
    const fox = vfp.get(testCase.name)!;
    expect(fox.errors, `FoxPro rejected:\n${conversion.foxpro}`).toEqual([]);

    const ordered = testCase.ordered ?? true;
    const left = sql.resultSets.map((set) => normalizeRows(set.rows, ordered, testCase.decimals));
    const right = fox.resultSets.map((set) => normalizeRows(set.rows, ordered, testCase.decimals));
    expect(right, conversion.foxpro).toEqual(left);
  });
});
