import { describe, expect, it } from 'vitest';
import { convertFoxPro, createColumnResolver } from '../src/converter';

const sql = (source: string, options = {}) => {
  const result = convertFoxPro(source, options);
  expect(result.errors).toEqual([]);
  return result.sql;
};

describe('literals and operators', () => {
  it('converts logical constants and dotted operators', () => {
    expect(sql('SELECT * FROM nv WHERE active = .T. .AND. .NOT. locked == .F.')).toBe(
      'SELECT * FROM nv WHERE active = 1 AND NOT locked = 0',
    );
  });

  it('converts not-equal forms', () => {
    expect(sql('SELECT * FROM nv WHERE a != 1 AND b # 2 AND !c = 3')).toBe(
      'SELECT * FROM nv WHERE a <> 1 AND b <> 2 AND NOT c = 3',
    );
  });

  it('converts double-quoted strings and escapes single quotes', () => {
    expect(sql(`SELECT * FROM nv WHERE ten == "O'Neil"`)).toBe("SELECT * FROM nv WHERE ten = 'O''Neil'");
  });

  it('emits N literals for Vietnamese text', () => {
    expect(sql("SELECT * FROM nv WHERE ten == 'Nguyễn'")).toBe("SELECT * FROM nv WHERE ten = N'Nguyễn'");
  });

  it('converts strict date and datetime literals to ODBC escapes', () => {
    expect(sql('SELECT * FROM nv WHERE ngay >= {^2026-01-05} AND luc < {^2026/1/5 2:30 PM}')).toBe(
      "SELECT * FROM nv WHERE ngay >= {d '2026-01-05'} AND luc < {ts '2026-01-05 14:30:00'}",
    );
  });

  it('converts the $ substring operator with arithmetic operands', () => {
    expect(sql("SELECT * FROM nv WHERE 'an' $ ho + ten")).toBe(
      "SELECT * FROM nv WHERE (CHARINDEX('an', CAST(ho + ten AS nvarchar(max)) COLLATE Latin1_General_BIN2) > 0)",
    );
  });

  it('keeps alias.* and bracketed identifiers intact', () => {
    expect(sql('SELECT a.*, b.[Ho Ten] FROM dbo.nv a')).toBe('SELECT a.*, b.[Ho Ten] FROM dbo.nv a');
  });
});

describe('functions', () => {
  it('maps string functions to ODBC escapes', () => {
    expect(sql('SELECT ALLTRIM(ten), UPPER(ma), SUBSTR(ma, 2, 3) FROM nv')).toBe(
      'SELECT {fn LTRIM({fn RTRIM(ten)})}, {fn UCASE(ma)}, {fn SUBSTRING(ma, 2, 3)} FROM nv',
    );
  });

  it('converts nested calls', () => {
    expect(sql('SELECT PADL(ALLTRIM(ma), 6, "0") FROM nv')).toBe(
      "SELECT LEFT(REPLICATE('0', 6), 6 - (LEN(LEFT(CAST({fn LTRIM({fn RTRIM(ma)})} AS nvarchar(4000)), 6) + N'.') - 1)) + " +
        "LEFT(CAST({fn LTRIM({fn RTRIM(ma)})} AS nvarchar(4000)), 6) FROM nv",
    );
  });

  it('keeps FoxPro semantics where T-SQL differs', () => {
    expect(sql('SELECT LEN(ten), MOD(a, 7), AVG(sl + 0), NVL(vung, "x") FROM nv')).toBe(
      "SELECT (LEN(ten + N'.') - 1), (((a) % (7) + (7)) % (7)), AVG(1.0 * (sl + 0)), COALESCE(vung, N'x') FROM nv",
    );
    expect(sql('SELECT AT("a", ten), STRTRAN(ten, "a", "b") FROM nv')).toBe(
      "SELECT CHARINDEX('a', CAST(ten AS nvarchar(max)) COLLATE Latin1_General_BIN2), " +
        "REPLACE(CAST(ten AS nvarchar(max)) COLLATE Latin1_General_BIN2, 'a', 'b') COLLATE DATABASE_DEFAULT FROM nv",
    );
  });

  it('follows FoxPro for VAL, STR, CTOD, TRANSFORM and AVG of a plain field', () => {
    expect(sql('SELECT STR(luong, 10, 2), STR(sl), CTOD(s), AVG(sl) FROM nv')).toBe(
      'SELECT STR(ROUND(luong, 2), 10, 2), STR(ROUND(sl, 0)), TRY_CONVERT(date, s, 103), AVG(sl) FROM nv',
    );
    expect(sql('SELECT VAL(s) FROM nv')).toBe(
      "SELECT CASE WHEN s IS NULL THEN NULL ELSE COALESCE(TRY_CAST(LEFT(LTRIM(s), PATINDEX('%[^-0-9.]%', LTRIM(s) + 'x') - 1) AS float), 0) END FROM nv",
    );
    const kinds: Record<string, 'date' | 'bool'> = { ngay: 'date', nghi: 'bool' };
    expect(sql('SELECT TRANSFORM(ngay), TRANSFORM(nghi), TRANSFORM(sl) FROM nv', { resolveColumnKind: (name: string) => kinds[name] })).toBe(
      "SELECT COALESCE(CONVERT(varchar(10), ngay, 103), '.NULL.'), COALESCE(IIF(nghi = 1, '.T.', '.F.'), '.NULL.'), " +
        "COALESCE(CAST(sl AS nvarchar(4000)), '.NULL.') FROM nv",
    );
  });

  it('converts the FoxPro operators %, ^ and ** and currency literals', () => {
    expect(sql('SELECT a % 3, a * b % c, a ^ 2, b ** -1 FROM nv WHERE luong > $1500.50')).toBe(
      'SELECT (((a) % (3) + (3)) % (3)), (((a * b) % (c) + (c)) % (c)), POWER(CAST(a AS float), 2), POWER(CAST(b AS float), -1) ' +
        'FROM nv WHERE luong > 1500.50',
    );
  });

  it('converts EVL, OCCURS, RAT, QUARTER and DTOT', () => {
    const kinds: Record<string, 'number'> = { sl: 'number' };
    expect(sql('SELECT EVL(sl, 1), QUARTER(d), DTOT(d) FROM nv', { resolveColumnKind: (name: string) => kinds[name] })).toBe(
      'SELECT CASE WHEN (sl IS NOT NULL AND sl = 0) THEN 1 ELSE sl END, {fn QUARTER(d)}, CAST(d AS datetime) FROM nv',
    );
    expect(convertFoxPro('SELECT OCCURS("a", ten), RAT("a", ten) FROM nv').errors).toEqual([]);
  });

  it('infers the kind of an expression for EMPTY()', () => {
    const kinds: Record<string, 'number' | 'string'> = { sl: 'number', ten: 'string' };
    const result = convertFoxPro('SELECT * FROM nv WHERE EMPTY(sl * 2) OR EMPTY(ALLTRIM(ten)) OR EMPTY(LEN(ten)) OR EMPTY(ten + ma)', {
      resolveColumnKind: (name: string) => kinds[name],
    });
    expect(result.warnings).toEqual([]);
    expect(result.sql).toBe(
      "SELECT * FROM nv WHERE (sl * 2 IS NOT NULL AND sl * 2 = 0) OR ({fn LTRIM({fn RTRIM(ten)})} IS NOT NULL AND {fn LTRIM({fn RTRIM(ten)})} = '') " +
        "OR ((LEN(ten + N'.') - 1) IS NOT NULL AND (LEN(ten + N'.') - 1) = 0) OR (ten + ma IS NOT NULL AND ten + ma = '')",
    );
  });

  it('converts ICASE to CASE', () => {
    expect(sql('SELECT ICASE(a < 1, "x", a < 9, "y", "z") FROM nv')).toBe(
      "SELECT CASE WHEN a < 1 THEN 'x' WHEN a < 9 THEN 'y' ELSE 'z' END FROM nv",
    );
  });

  it('distinguishes BETWEEN() function from the BETWEEN operator', () => {
    expect(sql('SELECT * FROM nv WHERE BETWEEN(luong, 1, 9) AND tuoi BETWEEN 20 AND 30')).toBe(
      'SELECT * FROM nv WHERE (luong BETWEEN 1 AND 9) AND tuoi BETWEEN 20 AND 30',
    );
  });

  it('converts INLIST and one-argument ISNULL, keeps two-argument ISNULL', () => {
    expect(sql('SELECT ISNULL(a, 0) FROM nv WHERE INLIST(pb, "A", "B") AND ISNULL(c)')).toBe(
      "SELECT ISNULL(a, 0) FROM nv WHERE (pb LIKE 'A%' OR pb LIKE 'B%') AND (c IS NULL)",
    );
  });

  it('converts date functions using the configured date style', () => {
    expect(sql('SELECT DTOC(ngay), DTOS(ngay), YEAR(ngay) FROM nv WHERE ngay < DATE()')).toBe(
      'SELECT CONVERT(varchar(10), ngay, 103), CONVERT(varchar(8), ngay, 112), {fn YEAR(ngay)} FROM nv WHERE ngay < {fn CURDATE()}',
    );
    expect(sql('SELECT DTOC(ngay) FROM nv', { dateStyle: 'mdy' })).toBe('SELECT CONVERT(varchar(10), ngay, 101) FROM nv');
  });

  it('converts EMPTY() by column kind and warns when the kind is unknown', () => {
    const kinds: Record<string, 'number' | 'string'> = { luong: 'number', ten: 'string' };
    const resolveColumnKind = (name: string) => kinds[name.toLowerCase()];
    expect(sql('SELECT * FROM nv WHERE EMPTY(a.luong) OR EMPTY(ten)', { resolveColumnKind })).toBe(
      "SELECT * FROM nv WHERE (a.luong IS NOT NULL AND a.luong = 0) OR (ten IS NOT NULL AND ten = '')",
    );
    const unknown = convertFoxPro('SELECT * FROM nv WHERE EMPTY(x)');
    expect(unknown.sql).toBe("SELECT * FROM nv WHERE (x IS NOT NULL AND x = '')");
    expect(unknown.warnings).toHaveLength(1);
  });

  it('passes aggregates and unknown functions through', () => {
    expect(sql('SELECT COUNT(*), SUM(luong), COALESCE(a, b) FROM nv GROUP BY pb')).toBe(
      'SELECT COUNT(*), SUM(luong), COALESCE(a, b) FROM nv GROUP BY pb',
    );
  });

  it('reports wrong argument counts', () => {
    expect(convertFoxPro('SELECT ALLTRIM(a, b) FROM nv').errors).toEqual([
      { line: 1, message: 'Hàm ALLTRIM() cần 1 tham số, nhận 2.' },
    ]);
  });
});

describe('string comparison (SET ANSI)', () => {
  it('matches by prefix against a literal, as FoxPro does with SET ANSI OFF', () => {
    expect(sql('SELECT * FROM nv WHERE ma = "NV" AND pb # "KT" AND ten != "A_50%"')).toBe(
      "SELECT * FROM nv WHERE ma LIKE 'NV%' AND pb NOT LIKE 'KT%' AND ten NOT LIKE 'A[_]50[%]%'",
    );
    expect(sql('SELECT * FROM nv WHERE ma IN ("A", "B") OR pb NOT IN ("X") OR INLIST(ma, "C", pb)')).toBe(
      "SELECT * FROM nv WHERE (ma LIKE 'A%' OR ma LIKE 'B%') OR NOT (pb LIKE 'X%') OR (ma LIKE 'C%' OR ma = pb)",
    );
  });

  it('keeps exact comparison for ==, non-literals, non-strings and subqueries', () => {
    const kinds = { ngay: 'date' as const };
    expect(sql('SELECT * FROM nv WHERE ma == "NV" AND ma = pb AND "NV" = ma AND sl IN (1, 2) AND ma IN (SELECT ma FROM x)')).toBe(
      "SELECT * FROM nv WHERE ma = 'NV' AND ma = pb AND ('NV' = LEFT(ma, (LEN('NV' + N'.') - 1))) AND sl IN (1, 2) AND ma IN (SELECT ma FROM x)",
    );
    expect(sql('SELECT * FROM nv WHERE a + b = c AND sl = (SELECT MAX(sl) FROM x) AND ma = (SELECT ma FROM y)')).toBe(
      'SELECT * FROM nv WHERE a + b = c AND sl = (SELECT MAX(sl) FROM x) AND ma = (SELECT ma FROM y)',
    );
    expect(sql("SELECT * FROM nv WHERE ngay = '2026-01-01'", { resolveColumnKind: (name: string) => kinds[name as 'ngay'] })).toBe(
      "SELECT * FROM nv WHERE ngay = '2026-01-01'",
    );
  });

  it('stops at the shorter side when an expression is compared', () => {
    expect(sql('SELECT * FROM nv WHERE ALLTRIM(ma) = "NV" AND ALLTRIM(ma) # "X" AND ma + pb = "NVKT"')).toBe(
      "SELECT * FROM nv WHERE ({fn LTRIM({fn RTRIM(ma)})} LIKE 'NV%' OR {fn LTRIM({fn RTRIM(ma)})} = LEFT('NV', (LEN({fn LTRIM({fn RTRIM(ma)})} + N'.') - 1))) " +
        "AND NOT ({fn LTRIM({fn RTRIM(ma)})} LIKE 'X%' OR {fn LTRIM({fn RTRIM(ma)})} = LEFT('X', (LEN({fn LTRIM({fn RTRIM(ma)})} + N'.') - 1))) " +
        "AND (ma + pb LIKE 'NVKT%' OR ma + pb = LEFT('NVKT', (LEN(ma + pb + N'.') - 1)))",
    );
    expect(sql('SELECT * FROM a JOIN b ON a.ma = ALLTRIM(b.ma) AND UPPER(a.pb) = UPPER(b.pb)')).toBe(
      "SELECT * FROM a JOIN b ON (LEFT(a.ma, (LEN({fn LTRIM({fn RTRIM(b.ma)})} + N'.') - 1)) = {fn LTRIM({fn RTRIM(b.ma)})}) " +
        "AND (LEFT({fn UCASE(a.pb)}, (LEN({fn UCASE(b.pb)} + N'.') - 1)) = LEFT({fn UCASE(b.pb)}, (LEN({fn UCASE(a.pb)} + N'.') - 1)))",
    );
  });

  it('treats memo and (max) columns as variable-length strings', () => {
    const kinds = { ghichu: 'varstring' as const };
    expect(sql('SELECT * FROM nv WHERE ghichu = "abc" AND EMPTY(ghichu)', { resolveColumnKind: (name: string) => kinds[name as 'ghichu'] })).toBe(
      "SELECT * FROM nv WHERE (ghichu LIKE 'abc%' OR ghichu = LEFT('abc', (LEN(ghichu + N'.') - 1))) AND (ghichu IS NOT NULL AND ghichu = '')",
    );
  });

  it('applies the prefix rule to > and <=, which change under it', () => {
    expect(sql('SELECT * FROM nv WHERE ma > "NV" AND ma <= "NV" AND ma >= "NV" AND ma < "NV"')).toBe(
      "SELECT * FROM nv WHERE (ma > 'NV' AND ma NOT LIKE 'NV%') AND (ma <= 'NV' OR ma LIKE 'NV%') AND ma >= 'NV' AND ma < 'NV'",
    );
  });

  it('adapts LIKE patterns: trailing blanks and square brackets', () => {
    expect(sql('SELECT * FROM nv WHERE ma LIKE "NV%" AND ten LIKE "%an" AND ma NOT LIKE "A_" AND ten LIKE "[x]%"')).toBe(
      "SELECT * FROM nv WHERE ma LIKE 'NV%' AND RTRIM(ten) LIKE '%an' AND RTRIM(ma) NOT LIKE 'A_' AND ten LIKE '[[]x]%'",
    );
  });

  it('turns a logical constant used as a condition into a comparison', () => {
    expect(sql('SELECT .T. AS x FROM nv WHERE .T. AND (nghi = .F. OR .F.)')).toBe(
      'SELECT 1 AS x FROM nv WHERE 1 = 1 AND (nghi = 0 OR 1 = 0)',
    );
  });

  it('compares exactly when SET ANSI is on', () => {
    expect(sql('SELECT * FROM nv WHERE ma = "NV" AND pb IN ("A") AND INLIST(ma, "C")', { ansi: true })).toBe(
      "SELECT * FROM nv WHERE ma = 'NV' AND pb IN ('A') AND (ma IN ('C'))",
    );
  });
});

describe('typed expressions', () => {
  const kinds: Record<string, 'date' | 'datetime' | 'bool' | 'number'> = { ngay: 'date', han: 'date', luc: 'datetime', nghi: 'bool', sl: 'number' };
  const typed = (source: string) => sql(source, { resolveColumnKind: (name: string) => kinds[name.toLowerCase()] });

  it('never divides as integers', () => {
    expect(sql('SELECT a / b, (a + b) / 2 FROM nv')).toBe('SELECT a * 1.0 / b, (a + b) * 1.0 / 2 FROM nv');
  });

  it('turns date arithmetic into DATEADD and DATEDIFF', () => {
    expect(typed('SELECT han - ngay, ngay + 30, han - sl * 2 FROM nv WHERE han - ngay > 5')).toBe(
      'SELECT DATEDIFF(day, ngay, han), DATEADD(day, 30, ngay), DATEADD(day, -(sl * 2), han) FROM nv WHERE DATEDIFF(day, ngay, han) > 5',
    );
    expect(typed('SELECT {^2026-01-31} - ngay, luc + 60, luc - ngay FROM nv')).toBe(
      "SELECT DATEDIFF(day, ngay, {d '2026-01-31'}), DATEADD(second, 60, luc), DATEDIFF(second, ngay, luc) FROM nv",
    );
  });

  it('leaves arithmetic alone when the column kind is unknown', () => {
    expect(sql('SELECT han - ngay FROM nv')).toBe('SELECT han - ngay FROM nv');
  });

  it('expands a bare logical field only where a condition is expected', () => {
    expect(typed('SELECT nghi, IIF(nghi, 1, 0) FROM nv WHERE nghi AND (!nghi OR sl > 0) AND nghi = .F.')).toBe(
      'SELECT nghi, IIF(nghi = 1, 1, 0) FROM nv WHERE nghi = 1 AND (NOT nghi = 1 OR sl > 0) AND nghi = 0',
    );
  });
});

describe('column kinds from the schema', () => {
  // The same column name has different types in different tables, as in the project database.
  const resolveColumnKind = createColumnResolver([
    { name: 'NhanVien', columns: [{ name: 'Ngay', kind: 'datetime' }, { name: 'Nghi', kind: 'bool' }, { name: 'Ma', kind: 'string' }] },
    { name: 'ChamCong', columns: [{ name: 'Ngay', kind: 'date' }, { name: 'Nghi', kind: 'number' }, { name: 'Ma', kind: 'string' }] },
  ]);
  const typed = (source: string) => sql(source, { resolveColumnKind });

  it('uses the table of the statement to type an unqualified column', () => {
    expect(typed('SELECT Ngay + 1 FROM NhanVien WHERE Nghi')).toBe('SELECT DATEADD(second, 1, Ngay) FROM NhanVien WHERE Nghi = 1');
    expect(typed('SELECT Ngay + 1 FROM dbo.ChamCong WHERE Nghi > 0')).toBe('SELECT DATEADD(day, 1, Ngay) FROM dbo.ChamCong WHERE Nghi > 0');
  });

  it('uses the alias or table name to type a qualified column', () => {
    expect(typed('SELECT n.Ngay - c.Ngay, ChamCong.Ngay + 2 FROM NhanVien n JOIN ChamCong AS c ON n.Ma = c.Ma WHERE n.Nghi')).toBe(
      'SELECT DATEDIFF(second, c.Ngay, n.Ngay), DATEADD(day, 2, ChamCong.Ngay) FROM NhanVien n JOIN ChamCong AS c ON n.Ma = c.Ma WHERE n.Nghi = 1',
    );
    expect(typed('SELECT a.Ngay + 1 FROM NhanVien a, ChamCong b WHERE a.Ma = b.Ma AND b.Ngay + 1 > a.Ngay')).toBe(
      'SELECT DATEADD(second, 1, a.Ngay) FROM NhanVien a, ChamCong b WHERE a.Ma = b.Ma AND DATEADD(day, 1, b.Ngay) > a.Ngay',
    );
  });

  it('leaves a column untyped when the tables of the statement disagree, or it is a cursor', () => {
    expect(typed('SELECT Ngay + 1 FROM NhanVien, ChamCong')).toBe('SELECT Ngay + 1 FROM NhanVien, ChamCong');
    expect(sql('SELECT Ngay + 1 FROM c1', { resolveColumnKind, knownCursors: ['c1'] })).toBe('SELECT Ngay + 1 FROM #c1');
    expect(typed('SELECT Ngay + 1 FROM (SELECT Ngay FROM ChamCong) x')).toBe('SELECT DATEADD(day, 1, Ngay) FROM (SELECT Ngay FROM ChamCong) x');
  });
});

describe('select list', () => {
  it('replaces GROUP BY positions and aliases with the expressions', () => {
    expect(sql('SELECT YEAR(ngay) AS nam, pb, COUNT(*) FROM nv GROUP BY 1, pb ORDER BY 1')).toBe(
      'SELECT {fn YEAR(ngay)} AS nam, pb, COUNT(*) FROM nv GROUP BY {fn YEAR(ngay)}, pb ORDER BY 1',
    );
    expect(sql('SELECT UPPER(pb) AS p, SUM(luong) tong FROM nv GROUP BY p HAVING tong > 0 ORDER BY tong')).toBe(
      'SELECT {fn UCASE(pb)} AS p, SUM(luong) tong FROM nv GROUP BY {fn UCASE(pb)} HAVING (SUM(luong)) > 0 ORDER BY tong',
    );
  });

  it('names unnamed and duplicate cursor columns the FoxPro way', () => {
    expect(sql('SELECT a.ma, b.ma, COUNT(*), SUM(b.luong), a.x + 1, MAX(a.x) AS lon, COUNT(a.x), COUNT(DISTINCT b.pb) FROM a, b GROUP BY a.ma, b.ma INTO CURSOR c').split('\n')[1]).toBe(
      'SELECT a.ma AS ma_a, b.ma AS ma_b, COUNT(*) AS cnt, SUM(b.luong) AS sum_luong, a.x + 1 AS exp_5, MAX(a.x) AS lon, COUNT(a.x) AS cnt_x, COUNT(DISTINCT b.pb) AS dcnt_pb INTO #c FROM a, b GROUP BY a.ma, b.ma',
    );
  });

  it('keeps * and plain columns untouched in a cursor', () => {
    expect(sql('SELECT DISTINCT TOP 5 a.*, ten FROM a ORDER BY ten INTO CURSOR c').split('\n')[1]).toBe(
      'SELECT DISTINCT TOP 5 a.*, ten INTO #c FROM a ORDER BY ten',
    );
  });
});

describe('statements', () => {
  it('joins continuation lines and strips comments', () => {
    const source = ['* danh sách nhân viên', 'SELECT ma, ten ;', '  FROM nv ;   && bảng nhân viên', '  WHERE luong > 0'].join('\n');
    expect(sql(source)).toBe('SELECT ma, ten FROM nv WHERE luong > 0');
  });

  it('moves INTO CURSOR before FROM as a temp table', () => {
    const result = convertFoxPro('SELECT ma, ten FROM nv WHERE luong > 0 INTO CURSOR curNV READWRITE');
    expect(result.sql).toBe('DROP TABLE IF EXISTS #curnv;\nSELECT ma, ten INTO #curnv FROM nv WHERE luong > 0');
    expect(result.cursors).toEqual(['curnv']);
    expect(result.currentCursor).toBe('curnv');
  });

  it('references cursors as temp tables and supports BROWSE', () => {
    const source = ['SELECT * FROM nv INTO CURSOR c1', 'SELECT c1.ma, COUNT(*) FROM c1 GROUP BY c1.ma', 'BROWSE FOR luong > 5'].join('\n');
    expect(sql(source)).toBe(
      [
        'DROP TABLE IF EXISTS #c1;\nSELECT * INTO #c1 FROM nv',
        'SELECT #c1.ma, COUNT(*) FROM #c1 GROUP BY #c1.ma',
        'SELECT * FROM #c1 WHERE luong > 5',
      ].join(';\n'),
    );
  });

  it('spells a cursor the same way wherever it is used, whatever case was typed', () => {
    expect(sql('SELECT * FROM nv INTO CURSOR curLuong\nSELECT CURLUONG.ma FROM curLuong c, CurLuong d')).toBe(
      'DROP TABLE IF EXISTS #curluong;\nSELECT * INTO #curluong FROM nv;\nSELECT #curluong.ma FROM #curluong c, #curluong d',
    );
  });

  it('keeps cursors across runs and switches work area with SELECT name', () => {
    const options = { knownCursors: ['c1', 'c2'], currentCursor: 'c2' };
    expect(sql('SELECT c1\nBROWSE FIELDS ma, ten', options)).toBe('SELECT ma, ten FROM #c1');
    expect(sql('BROWSE', options)).toBe('SELECT * FROM #c2');
  });

  it('rejects write commands and unsupported targets', () => {
    expect(convertFoxPro('REPLACE luong WITH 0').errors[0].message).toContain('REPLACE');
    expect(convertFoxPro('SELECT * FROM nv INTO TABLE x').errors[0].message).toContain('INTO CURSOR');
    expect(convertFoxPro('BROWSE').errors[0].message).toContain('cursor');
  });

  it('reports errors with line numbers and returns no SQL', () => {
    const result = convertFoxPro('SELECT 1\nSELECT &macro FROM nv');
    expect(result.errors).toEqual([{ line: 2, message: 'Macro (&biến) chưa được hỗ trợ.' }]);
    expect(result.sql).toBe('');
  });
});
