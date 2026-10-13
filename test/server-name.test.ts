import { describe, expect, it } from 'vitest';
import { formatServerName, parseServerName } from '../src/shared/server-name';

describe('server name as SSMS writes it', () => {
  it('reads host, instance and port in every combination', () => {
    expect(parseServerName('192.168.18.14')).toEqual({ host: '192.168.18.14', instance: undefined, port: undefined });
    expect(parseServerName('192.168.18.14,1433')).toEqual({ host: '192.168.18.14', instance: undefined, port: 1433 });
    expect(parseServerName(String.raw`192.168.18.14\SQL2025`)).toEqual({ host: '192.168.18.14', instance: 'SQL2025', port: undefined });
    expect(parseServerName(String.raw` 192.168.18.14\SQL2025 , 1433 `)).toEqual({ host: '192.168.18.14', instance: 'SQL2025', port: 1433 });
  });

  it('ignores a port that is not a number', () => {
    expect(parseServerName('srv,abc').port).toBeUndefined();
  });

  it('writes the name back the same way', () => {
    for (const text of ['srv', String.raw`srv\inst`, 'srv,1433', String.raw`srv\inst,1433`]) expect(formatServerName(parseServerName(text))).toBe(text);
  });
});
