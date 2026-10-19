import { describe, expect, it } from 'vitest';
import { execTemplate, parseExec, splitExecSegments, tsqlViolation, withoutExecLines } from '../src/shared/procedures';

const batch = ["EXEC dbo.LAMTHAO_PROC_PAYROLL N'2025090000031', N'421A121E', '2025/08' INTO CURSOR bl", 'SUM BasicSalary - CoeffBasicSal * 2700000 FOR DowCode = "2025/08"', 'execute sp_other;', 'SELECT COUNT(*) FROM bl'].join('\n');

describe('EXEC lines in a batch', () => {
  it('are parsed with their optional INTO CURSOR, the rest of the batch kept in order', () => {
    expect(parseExec("EXEC dbo.P @a = 1 INTO CURSOR x")).toEqual({ statement: 'EXEC dbo.P @a = 1', cursor: 'x' });
    expect(parseExec('  execute dbo.P;')).toEqual({ statement: 'EXEC dbo.P', cursor: undefined });
    expect(parseExec('EXEC')).toBeUndefined();
    expect(parseExec('SELECT 1')).toBeUndefined();
    expect(splitExecSegments(batch)).toEqual([
      { kind: 'exec', line: 1, statement: "EXEC dbo.LAMTHAO_PROC_PAYROLL N'2025090000031', N'421A121E', '2025/08'", cursor: 'bl' },
      { kind: 'sql', line: 2, text: 'SUM BasicSalary - CoeffBasicSal * 2700000 FOR DowCode = "2025/08"' },
      { kind: 'exec', line: 3, statement: 'EXEC sp_other', cursor: undefined },
      { kind: 'sql', line: 4, text: 'SELECT COUNT(*) FROM bl' },
    ]);
    expect(splitExecSegments('SELECT 1\n\nSELECT 2')).toEqual([{ kind: 'sql', line: 1, text: 'SELECT 1\n\nSELECT 2' }]);
  });

  it('become comments for the converters, on the same lines', () => {
    expect(withoutExecLines(batch, '*').split('\n')[0]).toBe("* EXEC dbo.LAMTHAO_PROC_PAYROLL N'2025090000031', N'421A121E', '2025/08' INTO CURSOR bl");
    expect(withoutExecLines(batch, '--').split('\n')[2]).toBe('-- execute sp_other;');
  });

  it('get a template with the parameters to fill in', () => {
    expect(execTemplate('dbo.P', [{ name: '@UserID' }, { name: '@DowCode' }], 'kq')).toBe('EXEC dbo.P @UserID = , @DowCode =  INTO CURSOR kq');
    expect(execTemplate('dbo.P', [])).toBe('EXEC dbo.P');
  });
});

describe('T-SQL read-only guard', () => {
  it('refuses statements that write, with the line, and lets temp tables and EXEC through', () => {
    expect(tsqlViolation('SELECT 1\nUPDATE t SET a = 1')).toEqual({ line: 2, message: expect.stringMatching(/^Lệnh UPDATE ghi/) });
    for (const s of ['INSERT INTO t VALUES (1)', 'delete from t', 'TRUNCATE TABLE t', 'DROP TABLE t', 'CREATE TABLE t (a int)', 'ALTER TABLE t ADD b int', 'MERGE t USING s ON 1=1', 'GRANT SELECT ON t TO u']) {
      expect(tsqlViolation(s), s).toBeTruthy();
    }
    for (const s of ['SELECT a INTO #c FROM t', 'DROP TABLE IF EXISTS #c', 'CREATE TABLE #c (a int)', 'EXEC dbo.P 1', 'WITH x AS (SELECT 1 a) SELECT * FROM x', '  -- UPDATE in a comment']) {
      expect(tsqlViolation(s), s).toBeUndefined();
    }
  });
});
