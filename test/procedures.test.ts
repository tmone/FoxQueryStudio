import { describe, expect, it } from 'vitest';
import { cursorNameFor, execStatement, execTemplate, parseExec, splitExecSegments, sqlLiteral, tsqlViolation, withoutExecLines } from '../src/shared/procedures';

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

  it('are built from values typed in a dialog, quoted as T-SQL needs', () => {
    expect(sqlLiteral('2025/08')).toBe("N'2025/08'");
    expect(sqlLiteral(" 421A121E-385E-4FF6-9C1E-4B2018F46E0B ")).toBe("N'421A121E-385E-4FF6-9C1E-4B2018F46E0B'");
    expect(sqlLiteral('26')).toBe('26');
    expect(sqlLiteral('-1.5')).toBe('-1.5');
    expect(sqlLiteral("N'đã có'")).toBe("N'đã có'");
    expect(sqlLiteral("'x'")).toBe("'x'");
    expect(sqlLiteral('')).toBe('NULL');
    expect(sqlLiteral('null')).toBe('NULL');
    expect(sqlLiteral("O'Brien")).toBe("N'O''Brien'");
    expect(execStatement('dbo.LAMTHAO_PROC_PAYROLL', [{ name: '@UserID', value: '2025090000031' }, { name: '@reportID', value: '421A121E' }, { name: '@DowCode', value: '2025/08' }])).toBe(
      "EXEC dbo.LAMTHAO_PROC_PAYROLL @UserID = 2025090000031, @reportID = N'421A121E', @DowCode = N'2025/08'",
    );
    expect(execStatement('dbo.P', [])).toBe('EXEC dbo.P');
    expect(cursorNameFor('LAMTHAO_PROC_PAYROLL')).toBe('lamthao_proc_payroll');
    expect(cursorNameFor('1 Báo cáo')).toBe('_1_b_o_c_o');
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
