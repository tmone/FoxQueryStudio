import { describe, expect, it } from 'vitest';
import { mismatchHint, readOnlyViolation, splitStatements, splitTopLevel, toRunnable } from '../src/shared/fox-statements';

describe('runnable statements', () => {
  it('shows the rows of a plain SELECT, of BROWSE and of a named cursor, which stays', () => {
    expect(toRunnable('SELECT * FROM nv')).toEqual([{ statement: 'SELECT * FROM nv INTO CURSOR fqs_r', shows: 'fqs_r' }]);
    expect(toRunnable('SELECT * FROM nv INTO CURSOR c1\nSELECT c1\nBROWSE FIELDS a')).toEqual([
      { statement: 'SELECT * FROM nv INTO CURSOR c1', shows: 'c1' },
      { statement: 'SELECT c1' },
      { statement: 'SELECT a FROM (ALIAS()) INTO CURSOR fqs_r', shows: 'fqs_r' },
    ]);
  });

  it('opens tables read-only with USE and reads figures back from SUM, AVERAGE, CALCULATE and COUNT', () => {
    expect(toRunnable('USE luong\nUSE d:\\data\\luong.dbf ALIAS l NOUPDATE\nUSE')).toEqual([
      { statement: 'SELECT 0\nUSE luong SHARED NOUPDATE' },
      { statement: 'SELECT 0\nUSE d:\\data\\luong.dbf ALIAS l NOUPDATE' },
      { statement: 'USE' },
    ]);
    expect(toRunnable('SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/CCD*HSL, TCD FOR ma = "A" TO x, y')).toEqual([
      { statement: 'SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/CCD*HSL, TCD FOR ma = "A" TO ARRAY gaCalc', calc: { kind: 'array', labels: ['TP-LC*HSDC*2700000*DIEMP/9.8*CP/CCD*HSL', 'TCD'], condition: 'ma = "A"' } },
    ]);
    expect(toRunnable('SUM a FOR b > 1 WHILE c TO x')[0].calc?.condition).toBe('b > 1');
    expect(toRunnable('SUM a FOR "for" $ x')[0].calc?.condition).toBe('"for" $ x');
    expect(toRunnable('SUM')).toEqual([{ statement: 'SUM TO ARRAY gaCalc', calc: { kind: 'array', labels: [] } }]);
    expect(toRunnable('AVERAGE IIF(a > 1, b, c), ROUND(d, 2) WHILE x NOOPTIMIZE TO ARRAY m')).toEqual([
      { statement: 'AVERAGE IIF(a > 1, b, c), ROUND(d, 2) WHILE x TO ARRAY gaCalc', calc: { kind: 'array', labels: ['IIF(a > 1, b, c)', 'ROUND(d, 2)'] } },
    ]);
    expect(toRunnable('COUNT FOR luong > 0 TO n')).toEqual([{ statement: 'COUNT FOR luong > 0 TO gnCalc', calc: { kind: 'value', labels: ['count'], condition: 'luong > 0' } }]);
    expect(toRunnable('calculate CNT(), MAX(luong) for "rest" $ ten')).toEqual([
      { statement: 'CALCULATE CNT(), MAX(luong) for "rest" $ ten TO ARRAY gaCalc', calc: { kind: 'array', labels: ['CNT()', 'MAX(luong)'], condition: '"rest" $ ten' } },
    ]);
    expect(splitTopLevel('a, IIF(b, c, d), "x,y", [p,q]')).toEqual(['a', 'IIF(b, c, d)', '"x,y"', '[p,q]']);
  });

  it('suggests the rows at fault when a stored-minus-formula check is not 0', () => {
    expect(mismatchHint('TP-LC*HSDC*2', 12.5, 'luong')).toBe('TP-LC*HSDC*2 = 12.5, khác 0 nên có dòng tính sai. Liệt kê các dòng lệch: SELECT *, TP-LC*HSDC*2 AS lech FROM luong WHERE ABS(TP-LC*HSDC*2) > 0.005');
    expect(mismatchHint('TP-LC*HSDC*2', 12.5, 'luong', 'thang = 9')).toBe('TP-LC*HSDC*2 = 12.5, khác 0 nên có dòng tính sai. Liệt kê các dòng lệch: SELECT *, TP-LC*HSDC*2 AS lech FROM luong WHERE (thang = 9) AND ABS(TP-LC*HSDC*2) > 0.005');
    expect(mismatchHint('TP-LC*HSDC*2', 0, 'luong')).toBeUndefined();
    expect(mismatchHint('TP-LC*HSDC*2', 0.001, 'luong')).toBeUndefined();
    expect(mismatchHint('TCD', 5, 'luong')).toBeUndefined();
    expect(mismatchHint('TP - X', null, 'luong')).toBeUndefined();
    expect(mismatchHint('TP - X', 3, '')).toBeUndefined();
  });
});

describe('read-only guard for FoxPro statements', () => {
  it('lets queries through', () => {
    for (const s of ['SELECT * FROM nv', 'select a, b from nv where x = 1 INTO CURSOR c', 'BROWSE FIELDS a FOR b > 1', 'SELECT ALLTRIM(ten), VAL(x) FROM nv', 'USE nv', 'SUM a - b*2 FOR c', 'COUNT TO n', 'AVERAGE x', 'CALCULATE CNT()']) {
      expect(readOnlyViolation(s), s).toBeUndefined();
    }
  });

  it('refuses commands that change data or write files', () => {
    for (const s of ['DELETE FROM nv', 'UPDATE nv SET a = 1', 'REPLACE a WITH 1', 'ZAP', 'SELECT * FROM nv INTO TABLE x', 'SELECT * FROM nv TO FILE x', 'SET SAFETY OFF']) {
      expect(readOnlyViolation(s), s).toBeTruthy();
    }
  });

  it('refuses functions FoxPro would run inside a SELECT that act outside the query', () => {
    const cases = [
      'SELECT EXECSCRIPT("DELETE ALL") FROM nv',
      'SELECT execscript ("ZAP") AS x FROM nv',
      String.raw`SELECT STRTOFILE(ten, 'c:\x.txt') FROM nv`,
      'SELECT EVALUATE(ten) FROM nv',
      'SELECT SYS(2015) FROM nv',
      'SELECT CREATEOBJECT("Scripting.FileSystemObject") FROM nv',
      'SELECT a FROM nv WHERE FCREATE("x") > 0',
    ];
    for (const s of cases) expect(readOnlyViolation(s), s).toMatch(/không được dùng/);
    expect(readOnlyViolation('SELECT * FROM nv WHERE ten = "&cmd"')).toMatch(/macro/);
  });

  it('checks every statement of a batch, continuation lines included', () => {
    const batch = 'SELECT a FROM nv ;\n  WHERE b = 1\nSELECT EXECSCRIPT("x") FROM nv';
    expect(splitStatements(batch)).toHaveLength(2);
    expect(toRunnable(batch).map((s) => readOnlyViolation(s.statement)).filter(Boolean)).toHaveLength(1);
  });
});
