import * as fox from './fox';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;
export type Cell = string | number | boolean | Date | null;

export interface Case {
  name: string;
  /** FoxPro source, as a FoxPro developer would type it. */
  fox: string;
  /** Expected rows of every result set, computed from the .dbf data. */
  expected: (t: Tables) => Cell[][][];
  /** False when the statement gives no row order guarantee. */
  ordered?: boolean;
  /** Decimal places compared, when FoxPro's own rounding makes 4 too strict. */
  decimals?: number;
}

/** A FoxPro statement whose SQL Server result is known to differ, and why. */
export interface Deviation {
  name: string;
  fox: string;
  reason: string;
}

const compare = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);
/** Sorts by key functions, comparing strings by code unit like SET COLLATE MACHINE. */
const by = <T>(...keys: ((row: T) => any)[]) => (a: T, b: T) => {
  for (const key of keys) {
    const order = compare(key(a), key(b));
    if (order) return order;
  }
  return 0;
};
const desc = <T>(key: (row: T) => number) => (row: T) => -key(row);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** Applies `f` unless the value is NULL, which FoxPro functions propagate. */
const nn = <T, R>(value: T | null, f: (v: T) => R): R | null => (value === null ? null : f(value));
const eq = (field: string | null, value: string) => field !== null && fox.rtrim(field) === value;
const groupBy = <T>(rows: T[], key: (row: T) => any) => {
  const groups = new Map<any, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()];
};
const one = (rows: Cell[][]) => [rows];

export const CASES: Case[] = [
  {
    name: 'filters on a padded character field with ==',
    fox: 'SELECT customerid, companyname, city FROM customers WHERE country == "Germany" ORDER BY customerid',
    expected: (t) =>
      one(t.customers.filter((c) => eq(c.country, 'Germany')).sort(by((c) => c.customerid)).map((c) => [c.customerid, c.companyname, c.city])),
  },
  {
    name: 'trims, concatenates and measures fixed-width strings',
    fox: 'SELECT customerid, ALLTRIM(contactname) + " (" + ALLTRIM(city) + ")" AS who, UPPER(country) AS ctry, LEN(city) AS w, LEN(ALLTRIM(city)) AS n, LOWER(LEFT(companyname, 5)) AS lo FROM customers ORDER BY customerid',
    expected: (t) =>
      one(
        [...t.customers].sort(by((c) => c.customerid)).map((c) => [
          c.customerid,
          c.contactname === null || c.city === null ? null : `${fox.alltrim(c.contactname)} (${fox.alltrim(c.city)})`,
          nn(c.country, fox.upper),
          nn(c.city, (s: string) => s.length),
          nn(c.city, (s: string) => fox.alltrim(s).length),
          fox.lower(fox.left(c.companyname, 5)),
        ]),
      ),
  },
  {
    name: 'searches case-sensitively with SUBSTR, AT, ATC and $',
    fox: 'SELECT customerid, SUBSTR(companyname, 2, 3) AS s, SUBSTR(customerid, 3) AS tail, RIGHT(ALLTRIM(companyname), 3) AS r, AT("a", companyname) AS p, ATC("A", companyname) AS pc, AT("z", companyname) AS z FROM customers WHERE "an" $ companyname ORDER BY customerid',
    expected: (t) =>
      one(
        t.customers
          .filter((c) => fox.contains('an', c.companyname))
          .sort(by((c) => c.customerid))
          .map((c) => [
            c.customerid,
            fox.substr(c.companyname, 2, 3),
            fox.substr(c.customerid, 3),
            fox.right(fox.alltrim(c.companyname), 3),
            fox.at('a', c.companyname),
            fox.atc('A', c.companyname),
            fox.at('z', c.companyname),
          ]),
      ),
  },
  {
    name: 'treats $ as case-sensitive',
    fox: 'SELECT COUNT(*) AS n FROM customers WHERE "LA" $ companyname\nSELECT COUNT(*) AS n FROM customers WHERE "la" $ companyname',
    expected: (t) => [
      [[t.customers.filter((c) => fox.contains('LA', c.companyname)).length]],
      [[t.customers.filter((c) => fox.contains('la', c.companyname)).length]],
    ],
  },
  {
    name: 'pads and formats with PADL, PADR, STR, VAL, TRANSFORM',
    fox: 'SELECT productid, PADL(productid, 5, "0") AS code, PADR(ALLTRIM(productname), 8, ".") AS nm, PADL(ALLTRIM(productname), 6) AS cut, STR(unitprice, 8, 2) AS price, STR(unitsinstock) AS st, VAL(STR(unitprice, 8, 2)) AS v, PADR(TRANSFORM(productid), 4) AS tx, PADL(ALLTRIM(productname), 12, "xy") AS fill FROM products ORDER BY productid',
    expected: (t) =>
      one(
        [...t.products].sort(by((p) => p.productid)).map((p) => [
          p.productid,
          fox.padl(p.productid, 5, '0'),
          fox.padr(fox.alltrim(p.productname), 8, '.'),
          fox.padl(fox.alltrim(p.productname), 6),
          nn(p.unitprice, (v: number) => fox.str(v, 8, 2)),
          nn(p.unitsinstock, (v: number) => fox.str(v)),
          p.unitprice,
          String(p.productid),
          fox.padl(fox.alltrim(p.productname), 12, 'xy'),
        ]),
      ),
  },
  {
    name: 'handles NULL with NVL, EMPTY, ISNULL, IIF, ICASE, INLIST, BETWEEN',
    fox: 'SELECT customerid, PADR(NVL(region, "(none)") + "|", 20) AS rg, PADR(IIF(EMPTY(NVL(fax, "")), "no fax", "fax"), 6) AS f, PADR(ICASE(ISNULL(region), "null", EMPTY(region), "blank", "set"), 5) AS st FROM customers WHERE INLIST(country, "UK", "USA", "Brazil") AND BETWEEN(customerid, "A", "M") ORDER BY customerid',
    expected: (t) =>
      one(
        t.customers
          .filter((c) => ['UK', 'USA', 'Brazil'].some((v) => eq(c.country, v)) && c.customerid >= 'A' && fox.rtrim(c.customerid) <= 'M')
          .sort(by((c) => c.customerid))
          .map((c) => [
            c.customerid,
            `${c.region ?? '(none)'}|`,
            fox.empty(c.fax ?? '') ? 'no fax' : 'fax',
            c.region === null ? 'null' : fox.empty(c.region) ? 'blank' : 'set',
          ]),
      ),
  },
  {
    name: 'extracts date parts and moves by months',
    fox: 'SELECT orderid, DTOC(orderdate) AS d, DTOS(orderdate) AS s, YEAR(orderdate) AS y, MONTH(orderdate) AS m, DAY(orderdate) AS dd, DOW(orderdate) AS w, GOMONTH(orderdate, 1) AS nx, GOMONTH(orderdate, -14) AS pv, GOMONTH({^1998-01-31}, 1) AS eom FROM orders WHERE orderdate >= {^1998-04-29} ORDER BY orderid',
    expected: (t) =>
      one(
        t.orders
          .filter((o) => o.orderdate !== null && o.orderdate >= fox.date(1998, 4, 29))
          .sort(by((o) => o.orderid))
          .map((o) => [
            o.orderid,
            fox.dtoc(o.orderdate),
            fox.dtos(o.orderdate),
            fox.year(o.orderdate),
            fox.month(o.orderdate),
            fox.day(o.orderdate),
            fox.dow(o.orderdate),
            fox.gomonth(o.orderdate, 1),
            fox.gomonth(o.orderdate, -14),
            fox.date(1998, 2, 28),
          ]),
      ),
  },
  {
    name: 'does date arithmetic in days',
    fox: 'SELECT orderid, shippeddate - orderdate AS days, orderdate + 30 AS due, requireddate - 7 AS warn, {^1998-12-31} - orderdate AS age FROM orders WHERE shippeddate - orderdate > 30 ORDER BY orderid',
    expected: (t) =>
      one(
        t.orders
          .filter((o) => o.shippeddate !== null && fox.daysBetween(o.shippeddate, o.orderdate) > 30)
          .sort(by((o) => o.orderid))
          .map((o) => [
            o.orderid,
            fox.daysBetween(o.shippeddate, o.orderdate),
            fox.addDays(o.orderdate, 30),
            fox.addDays(o.requireddate, -7),
            fox.daysBetween(fox.date(1998, 12, 31), o.orderdate),
          ]),
      ),
  },
  {
    name: 'does datetime arithmetic in seconds',
    fox: 'SELECT {^1998-01-02 10:00:00} - {^1998-01-01 09:59:30} AS secs, {^1998-01-01 23:59:59} + 2 AS nx FROM region WHERE regionid = 1',
    expected: () => one([[86_430, fox.addSeconds(new Date(Date.UTC(1998, 0, 1, 23, 59, 59)), 2)]]),
  },
  {
    name: 'tests empty and null dates',
    fox: [
      'SELECT COUNT(*) AS n FROM orders WHERE EMPTY(shippeddate)',
      'SELECT COUNT(*) AS n FROM orders WHERE NOT EMPTY(shippeddate)',
      'SELECT COUNT(*) AS n FROM orders WHERE ISNULL(shippeddate)',
      'SELECT COUNT(*) AS n FROM orders WHERE NOT ISNULL(shippeddate) AND shippeddate > requireddate',
    ].join('\n'),
    expected: (t) => [
      // A NULL date is not empty in FoxPro, and SQL Server cannot store an empty one.
      [[0]],
      [[t.orders.length]],
      [[t.orders.filter((o) => o.shippeddate === null).length]],
      [[t.orders.filter((o) => o.shippeddate !== null && o.shippeddate > o.requireddate).length]],
    ],
  },
  {
    name: 'never treats NULL as EMPTY for text, numbers and logical values',
    fox: [
      'SELECT COUNT(*) AS n FROM customers WHERE EMPTY(fax)',
      'SELECT COUNT(*) AS n FROM customers WHERE NOT EMPTY(fax)',
      'SELECT COUNT(*) AS n FROM customers WHERE EMPTY(NVL(fax, ""))',
      'SELECT COUNT(*) AS n FROM customers WHERE ISNULL(region) OR EMPTY(region)',
      'SELECT COUNT(*) AS n FROM products WHERE EMPTY(unitsonorder)',
      'SELECT COUNT(*) AS n FROM employees WHERE !EMPTY(reportsto)',
      'SELECT COUNT(*) AS n FROM products WHERE EMPTY(discontinued)',
    ].join('\n'),
    expected: (t) => [
      [[t.customers.filter((c) => fox.empty(c.fax)).length]],
      [[t.customers.filter((c) => !fox.empty(c.fax)).length]],
      [[t.customers.filter((c) => fox.empty(c.fax ?? '')).length]],
      [[t.customers.filter((c) => c.region === null || fox.empty(c.region)).length]],
      [[t.products.filter((p) => fox.empty(p.unitsonorder)).length]],
      [[t.employees.filter((e) => !fox.empty(e.reportsto)).length]],
      [[t.products.filter((p) => fox.empty(p.discontinued)).length]],
    ],
  },
  {
    name: 'uses logical fields as bare conditions',
    fox: [
      'SELECT productid FROM products WHERE discontinued ORDER BY productid',
      'SELECT productid FROM products WHERE !discontinued AND unitsinstock = 0 ORDER BY productid',
      'SELECT productid, IIF(discontinued, "stop", "sell") AS s FROM products WHERE discontinued = .T. OR (NOT discontinued AND unitprice > 100) ORDER BY productid',
    ].join('\n'),
    expected: (t) => {
      const products = [...t.products].sort(by((p) => p.productid));
      return [
        products.filter((p) => p.discontinued).map((p) => [p.productid]),
        products.filter((p) => !p.discontinued && p.unitsinstock === 0).map((p) => [p.productid]),
        products.filter((p) => p.discontinued || p.unitprice > 100).map((p) => [p.productid, p.discontinued ? 'stop' : 'sell']),
      ];
    },
  },
  {
    name: 'computes arithmetic without integer division',
    fox: 'SELECT orderid, productid, unitprice * quantity * (1 - discount) AS amount, quantity / 7 AS wk, MOD(quantity, 7) AS rem, MOD(-quantity, 7) AS nrem, INT(unitprice) AS ip, INT(-unitprice) AS nip, ROUND(unitprice * 1.1, 1) AS up FROM orderdetails WHERE orderid <= 10255 ORDER BY orderid, productid',
    expected: (t) =>
      one(
        t.orderdetails
          .filter((d) => d.orderid <= 10255)
          .sort(by((d) => d.orderid, (d) => d.productid))
          .map((d) => [
            d.orderid,
            d.productid,
            d.unitprice * d.quantity * (1 - d.discount),
            d.quantity / 7,
            fox.mod(d.quantity, 7),
            fox.mod(-d.quantity, 7),
            fox.int(d.unitprice),
            fox.int(-d.unitprice),
            fox.round(d.unitprice * 1.1, 1),
          ]),
      ),
  },
  {
    name: 'divides integer columns as decimals',
    fox: 'SELECT productid, unitsinstock / 3 AS third, (unitsinstock + unitsonorder) / 2 AS half FROM products ORDER BY productid',
    expected: (t) =>
      one([...t.products].sort(by((p) => p.productid)).map((p) => [p.productid, p.unitsinstock / 3, (p.unitsinstock + p.unitsonorder) / 2])),
  },
  {
    name: 'aggregates a whole table',
    fox: 'SELECT COUNT(*) AS n, SUM(freight) AS total, AVG(freight) AS av, MIN(orderdate) AS first, MAX(orderdate) AS last, COUNT(shippeddate) AS shipped FROM orders',
    expected: (t) => {
      const dates = t.orders.map((o) => o.orderdate.getTime());
      const freight = t.orders.map((o) => o.freight);
      return one([
        [
          t.orders.length,
          sum(freight),
          sum(freight) / freight.length,
          new Date(Math.min(...dates)),
          new Date(Math.max(...dates)),
          t.orders.filter((o) => o.shippeddate !== null).length,
        ],
      ]);
    },
  },
  {
    name: 'averages an integer field as an integer and an expression as a decimal',
    fox: 'SELECT productid, AVG(quantity) AS aq, AVG(quantity + 0) AS ax, SUM(quantity) AS sq, COUNT(*) AS n, MAX(discount) AS md FROM orderdetails GROUP BY productid ORDER BY productid',
    expected: (t) =>
      one(
        groupBy(t.orderdetails, (d) => d.productid)
          .sort(by(([id]) => id))
          .map(([id, rows]) => {
            const quantity = rows.map((d) => d.quantity);
            return [id, Math.trunc(sum(quantity) / rows.length), sum(quantity) / rows.length, sum(quantity), rows.length, Math.max(...rows.map((d) => d.discount))];
          }),
      ),
  },
  {
    name: 'counts non-null and distinct values',
    fox: 'SELECT COUNT(region) AS r, COUNT(DISTINCT country) AS c FROM customers',
    expected: (t) => one([[t.customers.filter((c) => c.region !== null).length, new Set(t.customers.map((c) => c.country)).size]]),
  },
  {
    name: 'sums an expression over every order line',
    // FoxPro rounds each currency product to 4 decimals, so the total drifts from the exact sum.
    decimals: 1,
    fox: 'SELECT SUM(unitprice * quantity * (1 - discount)) AS revenue FROM orderdetails',
    expected: (t) => one([[sum(t.orderdetails.map((d) => d.unitprice * d.quantity * (1 - d.discount)))]]),
  },
  {
    name: 'joins with a WHERE clause and filters groups with HAVING',
    fox: 'SELECT c.customerid, COUNT(*) AS orders FROM customers c, orders o WHERE c.customerid = o.customerid GROUP BY c.customerid HAVING COUNT(*) >= 15 ORDER BY 2 DESC, 1',
    expected: (t) =>
      one(
        groupBy(t.orders, (o) => o.customerid)
          .map(([id, rows]) => [id, rows.length] as [string, number])
          .filter(([, n]) => n >= 15)
          .sort(by(desc(([, n]) => n), ([id]) => id)),
      ),
  },
  {
    name: 'joins three tables with INNER JOIN',
    fox: 'SELECT o.orderid, ALLTRIM(e.firstname) + " " + ALLTRIM(e.lastname) AS emp, s.companyname FROM orders o INNER JOIN employees e ON o.employeeid = e.employeeid INNER JOIN shippers s ON o.shipvia = s.shipperid WHERE o.orderdate = {^1997-08-12} ORDER BY o.orderid',
    expected: (t) =>
      one(
        t.orders
          .filter((o) => o.orderdate.getTime() === fox.date(1997, 8, 12).getTime())
          .sort(by((o) => o.orderid))
          .map((o) => {
            const e = t.employees.find((x) => x.employeeid === o.employeeid)!;
            const s = t.shippers.find((x) => x.shipperid === o.shipvia)!;
            return [o.orderid, `${fox.alltrim(e.firstname)} ${fox.alltrim(e.lastname)}`, s.companyname];
          }),
      ),
  },
  {
    name: 'finds unmatched rows with LEFT OUTER JOIN',
    fox: 'SELECT c.customerid, COUNT(o.orderid) AS n FROM customers c LEFT OUTER JOIN orders o ON c.customerid = o.customerid GROUP BY c.customerid HAVING COUNT(o.orderid) = 0 ORDER BY c.customerid',
    expected: (t) =>
      one(
        t.customers
          .filter((c) => !t.orders.some((o) => o.customerid === c.customerid))
          .sort(by((c) => c.customerid))
          .map((c) => [c.customerid, 0]),
      ),
  },
  {
    name: 'self-joins and falls back with NVL',
    fox: 'SELECT e.employeeid, NVL(ALLTRIM(m.lastname), "-") AS boss FROM employees e LEFT JOIN employees m ON e.reportsto = m.employeeid ORDER BY e.employeeid',
    expected: (t) =>
      one(
        [...t.employees].sort(by((e) => e.employeeid)).map((e) => {
          const boss = t.employees.find((m) => m.employeeid === e.reportsto);
          return [e.employeeid, boss ? fox.alltrim(boss.lastname) : '-'];
        }),
      ),
  },
  {
    name: 'uses scalar, IN and NOT IN subqueries',
    fox: [
      'SELECT productid, productname FROM products WHERE unitprice > (SELECT AVG(unitprice) FROM products) ORDER BY productid',
      'SELECT customerid FROM customers WHERE customerid IN (SELECT customerid FROM orders WHERE YEAR(orderdate) = 1998 AND freight > 500) ORDER BY customerid',
      'SELECT shipperid FROM shippers WHERE shipperid NOT IN (SELECT shipvia FROM orders WHERE orderdate > {^1998-05-05}) ORDER BY shipperid',
    ].join('\n'),
    expected: (t) => {
      const average = sum(t.products.map((p) => p.unitprice)) / t.products.length;
      const big = new Set(t.orders.filter((o) => fox.year(o.orderdate) === 1998 && o.freight > 500).map((o) => o.customerid));
      const late = new Set(t.orders.filter((o) => o.orderdate > fox.date(1998, 5, 5)).map((o) => o.shipvia));
      return [
        t.products.filter((p) => p.unitprice > average).sort(by((p) => p.productid)).map((p) => [p.productid, p.productname]),
        t.customers.filter((c) => big.has(c.customerid)).sort(by((c) => c.customerid)).map((c) => [c.customerid]),
        t.shippers.filter((s) => !late.has(s.shipperid)).sort(by((s) => s.shipperid)).map((s) => [s.shipperid]),
      ];
    },
  },
  {
    name: 'supports DISTINCT, TOP and UNION',
    fox: [
      'SELECT DISTINCT country FROM customers ORDER BY country',
      'SELECT TOP 5 productid, productname, unitprice FROM products ORDER BY unitprice DESC, productid',
      'SELECT city FROM customers WHERE country = "UK" UNION SELECT city FROM suppliers WHERE country = "UK" ORDER BY 1',
    ].join('\n'),
    expected: (t) => [
      [...new Set(t.customers.map((c) => c.country as string))].sort().map((country) => [country]),
      [...t.products].sort(by(desc((p) => p.unitprice), (p) => p.productid)).slice(0, 5).map((p) => [p.productid, p.productname, p.unitprice]),
      [...new Set([...t.customers, ...t.suppliers].filter((r) => eq(r.country, 'UK')).map((r) => fox.rtrim(r.city)))].sort().map((city) => [city]),
    ],
  },
  {
    name: 'chains cursors, names unnamed columns, and reads them with BROWSE',
    ordered: false,
    fox: [
      'SELECT o.customerid, SUM(d.unitprice * d.quantity) AS total, COUNT(*), MAX(d.quantity) AS biggest ;',
      '  FROM orders o, orderdetails d WHERE o.orderid = d.orderid GROUP BY o.customerid INTO CURSOR curTotals',
      'SELECT c.companyname, t.total, t.cnt, t.biggest FROM curTotals t INNER JOIN customers c ON c.customerid = t.customerid ;',
      '  WHERE t.total > 50000 INTO CURSOR curTop',
      'BROWSE',
      'SELECT curTotals',
      'BROWSE FIELDS customerid, total FOR total < 500',
    ].join('\n'),
    expected: (t) => {
      const totals = groupBy(t.orders, (o) => o.customerid).map(([id, orders]) => {
        const lines = t.orderdetails.filter((d) => orders.some((o) => o.orderid === d.orderid));
        return { id, total: sum(lines.map((d) => d.unitprice * d.quantity)), cnt: lines.length, biggest: Math.max(...lines.map((d) => d.quantity)) };
      });
      const name = (id: string) => t.customers.find((c) => c.customerid === id)!.companyname;
      return [
        totals.filter((x) => x.total > 50000).map((x) => [name(x.id), x.total, x.cnt, x.biggest]),
        totals.filter((x) => x.total < 500).map((x) => [x.id, x.total]),
      ];
    },
  },
  {
    name: 'compares and changes case of accented text',
    fox: [
      'SELECT customerid, UPPER(companyname) AS u FROM customers WHERE "ö" $ companyname OR companyname = "Antonio Moreno Taquería" ORDER BY customerid',
      'SELECT productid, UPPER(productname) AS u, LOWER(productname) AS l FROM products WHERE "ß" $ productname OR "ä" $ productname ORDER BY productid',
    ].join('\n'),
    expected: (t) => [
      t.customers
        .filter((c) => fox.contains('ö', c.companyname) || eq(c.companyname, 'Antonio Moreno Taquería'))
        .sort(by((c) => c.customerid))
        .map((c) => [c.customerid, fox.upper(c.companyname)]),
      t.products
        .filter((p) => fox.contains('ß', p.productname) || fox.contains('ä', p.productname))
        .sort(by((p) => p.productid))
        .map((p) => [p.productid, fox.upper(p.productname), fox.lower(p.productname)]),
    ],
  },
  {
    name: 'replaces text case-sensitively with STRTRAN and maps characters',
    fox: 'SELECT customerid, STRTRAN(phone, "-", "") AS p, STRTRAN(companyname, "s", "#") AS n2, ASC(customerid) AS a, CHR(65 + MOD(LEN(ALLTRIM(city)), 26)) AS ch, STRTRAN(STRTRAN(phone, "(", ""), ")", "") AS p2 FROM customers WHERE country == "USA" ORDER BY customerid',
    expected: (t) =>
      one(
        t.customers
          .filter((c) => eq(c.country, 'USA'))
          .sort(by((c) => c.customerid))
          .map((c) => [
            c.customerid,
            fox.strtran(c.phone, '-'),
            fox.strtran(c.companyname, 's', '#'),
            c.customerid.charCodeAt(0),
            String.fromCharCode(65 + fox.mod(fox.alltrim(c.city).length, 26)),
            fox.strtran(fox.strtran(c.phone, '('), ')'),
          ]),
      ),
  },
  {
    name: 'matches a prefix with LIKE',
    fox: 'SELECT customerid FROM customers WHERE companyname LIKE "La %" ORDER BY customerid',
    expected: (t) => one(t.customers.filter((c) => c.companyname.startsWith('La ')).sort(by((c) => c.customerid)).map((c) => [c.customerid])),
  },
  {
    name: 'excludes NULL from not-equal comparisons',
    fox: 'SELECT customerid FROM customers WHERE country # "USA" AND region != "BC" AND region <> "SP" ORDER BY customerid',
    expected: (t) =>
      one(
        t.customers
          .filter((c) => !eq(c.country, 'USA') && c.region !== null && !eq(c.region, 'BC') && !eq(c.region, 'SP'))
          .sort(by((c) => c.customerid))
          .map((c) => [c.customerid]),
      ),
  },
  {
    name: 'parses a date string with CTOD in day/month/year order',
    fox: 'SELECT orderid FROM orders WHERE orderdate = CTOD("04/07/1996") ORDER BY orderid',
    expected: (t) => one(t.orders.filter((o) => o.orderdate.getTime() === fox.date(1996, 7, 4).getTime()).sort(by((o) => o.orderid)).map((o) => [o.orderid])),
  },
  {
    name: 'reads memo fields and subtracts a date field from a literal',
    fox: [
      'SELECT employeeid, YEAR({^1998-01-01}) - YEAR(birthdate) AS age, {^1998-01-01} - hiredate AS tenure, LEFT(notes, 20) AS n FROM employees ORDER BY employeeid',
      'SELECT employeeid FROM employees WHERE "BA " $ notes ORDER BY employeeid',
    ].join('\n'),
    expected: (t) => {
      const employees = [...t.employees].sort(by((e) => e.employeeid));
      return [
        employees.map((e) => [e.employeeid, 1998 - fox.year(e.birthdate), fox.daysBetween(fox.date(1998, 1, 1), e.hiredate), fox.left(e.notes, 20)]),
        employees.filter((e) => fox.contains('BA ', e.notes)).map((e) => [e.employeeid]),
      ];
    },
  },
  {
    name: 'accepts lower case, comments, continuation lines and GROUP BY positions',
    fox: [
      '* doanh thu cước theo tháng',
      'select year(o.orderdate) as nam, month(o.orderdate) as thang, ;   && nhóm theo tháng',
      '       count(*) as so_don, sum(o.freight) as cuoc ;',
      '  from orders o ;',
      '  where o.shipcountry == "France" ;',
      '  group by 1, 2 ;',
      '  order by 1, 2',
    ].join('\n'),
    expected: (t) =>
      one(
        groupBy(t.orders.filter((o) => eq(o.shipcountry, 'France')), (o) => fox.year(o.orderdate) * 100 + fox.month(o.orderdate))
          .sort(by(([key]) => key))
          .map(([key, rows]) => [Math.floor(key / 100), key % 100, rows.length, sum(rows.map((o) => o.freight))]),
      ),
  },
  {
    name: 'groups by a column alias',
    fox: 'SELECT UPPER(country) AS ctry, COUNT(*) AS n FROM customers GROUP BY ctry ORDER BY ctry',
    expected: (t) =>
      one(
        groupBy(t.customers, (c) => fox.upper(fox.rtrim(c.country)))
          .sort(by(([country]) => country))
          .map(([country, rows]) => [country, rows.length]),
      ),
  },
  {
    name: 'selects every column of an aliased table',
    fox: 'SELECT c.* FROM customers c WHERE c.customerid = "ALFKI"',
    expected: (t) => one(t.customers.filter((c) => c.customerid === 'ALFKI').map((c) => Object.values(c) as Cell[])),
  },
  {
    name: 'compares strings by prefix with =, #, IN and INLIST (SET ANSI OFF)',
    fox: [
      'SELECT customerid FROM customers WHERE companyname = "La" ORDER BY customerid',
      'SELECT customerid FROM customers WHERE city IN ("Lon", "Mad") AND country # "U" ORDER BY customerid',
      'SELECT customerid FROM customers WHERE INLIST(country, "U", "Bra") AND city NOT IN ("L", "S") ORDER BY customerid',
      'SELECT COUNT(*) AS n FROM customers WHERE contactname = "" AND country == "UK"',
    ].join('\n'),
    expected: (t) => {
      const customers = [...t.customers].sort(by((c) => c.customerid));
      const starts = (field: string | null, ...prefixes: string[]) => field !== null && prefixes.some((p) => field.startsWith(p));
      return [
        customers.filter((c) => starts(c.companyname, 'La')).map((c) => [c.customerid]),
        customers.filter((c) => starts(c.city, 'Lon', 'Mad') && c.country !== null && !starts(c.country, 'U')).map((c) => [c.customerid]),
        customers.filter((c) => starts(c.country, 'U', 'Bra') && c.city !== null && !starts(c.city, 'L', 'S')).map((c) => [c.customerid]),
        [[customers.filter((c) => c.contactname !== null && eq(c.country, 'UK')).length]],
      ];
    },
  },
  {
    name: 'refers to a column alias in HAVING',
    fox: 'SELECT c.country, COUNT(*) AS n FROM customers c GROUP BY 1 HAVING n > 8 ORDER BY n DESC, 1',
    expected: (t) =>
      one(
        groupBy(t.customers, (c) => c.country)
          .map(([country, rows]) => [country, rows.length] as [string, number])
          .filter(([, n]) => n > 8)
          .sort(by(desc(([, n]) => n), ([country]) => country)),
      ),
  },
  {
    name: 'reads leading numbers with VAL and rounds with STR',
    fox: 'SELECT productid, VAL(quantityperunit) AS q, STR(unitprice / 3, 8, 2) AS s, STR(unitprice * 1.005, 9, 2) AS r FROM products ORDER BY productid',
    expected: (t) =>
      one(
        [...t.products].sort(by((p) => p.productid)).map((p) => [
          p.productid,
          nn(p.quantityperunit, (s: string) => Number(/^\s*-?\d*\.?\d*/.exec(s)![0]) || 0),
          // Currency arithmetic keeps 4 decimals before STR rounds again.
          fox.str(fox.round(p.unitprice / 3, 4), 8, 2),
          fox.str(fox.round(p.unitprice * 1.005, 4), 9, 2),
        ]),
      ),
  },
  {
    name: 'formats dates and logical values with TRANSFORM',
    fox: [
      'SELECT orderid, TRANSFORM(orderdate) AS d FROM orders WHERE orderid < 10252 ORDER BY orderid',
      'SELECT productid, TRANSFORM(discontinued) AS x FROM products WHERE productid < 8 ORDER BY productid',
    ].join('\n'),
    expected: (t) => [
      t.orders.filter((o) => o.orderid < 10252).sort(by((o) => o.orderid)).map((o) => [o.orderid, fox.dtoc(o.orderdate)]),
      t.products.filter((p) => p.productid < 8).sort(by((p) => p.productid)).map((p) => [p.productid, p.discontinued ? '.T.' : '.F.']),
    ],
  },
];

/** Statements kept to prove that each documented difference from FoxPro is real. */
export const DEVIATIONS: Deviation[] = [
  {
    name: 'width of a computed character column',
    fox: 'SELECT productid, TRANSFORM(productid) AS tx FROM products ORDER BY productid',
    reason: 'FoxPro sizes the column from the first row and truncates later values; SQL Server returns them whole.',
  },
  {
    name: 'currency arithmetic precision',
    fox: 'SELECT SUM(unitprice * quantity * (1 - discount)) AS revenue FROM orderdetails',
    reason: 'FoxPro rounds every currency product to 4 decimals; SQL Server keeps more digits.',
  },
  {
    name: 'case sensitivity of string comparison',
    fox: 'SELECT COUNT(*) AS n FROM customers WHERE city = "london"',
    reason: 'FoxPro compares case-sensitively; SQL Server follows the column collation, usually case-insensitive.',
  },
];
