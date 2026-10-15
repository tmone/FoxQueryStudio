import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = mkdtempSync(join(tmpdir(), 'fqs-settings-'));
vi.mock('electron', () => ({ app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } }));

const { listRegistrations, registerFoxPro } = await import('../src/main/settings');

afterAll(() => rmSync(userData, { recursive: true, force: true }));

describe('remembered FoxPro databases', () => {
  it('takes over the entry of a same-named database whose file is gone, and keeps one that still exists', () => {
    const kitA = join(userData, 'kit-a');
    const kitB = join(userData, 'kit-b');
    mkdirSync(kitA, { recursive: true });
    mkdirSync(kitB, { recursive: true });
    writeFileSync(join(kitA, 'northwind.dbc'), '');
    writeFileSync(join(kitB, 'northwind.dbc'), '');
    const a = registerFoxPro(join(kitA, 'northwind.dbc'));
    const b = registerFoxPro(join(kitB, 'northwind.dbc'));
    expect(a).not.toBe(b);
    expect(listRegistrations()).toHaveLength(2);
    // The kit was moved: its old path is gone, the new one replaces it instead of standing beside it.
    rmSync(kitA, { recursive: true });
    const moved = registerFoxPro(join(userData, 'kit-c', 'northwind.dbc'));
    expect(moved).not.toBe(a);
    expect(listRegistrations().map((r) => r.kind === 'foxpro' && r.path)).toEqual([join(kitB, 'northwind.dbc'), join(userData, 'kit-c', 'northwind.dbc')]);
    expect(registerFoxPro(join(kitB, 'northwind.dbc'))).toBe(b);
  });
});
