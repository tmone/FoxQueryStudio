import { convertFoxPro, type ColumnKindResolver, type ConvertResult, type Diagnostic } from '../converter';
import { convertTsql, type ReverseOptions, type ReverseResult } from '../converter/reverse';
import type { DbApi, ExecuteResult } from './types';

/** A query tab: its server session and the cursors that session holds as #temp tables. */
export interface QuerySession {
  id: string;
  cursors: string[];
  currentCursor?: string;
}

export interface QueryOptions {
  maxRows: number;
  resolveColumnKind?: ColumnKindResolver;
  /** Called once the source has converted cleanly, right before it is sent to the server. */
  onExecute?: () => void;
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
export async function runFoxQuery(execute: DbApi['execute'], session: QuerySession, source: string, options: QueryOptions): Promise<QueryOutcome> {
  const conversion = convertFoxPro(source, {
    knownCursors: session.cursors,
    currentCursor: session.currentCursor,
    resolveColumnKind: options.resolveColumnKind,
  });
  if (conversion.errors.length) return { conversion };

  const accept = () => {
    session.cursors = conversion.cursors;
    session.currentCursor = conversion.currentCursor;
  };
  if (!conversion.sql) {
    accept();
    return { conversion };
  }

  options.onExecute?.();
  let result: ExecuteResult;
  try {
    result = await execute(session.id, conversion.sql, options.maxRows);
  } catch (e) {
    result = { resultSets: [], messages: [], error: (e as Error).message, truncated: false, elapsedMs: 0 };
  }
  if (result.sessionReset) {
    session.cursors = [];
    session.currentCursor = undefined;
  } else if (!result.error) {
    accept();
  }
  return { conversion, result };
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
  execute: DbApi['execute'],
  session: QuerySession,
  source: string,
  options: Pick<QueryOptions, 'maxRows' | 'onExecute'> & ReverseOptions,
): Promise<TsqlOutcome> {
  const conversion = convertTsql(source, options);
  if (!source.trim()) return { conversion };

  options.onExecute?.();
  let result: ExecuteResult;
  try {
    result = await execute(session.id, source, options.maxRows);
  } catch (e) {
    result = { resultSets: [], messages: [], error: (e as Error).message, truncated: false, elapsedMs: 0 };
  }
  if (result.sessionReset) {
    session.cursors = [];
    session.currentCursor = undefined;
  } else if (!result.error) {
    session.cursors = [...new Set([...session.cursors, ...conversion.cursors])];
  }
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
  execute: DbApi['execute'],
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
    const conversion = convertFoxPro(source, { knownCursors: session.cursors, currentCursor: session.currentCursor, resolveColumnKind: options.resolveColumnKind });
    translation = conversion.sql;
    warnings = [...conversion.errors, ...conversion.warnings];
    accept = () => {
      if (conversion.errors.length) return;
      session.cursors = conversion.cursors;
      session.currentCursor = conversion.currentCursor;
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
  } else if (!result.error) {
    accept();
  }
  return { translation, errors: [], warnings, result };
}
