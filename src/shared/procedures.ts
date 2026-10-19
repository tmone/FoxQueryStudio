/**
 * Stored procedures on SQL Server, used the way a FoxPro user works: the result of
 * `EXEC proc args INTO CURSOR name` becomes a cursor (a #temp table of the session) that
 * SUM, COUNT, BROWSE and SELECT then read like a table. A procedure runs inside a
 * transaction that is rolled back, so whatever it writes is undone: the tool stays read-only.
 */

export interface ExecSegment {
  kind: 'exec';
  /** 1-based line of the EXEC in the source. */
  line: number;
  /** The EXEC statement as the server gets it, without the INTO CURSOR part. */
  statement: string;
  /** Lower-cased cursor name, when the result is kept. */
  cursor?: string;
}

export interface SqlSegment {
  kind: 'sql';
  /** 1-based line the segment starts on. */
  line: number;
  text: string;
}

export type Segment = ExecSegment | SqlSegment;

const EXEC_LINE = /^\s*EXEC(?:UTE)?\s+(.*?)(?:\s+INTO\s+CURSOR\s+(\w+))?\s*;?\s*$/i;

/** Parses one EXEC line; undefined when the line is not one. */
export function parseExec(line: string): { statement: string; cursor?: string } | undefined {
  const match = EXEC_LINE.exec(line);
  if (!match || !match[1].trim()) return undefined;
  return { statement: `EXEC ${match[1].trim()}`, cursor: match[2]?.toLowerCase() };
}

/**
 * Splits a batch into runs of ordinary SQL and single EXEC lines, in source order. An EXEC
 * takes one line (its arguments on the same line), as it is typed in practice.
 */
export function splitExecSegments(source: string): Segment[] {
  const segments: Segment[] = [];
  let pending: string[] = [];
  let pendingLine = 1;
  const flush = () => {
    if (pending.some((l) => l.trim())) segments.push({ kind: 'sql', line: pendingLine, text: pending.join('\n') });
    pending = [];
  };
  source.split(/\r?\n/).forEach((line, i) => {
    const exec = parseExec(line);
    if (exec) {
      flush();
      segments.push({ kind: 'exec', line: i + 1, ...exec });
      pendingLine = i + 2;
    } else {
      if (!pending.length) pendingLine = i + 1;
      pending.push(line);
    }
  });
  flush();
  return segments;
}

/** The source with every EXEC line turned into a comment, so a converter sees only ordinary SQL on the same line numbers. */
export function withoutExecLines(source: string, comment: '*' | '--'): string {
  return source
    .split(/\r?\n/)
    .map((line) => (parseExec(line) ? `${comment} ${line.trim()}` : line))
    .join('\n');
}

/** Statements a read-only tool never sends; SELECT … INTO #temp and EXEC (rolled back) are not among them. */
const WRITE_STATEMENTS = /^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|DENY|BULK|BACKUP|RESTORE|KILL|SHUTDOWN|DBCC|ENABLE|DISABLE|OPENROWSET)\b/i;
/** Temp tables are the session's cursors; making or dropping them is part of reading. */
const TEMP_TABLE_STATEMENT = /^\s*(DROP\s+TABLE\s+(IF\s+EXISTS\s+)?|CREATE\s+TABLE\s+)#\w+/i;

/** Why a T-SQL batch may not run as written: the first line that writes, with its number. */
export function tsqlViolation(source: string): { line: number; message: string } | undefined {
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (WRITE_STATEMENTS.test(line) && !TEMP_TABLE_STATEMENT.test(line)) {
      const word = /^\s*(\w+)/.exec(line)![1].toUpperCase();
      return { line: i + 1, message: `Lệnh ${word} ghi hoặc đổi cấu trúc dữ liệu; công cụ này chỉ đọc. Thủ tục chạy bằng EXEC được rollback nên vẫn dùng được.` };
    }
  }
  return undefined;
}

/** `EXEC dbo.Name @p1 = , @p2 = ` as a starting point for the user. */
export function execTemplate(qualifiedName: string, parameters: { name: string }[], cursor?: string): string {
  const args = parameters.map((p) => `${p.name} = `).join(', ');
  return `EXEC ${qualifiedName}${args ? ` ${args}` : ''}${cursor ? ` INTO CURSOR ${cursor}` : ''}`;
}
