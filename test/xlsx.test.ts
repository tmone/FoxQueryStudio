import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWorkbook, columnLetters, sheetNames } from '../src/shared/xlsx';

// The workbook is a zip of XML parts; Windows' own tar reads zips, so the parts are checked as files.
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const dir = mkdtempSync(join(tmpdir(), 'fqs-xlsx-'));

function unpack(bytes: Uint8Array): (part: string) => string {
  const file = join(dir, `${Date.now()}-${Math.random()}.xlsx`);
  writeFileSync(file, bytes);
  const out = `${file}.d`;
  execFileSync(TAR, ['-xf', file, '-C', dir.replace(/\\/g, '/')], { stdio: 'ignore' });
  void out;
  return (part) => readFileSync(join(dir, part), 'utf8');
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Excel workbook writer', () => {
  it('names columns the way Excel does', () => {
    expect([1, 26, 27, 52, 53, 702, 703].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('keeps sheet names legal and unique', () => {
    expect(sheetNames(['Bảng 1', 'a/b:c?', '', 'Bảng 1', 'x'.repeat(40)])).toEqual(['Bảng 1', 'a b c', 'Sheet3', 'Bảng 1 2', 'x'.repeat(31)]);
  });

  it('writes a readable workbook with typed cells, a bold frozen header and one sheet per result set', () => {
    const read = unpack(
      buildWorkbook([
        { name: 'nv', columns: ['ma', 'ten', 'luong', 'nghi', 'ghichu'], rows: [['NV001', 'Nguyễn <An> & "Bình"', 15000000.5, false, null], [' x ', '', 0, true, 'a\nb']] },
        { name: 'nv', columns: ['n'], rows: [[2]] },
      ]),
    );
    expect(read('[Content_Types].xml')).toContain('/xl/worksheets/sheet2.xml');
    expect(read('xl/workbook.xml')).toContain('<sheet name="nv" sheetId="1" r:id="rId1"/><sheet name="nv 2" sheetId="2" r:id="rId2"/>');
    const sheet = read('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t>ma</t></is></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t>Nguyễn &lt;An&gt; &amp; &quot;Bình&quot;</t></is></c>');
    expect(sheet).toContain('<c r="C2"><v>15000000.5</v></c>');
    expect(sheet).toContain('<c r="D2" t="b"><v>0</v></c>');
    expect(sheet).not.toContain('r="E2"');
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve"> x </t></is></c>');
    expect(sheet).toContain('<c r="B3" t="inlineStr"><is><t></t></is></c>');
    expect(sheet).toContain('state="frozen"');
    expect(read('xl/styles.xml')).toContain('<b/>');
  });

  it('refuses an export with nothing in it', () => {
    expect(() => buildWorkbook([])).toThrow('Không có bảng kết quả');
  });
});
