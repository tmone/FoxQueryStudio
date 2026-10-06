import { describe, expect, it } from 'vitest';
import { columnWidthResolver } from '../src/shared/column-kind';
import { runTsqlQuery, type QuerySession } from '../src/shared/run-query';
import type { ExecuteResult, SchemaTable } from '../src/shared/types';

const OK: ExecuteResult = { resultSets: [], messages: [], truncated: false, elapsedMs: 1 };

function fakeServer(result: ExecuteResult = OK) {
  const sent: string[] = [];
  const execute = async (_sessionId: string, sql: string) => {
    sent.push(sql);
    return result;
  };
  return { sent, execute };
}

const session = (cursors: string[] = []): QuerySession => ({ id: 's1', cursors });

describe('runTsqlQuery', () => {
  it('sends the T-SQL as written and returns its FoxPro form', async () => {
    const server = fakeServer();
    const source = "SELECT ten FROM nv WHERE ngay >= '2026-01-01'";
    const outcome = await runTsqlQuery(server.execute, session(), source, { maxRows: 10 });
    expect(server.sent).toEqual([source]);
    expect(outcome.conversion.foxpro).toBe('SELECT ten FROM nv WHERE ngay >= {^2026-01-01}');
  });

  it('still runs T-SQL that FoxPro cannot express', async () => {
    const server = fakeServer();
    const source = 'WITH x AS (SELECT 1 AS a) SELECT a FROM x';
    const outcome = await runTsqlQuery(server.execute, session(), source, { maxRows: 10 });
    expect(server.sent).toEqual([source]);
    expect(outcome.conversion.errors).toHaveLength(1);
    expect(outcome.result).toBe(OK);
  });

  it('adds the #temp tables it created to the cursors of the session', async () => {
    const tab = session(['cu']);
    await runTsqlQuery(fakeServer().execute, tab, 'SELECT ma INTO #moi FROM nv', { maxRows: 10 });
    expect(tab.cursors).toEqual(['cu', 'moi']);
  });

  it('keeps the cursors unchanged when the server rejects the batch', async () => {
    const tab = session(['cu']);
    await runTsqlQuery(fakeServer({ ...OK, error: 'Invalid object name' }).execute, tab, 'SELECT ma INTO #moi FROM khongco', { maxRows: 10 });
    expect(tab.cursors).toEqual(['cu']);
  });

  it('forgets every cursor when the session was replaced', async () => {
    const tab = session(['cu']);
    await runTsqlQuery(fakeServer({ ...OK, error: 'x', sessionReset: true }).execute, tab, 'SELECT 1', { maxRows: 10 });
    expect(tab.cursors).toEqual([]);
  });

  it('sends nothing for a blank source', async () => {
    const server = fakeServer();
    const outcome = await runTsqlQuery(server.execute, session(), '  \n', { maxRows: 10 });
    expect(server.sent).toEqual([]);
    expect(outcome.result).toBeUndefined();
  });
});

describe('columnWidthResolver', () => {
  const column = (name: string, dataType: string, maxLength: number | null) => ({ name, dataType, maxLength, nullable: true });
  const tables: SchemaTable[] = [
    { schema: 'dbo', name: 'NhanVien', isView: false, columns: [column('Ma', 'char', 6), column('GhiChu', 'nvarchar', -1), column('Luong', 'decimal', null)] },
    { schema: 'dbo', name: 'PhongBan', isView: false, columns: [column('Ma', 'varchar', 10)] },
  ];
  const width = columnWidthResolver(tables);

  it('finds the width through the tables of the statement', () => {
    expect(width('Ma', { tables: [{ name: 'dbo.NhanVien' }] })).toBe(6);
    expect(width('ma', { qualifier: 'p', tables: [{ name: 'NhanVien', alias: 'n' }, { name: '[dbo].[PhongBan]', alias: 'p' }] })).toBe(10);
  });

  it('gives no width when tables disagree, or the column is not a fixed-width text field', () => {
    expect(width('Ma', { tables: [{ name: 'NhanVien' }, { name: 'PhongBan' }] })).toBeUndefined();
    expect(width('GhiChu', { tables: [{ name: 'NhanVien' }] })).toBeUndefined();
    expect(width('Luong', { tables: [{ name: 'NhanVien' }] })).toBeUndefined();
  });
});
