import { describe, expect, it } from 'vitest';
import { readOnlyViolation, splitStatements, toRunnable } from '../src/shared/fox-statements';

describe('read-only guard for FoxPro statements', () => {
  it('lets queries through', () => {
    for (const s of ['SELECT * FROM nv', 'select a, b from nv where x = 1 INTO CURSOR c', 'BROWSE FIELDS a FOR b > 1', 'SELECT ALLTRIM(ten), VAL(x) FROM nv']) {
      expect(readOnlyViolation(s), s).toBeUndefined();
    }
  });

  it('refuses commands that change data or write files', () => {
    for (const s of ['DELETE FROM nv', 'UPDATE nv SET a = 1', 'USE nv', 'ZAP', 'SELECT * FROM nv INTO TABLE x', 'SELECT * FROM nv TO FILE x']) {
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
