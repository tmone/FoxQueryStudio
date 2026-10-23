import { app, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matchesHistory, type Bookmark, type HistoryEntry, type HistoryFilter } from '../shared/journal';

/**
 * The query journal on disk, in the user data folder:
 * - `history.jsonl`: one JSON object per line, appended after every run, so nothing is lost
 *   when the program stops and the file can be read with any tool;
 * - `bookmarks.json`: the named queries.
 */

const HISTORY_FILE = 'history.jsonl';
const BOOKMARKS_FILE = 'bookmarks.json';
/** Entries a listing returns when the caller gives no limit. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
/** Runs kept on disk; the oldest go once this is passed, in one rewrite. */
const KEEP_ENTRIES = 20_000;

const historyFile = () => join(app.getPath('userData'), HISTORY_FILE);
const bookmarksFile = () => join(app.getPath('userData'), BOOKMARKS_FILE);

function readHistory(): HistoryEntry[] {
  if (!existsSync(historyFile())) return [];
  const entries: HistoryEntry[] = [];
  for (const line of readFileSync(historyFile(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // A line cut short by a crash is skipped; the rest of the file is still good.
    }
  }
  return entries;
}

function writeHistory(entries: HistoryEntry[]): void {
  mkdirSync(dirname(historyFile()), { recursive: true });
  writeFileSync(historyFile(), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

export function listHistory(filter: HistoryFilter = {}): HistoryEntry[] {
  const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const entries = readHistory().filter((e) => matchesHistory(e, filter.text));
  return entries.slice(-limit).reverse();
}

export function recordRun(run: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
  const entry: HistoryEntry = { id: randomUUID(), at: new Date().toISOString(), ...run };
  mkdirSync(dirname(historyFile()), { recursive: true });
  appendFileSync(historyFile(), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Drops the oldest runs once the file holds more than it should; called at start, not on every run. */
export function trimHistory(): void {
  const entries = readHistory();
  if (entries.length > KEEP_ENTRIES) writeHistory(entries.slice(-KEEP_ENTRIES));
}

export function clearHistory(): void {
  writeHistory([]);
}

function readBookmarks(): Bookmark[] {
  try {
    return existsSync(bookmarksFile()) ? (JSON.parse(readFileSync(bookmarksFile(), 'utf8')) as Bookmark[]) : [];
  } catch {
    return [];
  }
}

function writeBookmarks(bookmarks: Bookmark[]): void {
  mkdirSync(dirname(bookmarksFile()), { recursive: true });
  writeFileSync(bookmarksFile(), JSON.stringify(bookmarks, null, 2));
}

export const listBookmarks = (): Bookmark[] => readBookmarks().sort((a, b) => a.name.localeCompare(b.name, 'vi'));

export function saveBookmark(bookmark: Omit<Bookmark, 'id' | 'createdAt'> & { id?: string }): Bookmark {
  const bookmarks = readBookmarks();
  const existing = bookmark.id ? bookmarks.find((b) => b.id === bookmark.id) : undefined;
  const saved: Bookmark = { id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? new Date().toISOString(), name: bookmark.name.trim(), language: bookmark.language, sql: bookmark.sql, params: bookmark.params };
  if (!saved.name) throw new Error('Dấu trang cần có tên.');
  writeBookmarks([...bookmarks.filter((b) => b.id !== saved.id), saved]);
  return saved;
}

export function removeBookmark(id: string): void {
  writeBookmarks(readBookmarks().filter((b) => b.id !== id));
}

/**
 * Adds the bookmarks a kit ships, skipping names the user already has (theirs may have
 * been edited), so a kit can hand over its standard checks without touching the rest.
 */
export function seedBookmarks(seeds: Pick<Bookmark, 'name' | 'language' | 'sql'>[]): number {
  const have = new Set(readBookmarks().map((b) => b.name.toLowerCase()));
  const missing = seeds.filter((s) => !have.has(s.name.toLowerCase()));
  for (const seed of missing) saveBookmark(seed);
  return missing.length;
}

export function setupJournalIpc(seeds: Pick<Bookmark, 'name' | 'language' | 'sql'>[] = []): void {
  trimHistory();
  seedBookmarks(seeds);
  ipcMain.handle('journal:history', (_e, filter?: HistoryFilter) => listHistory(filter));
  ipcMain.handle('journal:record', (_e, run: Omit<HistoryEntry, 'id' | 'at'>) => recordRun(run));
  ipcMain.handle('journal:clearHistory', () => clearHistory());
  ipcMain.handle('journal:historyPath', () => historyFile());
  ipcMain.handle('journal:bookmarks', () => listBookmarks());
  ipcMain.handle('journal:saveBookmark', (_e, bookmark: Omit<Bookmark, 'id' | 'createdAt'> & { id?: string }) => saveBookmark(bookmark));
  ipcMain.handle('journal:removeBookmark', (_e, id: string) => removeBookmark(id));
}
