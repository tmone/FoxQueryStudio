import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFoxPro } from '../src/converter';

// Runs converted SQL on a real SQL Server (LocalDB) to prove the ODBC escapes
// and function mappings are accepted by the engine, not just string-equal.
const SERVER = '(localdb)\\MSSQLLocalDB';

function sqlcmd(args: string[]): string {
  return execFileSync('sqlcmd', ['-S', SERVER, '-d', 'tempdb', '-b', '-I', ...args], { encoding: 'utf8', timeout: 60_000 });
}

function isAvailable(): boolean {
  try {
    sqlcmd(['-Q', 'SELECT 1']);
    return true;
  } catch {
    return false;
  }
}

const SETUP = `
SET NOCOUNT ON;
DROP TABLE IF EXISTS dbo.fqs_nv;
CREATE TABLE dbo.fqs_nv (ma varchar(10), ten nvarchar(50), luong decimal(18,2), ngay date, active bit);
INSERT INTO dbo.fqs_nv VALUES
  ('  a01 ', N'Nguyễn Văn An', 1500.50, '2026-01-05', 1),
  ('b02', N'Trần Bình', NULL, '2025-12-31', 0),
  ('c03', N'', 0, NULL, 1);
`;

function run(foxpro: string): string[] {
  const converted = convertFoxPro(foxpro, {
    resolveColumnKind: (name) => ({ ten: 'string', luong: 'number' }) [name.toLowerCase()] as 'string' | 'number' | undefined,
  });
  expect(converted.errors).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), 'fqs-'));
  try {
    const file = join(dir, 'batch.sql');
    writeFileSync(file, `﻿${SETUP}\n${converted.sql};\nDROP TABLE dbo.fqs_nv;\n`, 'utf8');
    // Results go through a UTF-8 file: sqlcmd's stdout follows the console code page, which mangles Vietnamese.
    const out = join(dir, 'out.txt');
    sqlcmd(['-i', file, '-o', out, '-f', '65001', '-u', '-h', '-1', '-W', '-s', '|']);
    return readFileSync(out, 'utf16le').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!isAvailable())('converted SQL on SQL Server LocalDB', () => {
  it('runs string, null, date functions and cursor flow', () => {
    const rows = run(
      [
        'SELECT ALLTRIM(ma) AS ma, UPPER(ten) AS ten, NVL(luong, 0) AS luong, DTOC(ngay) AS ngay, ;',
        '  PADL(ALLTRIM(ma), 6, "0") AS ma6, SUBSTR(ten, 1, 6) AS ho, LEN(ALLTRIM(ma)) AS n, ;',
        '  AT("V", ten) AS p, YEAR(ngay) AS nam ;',
        '  FROM fqs_nv WHERE active = .T. AND ngay >= {^2026-01-01} AND "Văn" $ ten INTO CURSOR c1',
        'BROWSE',
      ].join('\n'),
    );
    expect(rows).toEqual(['a01|NGUYỄN VĂN AN|1500.50|05/01/2026|000a01|Nguyễn|3|8|2026']);
  });

  it('runs EMPTY and Vietnamese comparison', () => {
    expect(run("SELECT COUNT(*) AS n FROM fqs_nv WHERE EMPTY(ten) OR ten = 'Trần Bình' OR EMPTY(luong) AND ma = 'zz'")).toEqual(['2']);
  });

  it('runs numeric and date helpers', () => {
    const rows = run(
      [
        "SELECT INT(-2.7) AS i, MOD(7, 3) AS m, STRTRAN('abc', 'b', 'x') AS s, DAY({^2026-03-09}) AS dd, ;",
        "  GOMONTH({^2026-01-31}, 1) AS g, DTOS({^2026-03-09 10:11:12}) AS ds, CTOD('09/03/2026') AS cd, ;",
        "  ATC('B', 'abc') AS atc FROM fqs_nv WHERE ma = 'b02' AND BETWEEN(MONTH(ngay), 12, 12) AND INLIST(ma, 'b02', 'x') ;",
        '  AND DATE() > {^2000-01-01} AND DATETIME() > {^2000-01-01 00:00:00} AND TRIM(LTRIM(ma)) == LOWER("B02") ;',
        "  AND LEFT(ma, 1) + RIGHT(ma, 1) = 'b2' AND HOUR({^2026-03-09 10:11:12}) = 10",
      ].join('\n'),
    );
    // An ODBC {d ...} literal is a datetime on SQL Server, so GOMONTH returns datetime.
    expect(rows).toEqual(['-2.0|1|axc|9|2026-02-28 00:00:00.000|20260309|2026-03-09|2']);
  });
});
