import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createDatabase, type SqlDriver } from '../src/main/db';
import type { ConnectionProfile } from '../src/shared/types';

// The database service against a scripted driver that follows the documented `mssql`
// stream contract (recordset, row, info, error, then always done). This is how the
// default driver (tedious) behaves, which cannot be exercised against LocalDB.

const PROFILE: ConnectionProfile = { server: 's', database: 'd', user: 'u', password: 'p', encrypt: true, trustServerCertificate: false };

type Step = ['recordset', string[]] | ['row', unknown[]] | ['info', string] | ['error', string] | ['done'];

class FakeRequest extends EventEmitter {
  stream = false;
  arrayRowMode = false;
  cancelled = 0;

  constructor(private readonly script: Step[]) {
    super();
  }

  cancel(): void {
    this.cancelled++;
  }

  async batch(): Promise<void> {
    for (const [event, payload] of this.script) {
      await Promise.resolve();
      // After a cancel the server stops sending rows and reports the cancellation.
      if (this.cancelled && event === 'row') continue;
      if (event === 'recordset') this.emit('recordset', (payload as string[]).map((name) => ({ name })));
      else if (event === 'info') this.emit('info', { message: payload });
      else if (event === 'error') this.emit('error', new Error(payload as string));
      else if (event === 'done' && this.cancelled) this.emit('error', new Error('Canceled.')), this.emit('done');
      else this.emit(event, payload);
    }
  }
}

function fakeDriver(scripts: Step[][]) {
  const pools: { closed: boolean; requests: FakeRequest[] }[] = [];
  class ConnectionPool {
    readonly state = { closed: false, requests: [] as FakeRequest[] };
    constructor(readonly config: unknown) {
      pools.push(this.state);
    }
    async connect() {
      return this;
    }
    async close() {
      this.state.closed = true;
    }
    request() {
      const request = new FakeRequest(scripts.shift() ?? [['done']]);
      this.state.requests.push(request);
      return request;
    }
  }
  return { driver: { ConnectionPool } as unknown as SqlDriver, pools };
}

async function connected(scripts: Step[][]) {
  const fake = fakeDriver(scripts);
  const db = createDatabase(fake.driver, () => ({}) as never);
  await db.connect(PROFILE);
  return { db, pools: fake.pools };
}

describe('database service against the documented driver contract', () => {
  it('refuses to run before a connection is made', async () => {
    const db = createDatabase(fakeDriver([]).driver, () => ({}) as never);
    await expect(db.execute('tab', 'SELECT 1', 10)).rejects.toThrow('Chưa kết nối máy chủ.');
  });

  it('probes the server on connect and closes the probe connection', async () => {
    const { pools } = await connected([]);
    expect(pools).toEqual([{ closed: true, requests: [] }]);
  });

  it('collects result sets, rows and messages in order', async () => {
    const { db } = await connected([
      [['info', 'bắt đầu'], ['recordset', ['a', 'b']], ['row', [1, 'x']], ['row', [2, null]], ['recordset', ['c']], ['done']],
    ]);
    const result = await db.execute('tab', 'sql', 10);
    expect(result).toMatchObject({
      resultSets: [{ columns: ['a', 'b'], rows: [[1, 'x'], [2, null]] }, { columns: ['c'], rows: [] }],
      messages: ['bắt đầu'],
      truncated: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.sessionReset).toBeUndefined();
  });

  it('formats dates, binary and other values for display', async () => {
    const { db } = await connected([
      [
        ['recordset', ['v']],
        ['row', [new Date(Date.UTC(2026, 0, 31))]],
        ['row', [new Date(Date.UTC(2026, 0, 31, 9, 5, 7))]],
        ['row', [new Date(Date.UTC(2026, 0, 31, 9, 5, 7, 40))]],
        ['row', [Buffer.from([0, 255])]],
        ['row', [12345678901234567890n]],
        ['row', [undefined]],
        ['row', [true]],
        ['done'],
      ],
    ]);
    const result = await db.execute('tab', 'sql', 10);
    expect(result.resultSets[0].rows.flat()).toEqual(['2026-01-31', '2026-01-31 09:05:07', '2026-01-31 09:05:07.040', '0x00ff', '12345678901234567890', null, true]);
  });

  it('keeps the session when the server reports an error and then finishes', async () => {
    const { db, pools } = await connected([
      [['recordset', ['a']], ['row', [1]], ['error', 'Conversion failed'], ['error', 'Second error'], ['done']],
      [['recordset', ['a']], ['row', [2]], ['done']],
    ]);
    const started = Date.now();
    const failed = await db.execute('tab', 'sql', 10);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(failed.error).toBe('Conversion failed\nSecond error');
    expect(failed.resultSets[0].rows).toEqual([[1]]);
    expect(failed.sessionReset).toBeUndefined();

    const next = await db.execute('tab', 'sql', 10);
    expect(next.resultSets[0].rows).toEqual([[2]]);
    // Probe pool plus one session pool: the session connection was reused.
    expect(pools).toHaveLength(2);
    expect(pools[1].closed).toBe(false);
  });

  it('replaces the session when the driver never finishes after an error', async () => {
    const { db, pools } = await connected([[['error', 'Invalid object name']], [['recordset', ['a']], ['row', [1]], ['done']]]);
    const failed = await db.execute('tab', 'sql', 10);
    expect(failed).toMatchObject({ error: 'Invalid object name', sessionReset: true });
    expect(pools[1].closed).toBe(true);

    expect((await db.execute('tab', 'sql', 10)).resultSets[0].rows).toEqual([[1]]);
    expect(pools).toHaveLength(3);
  });

  it('cancels at the row limit once and does not report the cancellation as an error', async () => {
    const rows: Step[] = Array.from({ length: 50 }, (_, i) => ['row', [i]]);
    const { db, pools } = await connected([[['recordset', ['n']], ...rows, ['done']]]);
    const result = await db.execute('tab', 'sql', 3);
    expect(result.resultSets[0].rows).toEqual([[0], [1], [2]]);
    expect(result.truncated).toBe(true);
    expect(result.error).toBeUndefined();
    expect(pools[1].requests[0].cancelled).toBe(1);
    expect(pools[1].requests[0]).toMatchObject({ stream: true, arrayRowMode: true });
  });

  it('gives every tab its own connection and closes them on demand', async () => {
    const { db, pools } = await connected([]);
    await db.execute('a', 'sql', 10);
    await db.execute('b', 'sql', 10);
    await db.execute('a', 'sql', 10);
    expect(pools).toHaveLength(3);
    expect(pools[1].requests).toHaveLength(2);

    await db.closeSession('a');
    expect(pools.map((p) => p.closed)).toEqual([true, true, false]);
    await db.disconnect();
    expect(pools.map((p) => p.closed)).toEqual([true, true, true]);
    await expect(db.execute('b', 'sql', 10)).rejects.toThrow('Chưa kết nối máy chủ.');
  });
});
