import { describe, expect, it } from 'vitest';
import { createColumnResolver } from '../src/converter';
import { convertTsql } from '../src/converter/reverse';

const fox = (source: string, options = {}) => {
  const result = convertTsql(source, options);
  expect(result.errors).toEqual([]);
  return result.foxpro;
};

const resolveColumnKind = createColumnResolver([
  { name: 'NhanVien', columns: [{ name: 'Ten', kind: 'string' }, { name: 'Nghi', kind: 'bool' }, { name: 'Luong', kind: 'number' }, { name: 'Ngay', kind: 'date' }, { name: 'Luc', kind: 'datetime' }] },
]);
const typed = (source: string) => fox(source, { resolveColumnKind });

describe('T-SQL to FoxPro: text comparison', () => {
  it('compares text exactly and without regard to case, as SQL Server does', () => {
    expect(fox("SELECT * FROM nv WHERE ten = 'An' AND pb <> N'KT' AND ma IN ('A', 'B') AND ten LIKE 'Ng%'")).toBe(
      'SELECT * FROM nv WHERE UPPER(ten) == UPPER("An") AND !(UPPER(pb) == UPPER("KT")) AND (UPPER(ma) == UPPER("A") OR UPPER(ma) == UPPER("B")) AND UPPER(ten) LIKE UPPER("Ng%")',
    );
  });

  it('knows string columns from the schema even without a literal', () => {
    expect(typed('SELECT * FROM NhanVien a JOIN NhanVien b ON a.Ten = b.Ten WHERE a.Luong = b.Luong')).toBe(
      'SELECT * FROM NhanVien a JOIN NhanVien b ON UPPER(a.Ten) == UPPER(b.Ten) WHERE a.Luong = b.Luong',
    );
  });

  it('reads the nested ODBC escapes the FoxPro converter writes', () => {
    expect(fox("SELECT {fn LTRIM({fn RTRIM(ten)})} FROM nv WHERE ngay >= {d '2026-01-01'}")).toBe('SELECT LTRIM(RTRIM(ten)) FROM nv WHERE ngay >= {^2026-01-01}');
  });

  it('keeps case sensitivity when asked', () => {
    expect(fox("SELECT * FROM nv WHERE ten = 'An'", { caseInsensitive: false })).toBe('SELECT * FROM nv WHERE ten == "An"');
  });

  it("escapes quotes and keeps '' as one quote", () => {
    expect(fox("SELECT 'O''Neil' AS a, 'say \"hi\"' AS b FROM nv")).toBe('SELECT "O\'Neil" AS a, \'say "hi"\' AS b FROM nv');
  });
});

describe('T-SQL to FoxPro: numbers, dates and NULL', () => {
  it('keeps integer division and modulo semantics', () => {
    expect(fox('SELECT 7 / 2, a % b, a / b FROM nv')).toBe('SELECT INT(7 / 2), (a - b * INT(a / b)), a / b FROM nv');
  });

  it('turns date strings and ODBC escapes into FoxPro date literals', () => {
    expect(fox("SELECT * FROM nv WHERE ngay >= '2026-01-31' AND luc < '2026-01-31 10:30:00' AND x = {d '2026-02-01'} AND y = {ts '2026-02-01 08:00:00'}")).toBe(
      'SELECT * FROM nv WHERE ngay >= {^2026-01-31} AND luc < {^2026-01-31 10:30:00} AND x = {^2026-02-01} AND y = {^2026-02-01 08:00:00}',
    );
  });

  it('maps DATEADD, DATEDIFF, GETDATE and CONVERT styles', () => {
    expect(typed("SELECT DATEADD(day, 30, Ngay), DATEADD(month, -1, Ngay), DATEDIFF(day, Ngay, GETDATE()), CONVERT(varchar(10), Ngay, 103), CONVERT(varchar(8), Ngay, 112) FROM NhanVien")).toBe(
      'SELECT Ngay + 30, GOMONTH(Ngay, -1), (TTOD(DATETIME()) - Ngay), DTOC(Ngay), DTOS(Ngay) FROM NhanVien',
    );
    expect(typed('SELECT DATEADD(hour, 2, Luc), DATEDIFF(second, Luc, GETDATE()), CAST(Luc AS date), YEAR(Ngay) FROM NhanVien')).toBe(
      'SELECT Luc + 3600 * 2, INT((DATETIME() - Luc) / 1), TTOD(Luc), YEAR(Ngay) FROM NhanVien',
    );
  });

  it('maps NULL handling and CASE', () => {
    expect(fox("SELECT ISNULL(a, 0), COALESCE(a, b, 'x'), CASE WHEN a > 1 THEN 'big' ELSE 'small' END, CASE pb WHEN 'KT' THEN 1 ELSE 0 END FROM nv WHERE a IS NULL")).toBe(
      'SELECT NVL(a, 0), NVL(a, NVL(b, "x")), ICASE(a > 1, PADR("big", 5), "small"), ICASE(UPPER(pb) == UPPER("KT"), 1, 0) FROM nv WHERE a IS NULL',
    );
  });

  it('maps string functions including LEN that ignores trailing blanks', () => {
    expect(fox("SELECT LEN(ten), SUBSTRING(ten, 1, 3), CHARINDEX('a', ten), REPLACE(ten, ' ', ''), LTRIM(RTRIM(ten)), TRIM(ten), CONCAT(ma, '-', ten) FROM nv")).toBe(
      'SELECT LEN(RTRIM(ten)), SUBSTR(ten, 1, 3), ATC("a", ten), STRTRAN(ten, " ", ""), LTRIM(RTRIM(ten)), ALLTRIM(ten), ma + "-" + ten FROM nv',
    );
  });

  it('turns bit comparisons into the logical field itself', () => {
    expect(typed('SELECT * FROM NhanVien WHERE Nghi = 1 AND NOT Nghi = 0')).toBe('SELECT * FROM NhanVien WHERE Nghi AND NOT !Nghi');
    expect(typed('SELECT * FROM NhanVien WHERE Nghi <> 1')).toBe('SELECT * FROM NhanVien WHERE !Nghi');
  });
});

describe('T-SQL to FoxPro: statements', () => {
  it('moves INTO #temp to INTO CURSOR and refers to cursors by name', () => {
    expect(fox('DROP TABLE IF EXISTS #c;\nSELECT ma, COUNT(*) AS n INTO #c FROM dbo.nv GROUP BY ma;\nSELECT * FROM #c WHERE n > 2')).toBe(
      'SELECT ma, COUNT(*) AS n FROM nv GROUP BY ma INTO CURSOR c\nSELECT * FROM c WHERE n > 2',
    );
  });

  it('strips dbo., unbrackets names and rewrites TOP (n)', () => {
    expect(fox('SELECT TOP (5) [ma], t.[ten] FROM [dbo].[nv] AS t ORDER BY 1')).toBe('SELECT TOP 5 ma, t.ten FROM nv AS t ORDER BY 1');
  });

  it('drops comments and handles subqueries, UNION and EXISTS', () => {
    expect(fox("-- all\nSELECT a FROM x WHERE a IN (SELECT a FROM y) /* sub */ UNION SELECT b FROM z WHERE EXISTS (SELECT 1 FROM w WHERE w.k = z.k)")).toBe(
      'SELECT a FROM x WHERE a IN (SELECT a FROM y) UNION SELECT b FROM z WHERE EXISTS (SELECT 1 FROM w WHERE w.k = z.k)',
    );
  });

  it('refuses what FoxPro cannot express, with the reason', () => {
    const messages = (sql: string) => convertTsql(sql).errors.map((e) => e.message);
    expect(messages('WITH c AS (SELECT 1 a) SELECT * FROM c')[0]).toMatch(/CTE/);
    expect(messages('SELECT ROW_NUMBER() OVER (ORDER BY a) FROM x')[0]).toMatch(/ROW_NUMBER|OVER/);
    expect(messages('SELECT @x FROM nv')[0]).toMatch(/Biến/);
    expect(messages('SELECT a AS [Họ tên] FROM nv')[0]).toMatch(/Họ tên/);
    expect(messages('SELECT * FROM a CROSS JOIN b')[0]).toMatch(/CROSS JOIN/);
    expect(messages('UPDATE nv SET a = 1')[0]).toMatch(/chỉ chuyển SELECT/);
    expect(messages("SELECT FORMAT(a, 'N2') FROM nv")[0]).toMatch(/FORMAT/);
  });

  it('warns rather than fails for functions it does not know', () => {
    const result = convertTsql('SELECT MYFUNC(a) FROM nv');
    expect(result.errors).toEqual([]);
    expect(result.warnings[0].message).toMatch(/MYFUNC/);
  });
});
