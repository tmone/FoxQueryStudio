/** Cursor that receives the rows of a SELECT with no INTO clause, so they can be read back. */
export const RESULT_CURSOR = 'fqs_r';

export interface RunnableStatement {
  statement: string;
  /** True when the statement leaves its rows in RESULT_CURSOR. */
  dumps: boolean;
}

/** Joins continuation lines and drops comments, returning one string per statement. */
export function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let pending: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    if (!pending.length && rawLine.trimStart().startsWith('*')) continue;
    const line = rawLine.replace(/&&.*$/, '').trimEnd();
    if (!line.trim()) continue;
    pending.push(line);
    if (!line.endsWith(';')) {
      statements.push(pending.join('\n'));
      pending = [];
    }
  }
  if (pending.length) statements.push(pending.join('\n'));
  return statements;
}

/**
 * Turns the statements into ones that leave their rows in a cursor instead of
 * opening a Browse window, and tells which statements produce a result set.
 */
export function toRunnable(source: string): RunnableStatement[] {
  let current: string | undefined;
  return splitStatements(source).map((statement) => {
    const browse = /^\s*BROWSE\b(.*)$/is.exec(statement);
    if (browse) {
      const fields = /\bFIELDS\b(.*?)(?=\bFOR\b|$)/is.exec(browse[1])?.[1].trim() || '*';
      const condition = /\bFOR\b(.*)$/is.exec(browse[1])?.[1].trim();
      const where = condition ? ` WHERE ${condition}` : '';
      return { statement: `SELECT ${fields} FROM ${current}${where} INTO CURSOR ${RESULT_CURSOR}`, dumps: true };
    }
    const workArea = /^\s*SELECT\s+(\w+)\s*$/i.exec(statement);
    if (workArea) {
      current = workArea[1];
      return { statement, dumps: false };
    }
    const into = /\bINTO\s+CURSOR\s+(\w+)/i.exec(statement);
    if (into) {
      current = into[1];
      return { statement, dumps: false };
    }
    return { statement: `${statement} INTO CURSOR ${RESULT_CURSOR}`, dumps: true };
  });
}

/**
 * Why a statement may not run in the read-only tool, or undefined when it may.
 * Only queries are let through: nothing that changes a table or writes a file.
 */
export function readOnlyViolation(statement: string): string | undefined {
  if (!/^\s*(SELECT|BROWSE)\b/i.test(statement)) return 'Chỉ chạy được lệnh SELECT (và BROWSE); công cụ này chỉ đọc dữ liệu.';
  if (/\bINTO\s+(TABLE|DBF|ARRAY)\b/i.test(statement) || /\bTO\s+(FILE|PRINTER)\b/i.test(statement)) return 'Chỉ hỗ trợ INTO CURSOR; không ghi kết quả ra bảng, mảng hay tệp.';
  return undefined;
}
