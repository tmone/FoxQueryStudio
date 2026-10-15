import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readSideConfig } from '../src/main/side-config';

const folder = mkdtempSync(join(tmpdir(), 'fqs-side-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('settings next to the program', () => {
  it('reads the bookmarks a kit ships, FoxPro unless said otherwise, and skips malformed ones', () => {
    writeFileSync(
      join(folder, 'FoxQueryStudio.config.json'),
      JSON.stringify({
        bookmarks: [
          { name: ' Kiểm tra công phép ', sql: 'USE bangluong\nSUM TP-LC*2' },
          { name: 'Đơn hàng', sql: 'SELECT TOP 10 * FROM orders', language: 'tsql' },
          { name: '', sql: 'x' },
          { name: 'Thiếu lệnh' },
          'not an object',
        ],
      }),
    );
    expect(readSideConfig(folder).bookmarks).toEqual([
      { name: 'Kiểm tra công phép', language: 'foxpro', sql: 'USE bangluong\nSUM TP-LC*2' },
      { name: 'Đơn hàng', language: 'tsql', sql: 'SELECT TOP 10 * FROM orders' },
    ]);
  });

  it('has no bookmarks without the file', () => {
    expect(readSideConfig(join(folder, 'nowhere')).bookmarks).toEqual([]);
  });
});
