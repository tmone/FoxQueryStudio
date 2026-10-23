import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';

// The bundle other hosts load (the CnB legacy web): built here, run in a bare context with no
// Node, so a dependency on Node or Electron creeping into the shared code is caught.
const folder = mkdtempSync(join(tmpdir(), 'fqs-bundle-'));
const out = join(folder, 'lv.xbase.js');
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe('lv.xbase.js for the web', () => {
  it('defines lvXBase with the translation, parameters, guard and procedure helpers', () => {
    execFileSync(process.execPath, ['scripts/build-xbase-bundle.mjs'], { env: { ...process.env, XBASE_OUT: out }, stdio: 'ignore' });
    const context: Record<string, unknown> = {};
    context.window = context;
    vm.runInNewContext(readFileSync(out, 'utf8'), context);
    const x = context.lvXBase as Record<string, (...args: unknown[]) => unknown>;
    expect(x.VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
    expect((x.convertFoxPro('USE bangluong\nSUM TP - LC * 2 FOR thang = 9') as { sql: string }).sql).toBe('SELECT SUM(TP - LC * 2) AS sum1 FROM bangluong WHERE thang = 9');
    expect(x.findParameters('SUM TP/Công chế độ')).toEqual(['Công chế độ']);
    expect(x.tsqlViolation('DELETE FROM t')).toMatchObject({ line: 1 });
    expect(x.execStatement('dbo.P', [{ name: '@a', value: '1' }])).toBe('EXEC dbo.P @a = 1');
    expect(readFileSync(out, 'utf8')).not.toMatch(/require\("(electron|node:|fs|path)/);
  });
});
