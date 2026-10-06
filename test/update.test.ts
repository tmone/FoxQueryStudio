import { describe, expect, it } from 'vitest';
import { isAllowedUpdateUrl, updateActionLabel, type UpdateStatus } from '../src/shared/update';

describe('update server address', () => {
  it('accepts HTTPS and a plain-HTTP server on this machine only', () => {
    expect(isAllowedUpdateUrl('https://updates.example.com/foxquery/')).toBe(true);
    expect(isAllowedUpdateUrl('http://127.0.0.1:8123/')).toBe(true);
    expect(isAllowedUpdateUrl('http://localhost/updates')).toBe(true);
  });

  it('rejects plain HTTP to another machine, other schemes and malformed input', () => {
    expect(isAllowedUpdateUrl('http://192.168.1.10/updates')).toBe(false);
    expect(isAllowedUpdateUrl('http://updates.example.com/')).toBe(false);
    expect(isAllowedUpdateUrl('http://localhost.evil.com/')).toBe(false);
    expect(isAllowedUpdateUrl('file:///C:/updates')).toBe(false);
    expect(isAllowedUpdateUrl('ftp://127.0.0.1/')).toBe(false);
    expect(isAllowedUpdateUrl('updates.example.com')).toBe(false);
    expect(isAllowedUpdateUrl('')).toBe(false);
  });
});

describe('update button', () => {
  const status = (change: Partial<UpdateStatus>): UpdateStatus => ({ state: 'idle', currentVersion: '0.1.0', ...change });

  it('offers an action only when the user has something to decide', () => {
    expect(updateActionLabel(status({ state: 'available', newVersion: '0.2.0' }))).toBe('Tải bản 0.2.0');
    expect(updateActionLabel(status({ state: 'downloading', percent: 41.6 }))).toBe('Đang tải 42%');
    expect(updateActionLabel(status({ state: 'downloaded', newVersion: '0.2.0' }))).toBe('Khởi động lại để cập nhật 0.2.0');
  });

  it('shows no button while idle, checking, up to date, disabled or failed', () => {
    for (const state of ['idle', 'checking', 'not-available', 'disabled', 'error'] as const) {
      expect(updateActionLabel(status({ state }))).toBeUndefined();
    }
  });
});
