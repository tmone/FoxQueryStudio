import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(join(tmpdir(), 'fqs-journal-'));
vi.mock('electron', () => ({ app: { getPath: () => userData }, ipcMain: { handle: () => undefined } }));

const { clearHistory, listBookmarks, listHistory, recordRun, removeBookmark, saveBookmark, seedBookmarks, trimHistory } = await import('../src/main/journal');

afterAll(() => rmSync(userData, { recursive: true, force: true }));

describe('query journal on disk', () => {
  it('appends every run as one JSON line and lists the newest first', () => {
    const first = recordRun({ connection: 'FoxPro (x.dbc)', language: 'foxpro', sql: 'SELECT 1', elapsedMs: 5, rows: 1 });
    recordRun({ connection: 'srv (sa)', database: 'db', language: 'tsql', sql: 'SELECT 2', elapsedMs: 7, error: 'boom' });
    const lines = readFileSync(join(userData, 'history.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(first);
    expect(listHistory().map((e) => e.sql)).toEqual(['SELECT 2', 'SELECT 1']);
    expect(listHistory({ text: 'srv' }).map((e) => e.sql)).toEqual(['SELECT 2']);
    expect(listHistory({ limit: 1 }).map((e) => e.sql)).toEqual(['SELECT 2']);
  });

  it('skips a line cut short by a crash and keeps the rest', () => {
    writeFileSync(join(userData, 'history.jsonl'), readFileSync(join(userData, 'history.jsonl'), 'utf8') + '{"id":"x","at":"2026', { flag: 'w' });
    expect(listHistory()).toHaveLength(2);
    trimHistory();
    expect(listHistory()).toHaveLength(2);
    clearHistory();
    expect(listHistory()).toEqual([]);
  });

  it('keeps bookmarks by name, replaces one by id and removes one', () => {
    const a = saveBookmark({ name: 'Đơn hàng', language: 'tsql', sql: 'SELECT * FROM orders' });
    saveBookmark({ name: 'Khách', language: 'foxpro', sql: 'SELECT * FROM customers' });
    expect(listBookmarks().map((b) => b.name)).toEqual(['Đơn hàng', 'Khách']);
    const renamed = saveBookmark({ id: a.id, name: 'Đơn hàng mở', language: 'tsql', sql: a.sql });
    expect(renamed.id).toBe(a.id);
    expect(renamed.createdAt).toBe(a.createdAt);
    expect(listBookmarks().map((b) => b.name)).toEqual(['Đơn hàng mở', 'Khách']);
    expect(() => saveBookmark({ name: '  ', language: 'tsql', sql: 'x' })).toThrow();
    removeBookmark(a.id);
    expect(listBookmarks().map((b) => b.name)).toEqual(['Khách']);
  });

  it('adds the bookmarks a kit ships once, leaving ones of the same name alone', () => {
    const seeds = [
      { name: 'Khách', language: 'tsql' as const, sql: 'SELECT 2' },
      { name: 'Kiểm tra công phép', language: 'foxpro' as const, sql: 'USE bangluong\nSUM TP-LC*2' },
    ];
    expect(seedBookmarks(seeds)).toBe(1);
    expect(listBookmarks().map((b) => [b.name, b.sql])).toEqual([['Khách', 'SELECT * FROM customers'], ['Kiểm tra công phép', 'USE bangluong\nSUM TP-LC*2']]);
    expect(seedBookmarks(seeds)).toBe(0);
  });
});
