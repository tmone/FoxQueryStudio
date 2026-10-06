import { convertFoxPro, type ColumnKindResolver, type ConvertResult } from '../converter';
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
