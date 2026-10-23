import { convertFoxPro, type ColumnKindResolver, type ConvertResult, type Diagnostic } from '../converter';
import { convertTsql, type ReverseOptions, type ReverseResult } from '../converter/reverse';
import { mismatchHint, toRunnable } from './fox-statements';
import { splitExecSegments, tsqlViolation, withoutExecLines, type ExecSegment } from './procedures';
import type { DbBackend, ExecuteResult } from './types';

/** A query tab: its server session and the cursors that session holds as #temp tables. */
export interface QuerySession {
  id: string;
  cursors: string[];
  currentCursor?: string;
  /** Table opened with USE, current until a cursor takes its place. */
  currentTable?: string;
}

export interface QueryOptions {
  maxRows: number;
  resolveColumnKind?: ColumnKindResolver;
  /** Called once the source has converted cleanly, right before it is sent to the server. */
  onExecute?: () => void;
  /** Runs an EXEC line (rolled back on the server); without it, EXEC is refused. */
  callProcedure?: (sessionId: string, statement: string, maxRows: number, cursor?: string) => Promise<ExecuteResult>;
}

const failed = (error: string): ExecuteResult => ({ resultSets: [], messages: [], error, truncated: false, elapsedMs: 0 });

/** Two results as one: the sets and messages in order, the first error, the time added up. */
function merge(a: ExecuteResult | undefined, b: ExecuteResult): ExecuteResult {
  if (!a) return b;
  return { resultSets: [...a.resultSets, ...b.resultSets], messages: [...a.messages, ...b.messages], error: a.error ?? b.error, truncated: a.truncated || b.truncated, sessionReset: a.sessionReset || b.sessionReset, elapsedMs: a.elapsedMs + b.elapsedMs };
}

/**
 * Runs the batch segment by segment: ordinary SQL through `runSql`, each EXEC line through the
 * procedure call, whose cursor then exists for the segments after it. Stops at the first error.
 */
async function runSegments(session: QuerySession, source: string, options: QueryOptions, runSql: (text: string) => Promise<ExecuteResult | undefined>): Promise<ExecuteResult | undefined> {
  let result: ExecuteResult | undefined;
  for (const segment of splitExecSegments(source)) {
    const outcome = segment.kind === 'sql' ? await runSql(segment.text) : await runExec(session, segment, options);
    if (!outcome) continue;
    result = merge(result, outcome);
    if (result.error) break;
  }
  return result;
}

async function runExec(session: QuerySession, segment: ExecSegment, options: QueryOptions): Promise<ExecuteResult> {
  if (!options.callProcedure) return failed(`Dòng ${segment.line}: EXEC chỉ chạy được trên kết nối SQL Server.`);
  options.onExecute?.();
  let result: ExecuteResult;
  try {
    result = await options.callProcedure(session.id, segment.statement, options.maxRows, segment.cursor);
  } catch (e) {
    result = failed((e as Error).message);
  }
  if (result.sessionReset) {
    session.cursors = [];
    session.currentCursor = undefined;
    session.currentTable = undefined;
  } else if (!result.error && segment.cursor) {
    session.cursors = [...new Set([...session.cursors, segment.cursor])];
    session.currentCursor = segment.cursor;
  }
  return result;
}

/** Cursors the batch's EXEC lines make, so the SQL after them converts as if they existed already. */
const execCursors = (source: string) => splitExecSegments(source).flatMap((s) => (s.kind === 'exec' && s.cursor ? [s.cursor] : []));

/** The cursor an EXEC INTO CURSOR leaves current before the first ordinary SQL of the batch, if any. */
function cursorBeforeSql(source: string): string | undefined {
  let current: string | undefined;
  for (const segment of splitExecSegments(source)) {
    if (segment.kind === 'sql') break;
    if (segment.cursor) current = segment.cursor;
  }
  return current;
}

export interface QueryOutcome {
  conversion: ConvertResult;
  /** Absent when nothing was sent: conversion errors, or statements that only select a cursor. */
  result?: ExecuteResult;
}

/**
 * Converts FoxPro source and runs it in the tab's session. The session's cursor list
 * is updated only when the server accepted the batch, so it never names a cursor
 * that was not created.
 */
export async function runFoxQuery(execute: DbBackend['execute'], session: QuerySession, source: string, options: QueryOptions): Promise<QueryOutcome> {
  // EXEC lines run on their own; the converter sees them as comments and knows the cursors they make.
  const conversion = convertFoxPro(withoutExecLines(source, '*'), {
    knownCursors: [...session.cursors, ...execCursors(source)],
    currentCursor: cursorBeforeSql(source) ?? session.currentCursor,
    currentTable: session.currentTable,
    resolveColumnKind: options.resolveColumnKind,
  });
  if (conversion.errors.length) return { conversion };

  const accept = () => {
    session.cursors = [...new Set([...session.cursors, ...conversion.cursors])];
    session.currentCursor = conversion.currentCursor;
    session.currentTable = conversion.currentTable;
  };
  // Each SQL segment is the converted form of its own lines, run in place.
  const result = await runSegments(session, source, options, async (text) => {
    const part = convertFoxPro(text, { knownCursors: session.cursors, currentCursor: session.currentCursor, currentTable: session.currentTable, resolveColumnKind: options.resolveColumnKind });
    if (!part.sql) {
      session.cursors = [...new Set([...session.cursors, ...part.cursors])];
      session.currentCursor = part.currentCursor;
      session.currentTable = part.currentTable;
      return undefined;
    }
    options.onExecute?.();
    let outcome: ExecuteResult;
    try {
      outcome = await execute(session.id, part.sql, options.maxRows);
    } catch (e) {
      outcome = failed((e as Error).message);
    }
    if (outcome.sessionReset) {
      session.cursors = [];
      session.currentCursor = undefined;
      session.currentTable = undefined;
    } else if (!outcome.error) {
      session.cursors = [...new Set([...session.cursors, ...part.cursors])];
      session.currentCursor = part.currentCursor;
      session.currentTable = part.currentTable;
    }
    return outcome;
  });
  if (!result) accept();
  if (result && !result.error) result.messages.push(...mismatchHints(source, result, session.currentCursor ?? session.currentTable));
  return { conversion, result };
}

/**
 * On SQL Server a `SUM stored - formula` comes back as a one-row set; when it is not 0 the message
 * offers the query that lists the rows at fault, as the FoxPro engine does for the same check.
 */
function mismatchHints(source: string, result: ExecuteResult, table: string | undefined): string[] {
  if (!table) return [];
  const hints: string[] = [];
  let set = 0;
  for (const statement of toRunnable(withoutExecLines(source, '*'))) {
    if (!statement.calc && !statement.shows) continue;
    const rows = result.resultSets[set++];
    if (!statement.calc || statement.calc.kind !== 'array' || !rows) continue;
    statement.calc.labels.forEach((label, i) => {
      const hint = mismatchHint(label, rows.rows[0]?.[i], table, statement.calc?.condition);
      if (hint) hints.push(hint);
    });
  }
  return hints;
}

export interface TsqlOutcome {
  /** The FoxPro form of the source; its errors do not stop the run. */
  conversion: ReverseResult;
  /** Absent when the source is blank. */
  result?: ExecuteResult;
}

/**
 * Runs T-SQL as written in the tab's session and translates it to FoxPro alongside.
 * The #temp tables it creates join the session's cursors, so a later FoxPro query can read them.
 */
export async function runTsqlQuery(
  execute: DbBackend['execute'],
  session: QuerySession,
  source: string,
  options: Pick<QueryOptions, 'maxRows' | 'onExecute' | 'callProcedure'> & ReverseOptions,
): Promise<TsqlOutcome> {
  const conversion = convertTsql(withoutExecLines(source, '--'), options);
  if (!source.trim()) return { conversion };
  // T-SQL runs as written, so the read-only promise is kept here: nothing that writes is sent.
  const violation = tsqlViolation(source);
  if (violation) return { conversion, result: failed(`Dòng ${violation.line}: ${violation.message}`) };

  const result = await runSegments(session, source, options, async (text) => {
    options.onExecute?.();
    let outcome: ExecuteResult;
    try {
      outcome = await execute(session.id, text, options.maxRows);
    } catch (e) {
      outcome = failed((e as Error).message);
    }
    if (outcome.sessionReset) {
      session.cursors = [];
      session.currentCursor = undefined;
      session.currentTable = undefined;
    } else if (!outcome.error) {
      session.cursors = [...new Set([...session.cursors, ...convertTsql(text, options).cursors])];
    }
    return outcome;
  });
  return { conversion, result };
}

export interface FoxProOutcome {
  /** The source in the other language; empty when it does not translate. */
  translation: string;
  /** Why the source cannot run; set only for T-SQL that FoxPro has no form for. */
  errors: Diagnostic[];
  /** Translation problems that do not stop the run, and converter warnings. */
  warnings: Diagnostic[];
  /** Absent when nothing was sent. */
  result?: ExecuteResult;
}

/**
 * Runs a tab on a FoxPro database, where FoxPro is the engine: FoxPro source goes as
 * written, T-SQL is first turned into FoxPro. `execute` takes FoxPro source.
 */
export async function runOnFoxPro(
  execute: DbBackend['execute'],
  session: QuerySession,
  source: string,
  language: 'foxpro' | 'tsql',
  options: Pick<QueryOptions, 'maxRows' | 'onExecute'> & ReverseOptions,
): Promise<FoxProOutcome> {
  let foxSource = source;
  let translation: string;
  let warnings: Diagnostic[];
  let accept: () => void;

  if (language === 'foxpro') {
    // FoxPro is the authority on its own syntax; the T-SQL form is only shown alongside.
    const conversion = convertFoxPro(source, { knownCursors: session.cursors, currentCursor: session.currentCursor, currentTable: session.currentTable, resolveColumnKind: options.resolveColumnKind });
    translation = conversion.sql;
    warnings = [...conversion.errors, ...conversion.warnings];
    accept = () => {
      if (conversion.errors.length) return;
      session.cursors = conversion.cursors;
      session.currentCursor = conversion.currentCursor;
      session.currentTable = conversion.currentTable;
    };
  } else {
    const conversion = convertTsql(source, options);
    if (conversion.errors.length) return { translation: '', errors: conversion.errors, warnings: conversion.warnings };
    foxSource = conversion.foxpro;
    translation = conversion.foxpro;
    warnings = conversion.warnings;
    accept = () => {
      session.cursors = [...new Set([...session.cursors, ...conversion.cursors])];
    };
  }
  if (!foxSource.trim()) return { translation, errors: [], warnings };

  options.onExecute?.();
  let result: ExecuteResult;
  try {
    result = await execute(session.id, foxSource, options.maxRows);
  } catch (e) {
    result = { resultSets: [], messages: [], error: (e as Error).message, truncated: false, elapsedMs: 0 };
  }
  if (result.sessionReset) {
    session.cursors = [];
    session.currentCursor = undefined;
    session.currentTable = undefined;
  } else if (!result.error) {
    accept();
  }
  return { translation, errors: [], warnings, result };
}
