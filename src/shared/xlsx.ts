import type { CellValue } from './types';

/**
 * Writes an Excel workbook (.xlsx) from result sets without any library: a workbook is a
 * zip of XML parts, and the parts needed for plain sheets are small. Entries are stored
 * uncompressed, which every reader accepts.
 */
export interface Sheet {
  name: string;
  columns: string[];
  rows: CellValue[][];
}

const MAX_SHEET_NAME = 31;
const FORBIDDEN_IN_SHEET_NAME = /[\\/?*[\]:]/g;
/** Excel refuses cells longer than this. */
const MAX_CELL_TEXT = 32767;

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Characters XML 1.0 cannot carry are dropped rather than corrupting the file. */
const cleanText = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').slice(0, MAX_CELL_TEXT);

/** Column letters for a 1-based column number: 1 → A, 27 → AA. */
export function columnLetters(column: number): string {
  let letters = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

function cellXml(ref: string, value: CellValue, style?: number): string {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : `<c r="${ref}"${s} t="inlineStr"><is><t>${value}</t></is></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = cleanText(String(value));
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t${space}>${escapeXml(text)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const header = sheet.columns.map((name, c) => cellXml(`${columnLetters(c + 1)}1`, name, 1)).join('');
  const body = sheet.rows.map((row, r) => `<row r="${r + 2}">${row.map((value, c) => cellXml(`${columnLetters(c + 1)}${r + 2}`, value)).join('')}</row>`).join('');
  const widths = sheet.columns.map((name, c) => {
    const longest = sheet.rows.slice(0, 200).reduce((max, row) => Math.max(max, String(row[c] ?? '').length), name.length);
    return `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, Math.max(8, longest + 2))}" customWidth="1"/>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (widths.length ? `<cols>${widths.join('')}</cols>` : '') +
    `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
    '</worksheet>'
  );
}

/** Sheet names must be unique, non-empty, at most 31 characters and free of a few characters. */
export function sheetNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((raw, i) => {
    const base = (raw.replace(FORBIDDEN_IN_SHEET_NAME, ' ').trim() || `Sheet${i + 1}`).slice(0, MAX_SHEET_NAME);
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base.slice(0, MAX_SHEET_NAME - String(n).length - 1)} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive with stored (uncompressed) entries. */
function zip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const fixed = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length), ...u16(name.length)];
    const local = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...fixed, ...u16(0), ...name]);
    parts.push(local, entry.data);
    // Central directory entry: extra and comment lengths, disk number, internal and external attributes, then the local header offset.
    central.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...fixed, ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
    offset += local.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function buildWorkbook(sheets: Sheet[]): Uint8Array {
  if (!sheets.length) throw new Error('Không có bảng kết quả nào để xuất.');
  const names = sheetNames(sheets.map((s) => s.name));
  const encoder = new TextEncoder();
  const xml = (text: string) => encoder.encode(text);
  const entries = [
    {
      name: '[Content_Types].xml',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
          '</workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
          `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          '</Relationships>',
      ),
    },
    {
      // Style 1 is the bold header row.
      name: 'xl/styles.xml',
      data: xml(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
          '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
          '</styleSheet>',
      ),
    },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml(sheetXml(sheet)) })),
  ];
  return zip(entries);
}
