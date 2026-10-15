import { describe, expect, it } from 'vitest';
import { formatRunTime, matchesHistory, queryTitle, type HistoryEntry } from '../src/shared/journal';

const entry: HistoryEntry = { id: '1', at: '2026-10-15T08:00:00+07:00', connection: '172.20.4.106\SQL2022 (sa)', database: 'TAKA', language: 'tsql', sql: 'SELECT * FROM NhanVien', elapsedMs: 120, rows: 3 };

describe('query journal', () => {
  it('titles a query by its first line of code, skipping comments, and cuts long ones', () => {
    expect(queryTitle('* ghi chú\n\n  SELECT a FROM b\nWHERE c = 1')).toBe('SELECT a FROM b');
    expect(queryTitle('-- note\nSELECT 1')).toBe('SELECT 1');
    expect(queryTitle('x'.repeat(130), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(queryTitle('   ')).toBe('');
  });

  it('shows the time of day for a run today and date with time otherwise', () => {
    const now = new Date('2026-10-15T20:00:00+07:00');
    expect(formatRunTime('2026-10-15T08:05:09+07:00', now)).toMatch(/^08:05:09$/);
    expect(formatRunTime('2026-10-14T08:05:09+07:00', now)).toMatch(/14\/10\/2026/);
  });

  it('matches the filter against sql, connection and database, ignoring case', () => {
    expect(matchesHistory(entry, undefined)).toBe(true);
    expect(matchesHistory(entry, 'nhanvien')).toBe(true);
    expect(matchesHistory(entry, 'taka')).toBe(true);
    expect(matchesHistory(entry, 'sql2022')).toBe(true);
    expect(matchesHistory(entry, 'orders')).toBe(false);
  });
});
