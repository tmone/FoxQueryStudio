import { describe, expect, it } from 'vitest';
import { applyParameters, findParameters, prepareFoxBatch, tableFor } from '../src/shared/fox-prepare';
import type { SchemaTable } from '../src/shared/types';

const table = (name: string, ...columns: string[]): SchemaTable => ({ schema: '', name, isView: false, columns: columns.map((c) => ({ name: c, dataType: 'numeric', maxLength: null, nullable: false })) });
const luong = table('bangluong', 'MA', 'LC', 'HSDC', 'DIEMP', 'CP', 'HSL', 'TP', 'TCD', 'CD', 'HSTN', 'CO', 'CTD', 'CDE', 'DIEM', 'HSTG', 'THUONG');
const check = 'SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/Công chế độ*HSL\nSUM THUONG-LC*HSDC*DIEM*(Công chế độ-CO-CTD-CDE)/Công chế độ*HSTG';

describe('parameters written as Vietnamese phrases', () => {
  it('finds each phrase once, outside strings and comments, and leaves field names alone', () => {
    expect(findParameters(check)).toEqual(['Công chế độ']);
    expect(findParameters('SUM TP FOR ten = "Công chế độ" && Số ngày\n* Ghi chú có dấu\nSUM LC * Hệ số vùng + Ngày công')).toEqual(['Hệ số vùng', 'Ngày công']);
    expect(findParameters('SUM TP-LC*HSDC FOR MA = "A"')).toEqual([]);
  });

  it('puts the value in parentheses wherever the phrase appears', () => {
    expect(applyParameters(check, { 'Công chế độ': ' 26 ' })).toBe('SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/(26)*HSL\nSUM THUONG-LC*HSDC*DIEM*((26)-CO-CTD-CDE)/(26)*HSTG');
    expect(applyParameters('SUM A*Hệ số+Hệ số vùng', { 'Hệ số': '2', 'Hệ số vùng': '3' })).toBe('SUM A*(2)+(3)');
  });
});

describe('the table a check runs on', () => {
  it('is the one whose columns cover every field named', () => {
    expect(tableFor('SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/(26)*HSL FOR ROUND(LC, 2) > 0', [luong, table('nv', 'MA', 'TEN')])).toEqual({ table: 'bangluong' });
    expect(tableFor('COUNT FOR CO > 0', [luong])).toEqual({ table: 'bangluong' });
  });

  it('says why when no table or several tables fit, or when the batch names no field', () => {
    expect(tableFor('SUM TP-XYZ', [luong]).error).toMatch(/không có bảng nào có đủ các cột tp, xyz/i);
    expect(tableFor('SUM LC', [luong, table('luong2', 'LC')]).error).toMatch(/bangluong, luong2/);
    expect(tableFor('COUNT', [luong]).error).toMatch(/USE bảng trước/);
  });

  it('is not chosen when the batch opens a table itself, has no work-area command, or the tab has one already', () => {
    expect(tableFor('USE x\nSUM LC', [luong])).toEqual({});
    expect(tableFor('SELECT * FROM bangluong', [luong])).toEqual({});
  });
});

describe('preparing a batch', () => {
  it('asks for each parameter, opens the table, and notes both', async () => {
    const asked: string[] = [];
    const prepared = await prepareFoxBatch(check, { tables: [luong], hasWorkArea: false, ask: async (name) => (asked.push(name), '25') });
    expect(asked).toEqual(['Công chế độ']);
    expect(prepared.source).toBe(`USE bangluong\n${applyParameters(check, { 'Công chế độ': '25' })}`);
    expect(prepared.notes).toEqual(['Công chế độ = 25', 'Đã mở bảng bangluong (có đủ các cột của lệnh).']);
  });

  it('stops quietly when the user cancels, and reports a table it cannot choose', async () => {
    expect((await prepareFoxBatch(check, { tables: [luong], hasWorkArea: false, ask: async () => undefined })).cancelled).toBe(true);
    expect((await prepareFoxBatch('SUM TP-XYZ', { tables: [luong], hasWorkArea: false, ask: async () => '1' })).error).toMatch(/xyz/i);
    expect(await prepareFoxBatch('SUM TP-XYZ', { tables: [luong], hasWorkArea: true, ask: async () => '1' })).toEqual({ source: 'SUM TP-XYZ', notes: [] });
  });
});
