import { describe, expect, it } from 'vitest';
import { isAllowedUpdateUrl, isNewerVersion, parseRelease, updateActionLabel, type UpdateStatus } from '../src/shared/update';

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

describe('releases on GitHub', () => {
  const asset = (change: object = {}) => ({ name: 'FoxQueryStudio-0.2.0.exe', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.0/FoxQueryStudio-0.2.0.exe', digest: `sha256:${'ab'.repeat(32)}`, ...change });

  it('compares versions by number, not by text', () => {
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('v0.10.0', '0.9.5')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });

  it('never treats a malformed version as newer', () => {
    for (const version of ['', 'latest', '1.2', '1.2.3-beta', '9.9.9.9']) expect(isNewerVersion(version, '0.1.0')).toBe(false);
  });

  it('reads the version, the program file and its checksum from a release', () => {
    expect(parseRelease({ tag_name: 'v0.2.0', assets: [{ name: 'notes.txt', browser_download_url: 'https://x/notes.txt' }, asset()] })).toEqual({
      version: '0.2.0',
      asset: { name: 'FoxQueryStudio-0.2.0.exe', url: 'https://github.com/o/r/releases/download/v0.2.0/FoxQueryStudio-0.2.0.exe', sha256: 'ab'.repeat(32) },
    });
  });

  it('keeps a release without a program file or checksum, so the app can say what is missing', () => {
    expect(parseRelease({ tag_name: 'v0.2.0', assets: [] })).toEqual({ version: '0.2.0', asset: undefined });
    expect(parseRelease({ tag_name: 'v0.2.0', assets: [asset({ digest: 'md5:abc' })] })?.asset?.sha256).toBeUndefined();
    expect(parseRelease({ tag_name: 'v0.2.0', assets: [asset({ digest: undefined })] })?.asset?.sha256).toBeUndefined();
  });

  it('rejects an answer that is not a release', () => {
    for (const body of [null, {}, { message: 'Not Found' }, { tag_name: 'nightly', assets: [] }, { tag_name: 7 }]) expect(parseRelease(body)).toBeUndefined();
  });
});
