import type sqlTypes from 'mssql';
import sqlv8 from 'mssql/msnodesqlv8';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type SqlDatabase } from '../src/main/db';
import { columnKindResolver } from '../src/shared/column-kind';
import { runFoxQuery, type QuerySession } from '../src/shared/run-query';
import type { CellValue, ConnectionProfile, DbBackend, SchemaTable } from '../src/shared/types';
import { isLocalDbAvailable, runBatches } from '../tools/sqlrun';
import { requireOk } from './support/harness';

// The application path without the Electron shell: the database service (sessions,
// row limit, schema, value formatting) and the convert-and-run step, on a database
// shaped like the project's own: nvarchar columns, Vietnamese text, decimal money,
// datetime, bit, nvarchar(max).
//
// It runs the real service code through the msnodesqlv8 driver, because the default
// driver (tedious) speaks TCP only and LocalDB does not listen on TCP.

const DATABASE = 'FqsApp';
const MAX_ROWS = 5000;

interface Employee {
  ma: string;
  ten: string;
  pb: string | null;
  sinh: string | null;
  vao: string;
  luong: number;
  heso: number | null;
  nghi: boolean;
  ghichu: string | null;
}

const EMPLOYEES: Employee[] = [
  { ma: 'NV001', ten: 'Nguyễn Văn An', pb: 'KT', sinh: '1990-05-17', vao: '2015-03-01 08:00:00', luong: 15000000, heso: 1.5, nghi: false, ghichu: 'Thử việc 2 tháng' },
  { ma: 'NV002', ten: 'Trần Thị Bình', pb: 'KT', sinh: '1988-12-31', vao: '2012-07-15 08:30:00', luong: 18500000.5, heso: null, nghi: false, ghichu: null },
  { ma: 'NV003', ten: 'Lê Hoàng Ánh', pb: 'NS', sinh: null, vao: '2020-01-02 00:00:00', luong: 9800000, heso: 1, nghi: true, ghichu: '' },
  { ma: 'NV004', ten: 'Phạm Đức Văn', pb: 'NS', sinh: '2000-02-29', vao: '2023-11-30 13:45:10', luong: 7200000, heso: 0.85, nghi: false, ghichu: 'thử việc' },
  { ma: 'NV010', ten: 'Đỗ Thị Ỷ Lan', pb: null, sinh: '1995-08-08', vao: '2018-06-01 08:00:00', luong: 12000000, heso: 1.2, nghi: false, ghichu: 'Nghỉ thai sản\nđến 2026' },
  { ma: 'NV011', ten: 'nguyễn thị hoa', pb: 'IT', sinh: '1999-01-01', vao: '2021-09-09 09:09:09', luong: 21000000, heso: 2, nghi: false, ghichu: null },
  { ma: 'QL001', ten: 'Vũ Quốc Khánh', pb: 'IT', sinh: '1980-10-10', vao: '2005-01-01 08:00:00', luong: 45000000, heso: 3.25, nghi: false, ghichu: 'Trưởng phòng' },
  { ma: 'QL002', ten: 'Hồ Văn Ý', pb: 'KT', sinh: '1975-07-04', vao: '2001-04-30 08:00:00', luong: 39999999.99, heso: 3, nghi: true, ghichu: 'Đã nghỉ hưu' },
];

/** Net pay per employee and month of 2026, as `[ma, thang, ngayCong, thucLinh]`. */
const PAYROLL: [string, number, number, number][] = EMPLOYEES.flatMap((e, i) =>
  [8, 9].map((thang) => [e.ma, thang, 22 - (i % 3) * 0.5, Math.round(e.luong * (e.heso ?? 1) * (thang === 8 ? 1 : 0.95))] as [string, number, number, number]),
);

const text = (value: string | null) => (value === null ? 'NULL' : `N'${value.replace(/'/g, "''")}'`);

const SETUP = [
  `CREATE TABLE dbo.PhongBan (MaPB varchar(10) NOT NULL PRIMARY KEY, TenPB nvarchar(100) NOT NULL)`,
  `INSERT INTO dbo.PhongBan VALUES ('KT', N'Kế toán'), ('NS', N'Nhân sự'), ('IT', N'Công nghệ thông tin')`,
  `CREATE TABLE dbo.NhanVien (MaNV varchar(10) NOT NULL PRIMARY KEY, HoTen nvarchar(100) NOT NULL, MaPB varchar(10) NULL, NgaySinh date NULL,
     NgayVaoLam datetime NOT NULL, LuongCoBan decimal(18,2) NOT NULL, HeSo decimal(5,2) NULL, NghiViec bit NOT NULL, GhiChu nvarchar(max) NULL, Anh varbinary(max) NULL)`,
  `INSERT INTO dbo.NhanVien VALUES ${EMPLOYEES.map(
    (e) => `('${e.ma}', ${text(e.ten)}, ${text(e.pb)}, ${text(e.sinh)}, '${e.vao}', ${e.luong}, ${e.heso ?? 'NULL'}, ${e.nghi ? 1 : 0}, ${text(e.ghichu)}, ${e.ma === 'NV001' ? '0x00FF10' : 'NULL'})`,
  ).join(', ')}`,
  `CREATE TABLE dbo.BangLuong (MaNV varchar(10) NOT NULL, Thang int NOT NULL, Nam int NOT NULL, NgayCong decimal(5,1) NOT NULL, ThucLinh decimal(18,2) NOT NULL, DaChot bit NOT NULL)`,
  `INSERT INTO dbo.BangLuong VALUES ${PAYROLL.map(([ma, thang, cong, linh]) => `('${ma}', ${thang}, 2026, ${cong}, ${linh}, ${thang === 8 ? 1 : 0})`).join(', ')}`,
  `CREATE VIEW dbo.vw_LuongThang AS SELECT b.MaNV, n.HoTen, b.Thang, b.Nam, b.ThucLinh FROM dbo.BangLuong b JOIN dbo.NhanVien n ON n.MaNV = b.MaNV`,
];

const PROFILE: ConnectionProfile = { server: '(localdb)\\MSSQLLocalDB', database: DATABASE, user: '', password: '', encrypt: false, trustServerCertificate: true };

const buildConfig = (p: ConnectionProfile) =>
  ({
    connectionString: `Driver={ODBC Driver 17 for SQL Server};Server=${p.server};Database=${p.database};Trusted_Connection=yes;`,
    pool: { min: 1, max: 1 },
  }) as unknown as sqlTypes.config;

const byMa = (a: Employee, b: Employee) => (a.ma < b.ma ? -1 : 1);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe.skipIf(!isLocalDbAvailable())('application database service and query flow', () => {
  let db: SqlDatabase;
  let schema: SchemaTable[];
  let resolveColumnKind: ReturnType<typeof columnKindResolver>;

  /** Runs FoxPro source the way a query tab does and returns the rows of each result set. */
  async function fox(session: QuerySession, source: string): Promise<CellValue[][][]> {
    const outcome = await runFoxQuery(db.execute, session, source, { maxRows: MAX_ROWS, resolveColumnKind });
    expect(outcome.conversion.errors, 'converter errors').toEqual([]);
    expect(outcome.result?.error, outcome.conversion.sql).toBeUndefined();
    return outcome.result!.resultSets.map((set) => set.rows);
  }

  const newSession = (id: string): QuerySession => ({ id, cursors: [] });

  beforeAll(async () => {
    requireOk(
      runBatches('master', [
        { id: 'drop', sql: `IF DB_ID('${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE ${DATABASE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${DATABASE}; END` },
        { id: 'create', sql: `CREATE DATABASE ${DATABASE}` },
      ]),
    );
    requireOk(runBatches(DATABASE, SETUP.map((sql, i) => ({ id: `setup ${i}`, sql }))));
    db = createDatabase(sqlv8, buildConfig);
    await db.connect(PROFILE);
    schema = await db.loadSchema();
    resolveColumnKind = columnKindResolver(schema);
  }, 120_000);

  afterAll(async () => {
    await db?.disconnect();
  });

  describe('database service', () => {
    it('rejects a connection that cannot be opened and stays usable', async () => {
      const other = createDatabase(sqlv8, buildConfig);
      await expect(other.connect({ ...PROFILE, database: 'FqsNoSuchDatabase' })).rejects.toThrow();
      await expect(other.loadSchema()).rejects.toThrow('Chưa kết nối máy chủ.');
    });

    it('loads tables, views and column types', () => {
      expect(schema.map((t) => `${t.schema}.${t.name}${t.isView ? ' (view)' : ''}`).sort()).toEqual([
        'dbo.BangLuong', 'dbo.NhanVien', 'dbo.PhongBan', 'dbo.vw_LuongThang (view)',
      ]);
      const columns = Object.fromEntries(schema.find((t) => t.name === 'NhanVien')!.columns.map((c) => [c.name, c]));
      expect(columns.HoTen).toEqual({ name: 'HoTen', dataType: 'nvarchar', maxLength: 100, nullable: false });
      expect(columns.GhiChu).toMatchObject({ dataType: 'nvarchar', maxLength: -1, nullable: true });
      expect(columns.LuongCoBan).toMatchObject({ dataType: 'decimal', nullable: false });
    });

    it('maps column types to the kinds FoxPro would see', () => {
      const tables = [{ name: 'NhanVien', alias: 'n' }, { name: 'dbo.BangLuong', alias: 'b' }];
      const kinds = Object.fromEntries(['HoTen', 'GhiChu', 'NgaySinh', 'NgayVaoLam', 'LuongCoBan', 'NghiViec', 'MaNV', 'Thang', 'Anh'].map((n) => [n, resolveColumnKind(n, { tables })]));
      expect(kinds).toEqual({
        HoTen: 'string', GhiChu: 'varstring', NgaySinh: 'date', NgayVaoLam: 'datetime', LuongCoBan: 'number', NghiViec: 'bool', MaNV: 'string', Thang: 'integer', Anh: undefined,
      });
      // A column is looked up only in the tables of its own statement, and through its qualifier when it has one.
      expect(resolveColumnKind('HoTen', { tables: [{ name: 'BangLuong' }] })).toBeUndefined();
      expect(resolveColumnKind('Thang', { qualifier: 'b', tables })).toBe('integer');
      expect(resolveColumnKind('Thang', { qualifier: 'n', tables })).toBeUndefined();
      expect(resolveColumnKind('HoTen', { tables: [] })).toBeUndefined();
    });

    it('returns every value type as a display-ready cell', async () => {
      const result = await db.execute('types', "SELECT MaNV, HoTen, NgaySinh, NgayVaoLam, LuongCoBan, HeSo, NghiViec, GhiChu, Anh FROM dbo.NhanVien WHERE MaNV IN ('NV001', 'NV002', 'NV004') ORDER BY MaNV", MAX_ROWS);
      expect(result.error).toBeUndefined();
      expect(result.resultSets[0].columns).toEqual(['MaNV', 'HoTen', 'NgaySinh', 'NgayVaoLam', 'LuongCoBan', 'HeSo', 'NghiViec', 'GhiChu', 'Anh']);
      expect(result.resultSets[0].rows).toEqual([
        ['NV001', 'Nguyễn Văn An', '1990-05-17', '2015-03-01 08:00:00', 15000000, 1.5, false, 'Thử việc 2 tháng', '0x00ff10'],
        ['NV002', 'Trần Thị Bình', '1988-12-31', '2012-07-15 08:30:00', 18500000.5, null, false, null, null],
        ['NV004', 'Phạm Đức Văn', '2000-02-29', '2023-11-30 13:45:10', 7200000, 0.85, false, 'thử việc', null],
      ]);
    });

    it('returns several result sets and server messages from one batch', async () => {
      const result = await db.execute('multi', "PRINT N'xin chào'; SELECT 1 AS a; SELECT MaPB FROM dbo.PhongBan ORDER BY MaPB; SELECT 2 AS b WHERE 1 = 0", MAX_ROWS);
      expect(result.error).toBeUndefined();
      expect(result.messages.some((m) => m.includes('xin chào'))).toBe(true);
      expect(result.resultSets.map((s) => ({ columns: s.columns, rows: s.rows }))).toEqual([
        { columns: ['a'], rows: [[1]] },
        { columns: ['MaPB'], rows: [['IT'], ['KT'], ['NS']] },
        { columns: ['b'], rows: [] },
      ]);
    });

    it('reports a server error as data and keeps the session usable', async () => {
      const failed = await db.execute('errors', 'SELECT * FROM dbo.KhongCoBangNay', MAX_ROWS);
      expect(failed.error).toMatch(/KhongCoBangNay/);
      expect(failed.resultSets).toEqual([]);
      const next = await db.execute('errors', 'SELECT COUNT(*) AS n FROM dbo.NhanVien', MAX_ROWS);
      expect(next.resultSets[0].rows).toEqual([[EMPLOYEES.length]]);
    });

    it('stops at the row limit, flags the result and keeps the session usable', async () => {
      const limited = await db.execute('limit', 'SELECT MaNV, Thang FROM dbo.BangLuong ORDER BY MaNV, Thang', 3);
      expect(limited.error).toBeUndefined();
      expect(limited.truncated).toBe(true);
      expect(limited.resultSets[0].rows).toEqual([['NV001', 8], ['NV001', 9], ['NV002', 8]]);

      const exact = await db.execute('limit', 'SELECT MaPB FROM dbo.PhongBan', 3);
      expect(exact.truncated).toBe(false);
      expect(exact.resultSets[0].rows).toHaveLength(3);
    });

    it('keeps temp tables per session and drops them when the session closes', async () => {
      expect((await db.execute('tab-a', 'SELECT MaNV INTO #c FROM dbo.NhanVien WHERE NghiViec = 1', MAX_ROWS)).error).toBeUndefined();
      expect((await db.execute('tab-a', 'SELECT COUNT(*) FROM #c', MAX_ROWS)).resultSets[0].rows).toEqual([[2]]);
      expect((await db.execute('tab-b', 'SELECT COUNT(*) FROM #c', MAX_ROWS)).error).toMatch(/#c/);

      await db.closeSession('tab-a');
      expect((await db.execute('tab-a', 'SELECT COUNT(*) FROM #c', MAX_ROWS)).error).toMatch(/#c/);
    });
  });

  describe('FoxPro queries on Vietnamese data', () => {
    it('compares, searches and transforms Vietnamese text', async () => {
      const session = newSession('vn-text');
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE HoTen = "Nguyễn" ORDER BY MaNV')).toEqual([[['NV001'], ['NV011']]]);
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE "Văn" $ HoTen ORDER BY MaNV')).toEqual([[['NV001'], ['NV004'], ['QL002']]]);
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE "văn" $ HoTen ORDER BY MaNV')).toEqual([[]]);
      expect(await fox(session, 'SELECT MaNV, UPPER(HoTen) AS hoa, LEN(HoTen) AS dai, LEFT(HoTen, AT(" ", HoTen) - 1) AS ho, RIGHT(HoTen, 2) AS cuoi FROM NhanVien WHERE MaNV = "NV0" ORDER BY MaNV')).toEqual([
        EMPLOYEES.filter((e) => e.ma.startsWith('NV0')).sort(byMa).map((e) => [e.ma, e.ten.toUpperCase(), e.ten.length, e.ten.slice(0, e.ten.indexOf(' ')), e.ten.slice(-2)]),
      ]);
      expect(await fox(session, 'SELECT MaNV, PADL(ALLTRIM(STR(LuongCoBan / 1000000, 10, 1)), 6, "0") + " tr" AS luong, STRTRAN(HoTen, " ", "_") AS ten FROM NhanVien WHERE MaNV == "NV002"')).toEqual([
        [['NV002', '0018.5 tr', 'Trần_Thị_Bình']],
      ]);
    });

    it('uses a bit column as a condition and formats it', async () => {
      const session = newSession('vn-bool');
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE NghiViec ORDER BY MaNV')).toEqual([[['NV003'], ['QL002']]]);
      expect(await fox(session, 'SELECT COUNT(*) AS n FROM NhanVien WHERE !NghiViec AND LuongCoBan >= 15000000')).toEqual([
        [[EMPLOYEES.filter((e) => !e.nghi && e.luong >= 15000000).length]],
      ]);
      expect(await fox(session, 'SELECT MaNV, IIF(NghiViec, "Đã nghỉ", "Đang làm") AS tt FROM NhanVien WHERE MaNV = "QL" ORDER BY MaNV')).toEqual([
        [['QL001', 'Đang làm'], ['QL002', 'Đã nghỉ']],
      ]);
    });

    it('treats NULL and blank the FoxPro way, including nvarchar(max) notes', async () => {
      const session = newSession('vn-null');
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE EMPTY(GhiChu) ORDER BY MaNV')).toEqual([[['NV003']]]);
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE ISNULL(GhiChu) ORDER BY MaNV')).toEqual([[['NV002'], ['NV011']]]);
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE ISNULL(GhiChu) OR EMPTY(GhiChu) ORDER BY MaNV')).toEqual([[['NV002'], ['NV003'], ['NV011']]]);
      // A memo has no fixed width: a blank one is "equal" to any literal, as in FoxPro.
      // NV004 ('thử việc') also matches: the database collation is case-insensitive, FoxPro is not.
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE GhiChu = "Thử" ORDER BY MaNV')).toEqual([[['NV001'], ['NV003'], ['NV004']]]);
      expect(await fox(session, 'SELECT MaNV, NVL(HeSo, 1) AS hs, NVL(MaPB, "(chưa có)") AS pb FROM NhanVien WHERE ISNULL(HeSo) OR ISNULL(MaPB) ORDER BY MaNV')).toEqual([
        [['NV002', 1, 'KT'], ['NV010', 1.2, '(chưa có)']],
      ]);
      expect(await fox(session, 'SELECT COUNT(*) AS n FROM NhanVien WHERE EMPTY(NgaySinh)')).toEqual([[[0]]]);
    });

    it('does date arithmetic in days for date columns and in seconds for datetime columns', async () => {
      const session = newSession('vn-date');
      const dayMs = 86_400_000;
      const withBirth = EMPLOYEES.filter((e) => e.sinh !== null).sort(byMa);
      expect(await fox(session, 'SELECT MaNV, {^2026-10-05} - NgaySinh AS ngay, NgaySinh + 1 AS mai, YEAR(NgaySinh) AS nam, DTOC(NgaySinh) AS d FROM NhanVien WHERE !ISNULL(NgaySinh) ORDER BY MaNV')).toEqual([
        withBirth.map((e) => {
          const birth = Date.parse(`${e.sinh}T00:00:00Z`);
          const [y, m, d] = e.sinh!.split('-');
          return [e.ma, (Date.UTC(2026, 9, 5) - birth) / dayMs, new Date(birth + dayMs).toISOString().slice(0, 10), Number(y), `${d}/${m}/${y}`];
        }),
      ]);
      expect(await fox(session, 'SELECT MaNV, {^2026-10-05 00:00:00} - NgayVaoLam AS giay, NgayVaoLam + 3600 AS sau, TTOD(NgayVaoLam) AS ngay FROM NhanVien WHERE MaNV == "NV004"')).toEqual([
        [['NV004', (Date.UTC(2026, 9, 5) - Date.UTC(2023, 10, 30, 13, 45, 10)) / 1000, '2023-11-30 14:45:10', '2023-11-30']],
      ]);
      expect(await fox(session, 'SELECT MaNV FROM NhanVien WHERE BETWEEN(NgaySinh, {^1990-01-01}, {^1999-12-31}) AND MONTH(NgaySinh) # 8 ORDER BY MaNV')).toEqual([[['NV001'], ['NV011']]]);
    });

    it('aggregates with GROUP BY position, including the NULL group', async () => {
      const session = newSession('vn-agg');
      const groups = [null, 'IT', 'KT', 'NS'].map((pb) => {
        const rows = EMPLOYEES.filter((e) => e.pb === pb);
        return [pb, rows.length, Number(sum(rows.map((e) => e.luong)).toFixed(2)), Math.max(...rows.map((e) => e.luong))];
      });
      expect(await fox(session, 'SELECT MaPB, COUNT(*) AS n, SUM(LuongCoBan) AS tong, MAX(LuongCoBan) AS cao FROM NhanVien GROUP BY 1 ORDER BY 1')).toEqual([groups]);
      const average = await fox(session, 'SELECT AVG(LuongCoBan) AS tb, AVG(NVL(HeSo, 1) * 2) AS hs FROM NhanVien');
      expect(average[0][0][0]).toBeCloseTo(sum(EMPLOYEES.map((e) => e.luong)) / EMPLOYEES.length, 2);
      expect(average[0][0][1]).toBeCloseTo(sum(EMPLOYEES.map((e) => (e.heso ?? 1) * 2)) / EMPLOYEES.length, 4);
    });

    it('builds a cursor in one run and reuses it in later runs of the same tab', async () => {
      const session = newSession('vn-cursor');
      const totals = EMPLOYEES.map((e) => ({ e, tong: sum(PAYROLL.filter(([ma]) => ma === e.ma).map(([, , , linh]) => linh)) }));

      expect(await fox(session, 'SELECT b.MaNV, SUM(b.ThucLinh) AS tong, COUNT(*) FROM BangLuong b WHERE b.Nam = 2026 GROUP BY b.MaNV INTO CURSOR curLuong')).toEqual([]);
      expect(session).toMatchObject({ cursors: ['curluong'], currentCursor: 'curluong' });

      const expected = totals.filter((t) => t.tong > 40000000).sort((a, b) => b.tong - a.tong).map((t) => [t.e.ten, t.tong, 2]);
      expect(await fox(session, 'SELECT n.HoTen, c.tong, c.cnt FROM curLuong c JOIN NhanVien n ON n.MaNV = c.MaNV WHERE c.tong > 40000000 ORDER BY c.tong DESC')).toEqual([expected]);

      const small = await fox(session, 'BROWSE FIELDS MaNV FOR tong < 15000000');
      expect(small[0].map(([ma]) => ma).sort()).toEqual(totals.filter((t) => t.tong < 15000000).map((t) => t.e.ma).sort());

      // Another tab has its own session and must not see the cursor.
      const other = await runFoxQuery(db.execute, { id: 'vn-cursor-other', cursors: ['curluong'], currentCursor: 'curluong' }, 'BROWSE', { maxRows: MAX_ROWS });
      expect(other.result?.error).toMatch(/#curluong/);
    });

    it('does not record a cursor when the server rejects the statement', async () => {
      const session = newSession('vn-reject');
      const outcome = await runFoxQuery(db.execute, session, 'SELECT KhongCo FROM NhanVien INTO CURSOR curLoi', { maxRows: MAX_ROWS, resolveColumnKind });
      expect(outcome.result?.error).toMatch(/KhongCo/);
      expect(session.cursors).toEqual([]);
      expect((await runFoxQuery(db.execute, session, 'BROWSE', { maxRows: MAX_ROWS })).conversion.errors[0].message).toContain('cursor');
    });

    it('sends nothing to the server when the source does not convert', async () => {
      const calls: string[] = [];
      const spy: DbBackend['execute'] = (id, sql, max) => (calls.push(sql), db.execute(id, sql, max));
      const outcome = await runFoxQuery(spy, newSession('vn-invalid'), 'SELECT 1 AS a\nREPLACE LuongCoBan WITH 0', { maxRows: MAX_ROWS });
      expect(outcome.conversion.errors).toEqual([{ line: 2, message: 'Lệnh REPLACE chưa được hỗ trợ (chỉ SELECT và BROWSE).' }]);
      expect(outcome.result).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it('reads a view and joins with Vietnamese column aliases', async () => {
      const session = newSession('vn-view');
      const rows = await fox(session, 'SELECT v.HoTen AS [Họ tên], p.TenPB AS [Phòng], v.ThucLinh FROM vw_LuongThang v JOIN NhanVien n ON n.MaNV = v.MaNV LEFT JOIN PhongBan p ON p.MaPB = n.MaPB WHERE v.Thang = 9 AND n.MaNV = "QL" ORDER BY v.ThucLinh DESC');
      expect(rows).toEqual([
        EMPLOYEES.filter((e) => e.ma.startsWith('QL'))
          .map((e) => [e.ten, e.pb === 'IT' ? 'Công nghệ thông tin' : 'Kế toán', PAYROLL.find(([ma, thang]) => ma === e.ma && thang === 9)![3]])
          .sort((a, b) => (b[2] as number) - (a[2] as number)),
      ]);
    });
  });
});
