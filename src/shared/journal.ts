/**
 * What the program remembers about queries: every run (the history, kept for later
 * investigation) and the queries the user marked to run again (bookmarks).
 */

export type JournalLanguage = 'foxpro' | 'tsql';

/** One run of a query, as it happened. */
export interface HistoryEntry {
  id: string;
  /** When the run finished, ISO 8601 with offset. */
  at: string;
  /** The connection as the explorer names it, e.g. `172.20.4.106\SQL2022 (sa)` or `FoxPro (…\northwind.dbc)`. */
  connection: string;
  database?: string;
  language: JournalLanguage;
  sql: string;
  elapsedMs: number;
  /** Rows of all result sets together; absent when the run failed. */
  rows?: number;
  error?: string;
}

/** A query the user keeps by name. */
export interface Bookmark {
  id: string;
  name: string;
  language: JournalLanguage;
  sql: string;
  /** Values of the parameters (Vietnamese phrases) in the sql, so the bookmark runs without asking. */
  params?: Record<string, string>;
  /** The procedure (schema.name) whose result the sql reads; run first when the tab has no work area. */
  procedure?: string;
  createdAt: string;
}

export interface HistoryFilter {
  /** Matched against the SQL, the connection and the database, case-insensitively. */
  text?: string;
  /** Newest first; default and maximum are set by the store. */
  limit?: number;
}

/** Journal operations exposed to the window. */
export interface JournalApi {
  history(filter?: HistoryFilter): Promise<HistoryEntry[]>;
  record(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<HistoryEntry>;
  clearHistory(): Promise<void>;
  /** Where the history file is, for investigation outside the program. */
  historyPath(): Promise<string>;
  bookmarks(): Promise<Bookmark[]>;
  /** Adds the bookmark, or replaces the one with the same id. */
  saveBookmark(bookmark: Omit<Bookmark, 'id' | 'createdAt'> & { id?: string }): Promise<Bookmark>;
  removeBookmark(id: string): Promise<void>;
}

/** The first non-empty line of a query, for lists. */
export function queryTitle(sql: string, maxLength = 120): string {
  const line = sql.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('*') && !l.startsWith('--')) ?? sql.trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

const SAME_DAY_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
const OTHER_DAY_FORMAT: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };

/** A run's time as the list shows it: the time of day for today, date and time otherwise. */
export function formatRunTime(at: string, now = new Date()): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString('vi-VN', sameDay ? SAME_DAY_FORMAT : OTHER_DAY_FORMAT);
}

/** True when the entry matches the filter text. */
export function matchesHistory(entry: HistoryEntry, text: string | undefined): boolean {
  if (!text) return true;
  const needle = text.toLowerCase();
  return [entry.sql, entry.connection, entry.database ?? ''].some((field) => field.toLowerCase().includes(needle));
}
