// Writes test/fixtures/lamthao/bangluong.dbf: a free FoxPro table with the columns of a
// customer's payroll checks (see docs), rows that satisfy the formulas exactly, and one
// row whose stored amount is wrong, so a check `SUM stored - formula` is not 0.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join('test', 'fixtures', 'lamthao');
/** Working days of the month and unit the checks call "Công chế độ"; 25 keeps every formula exact. */
const CONG_CHE_DO = 25;

const fields = [
  ['MA', 'C', 10, 0],
  ['HOTEN', 'C', 30, 0],
  ['LC', 'N', 8, 2], // hệ số lương
  ['HSDC', 'N', 8, 2], // hệ số điều chỉnh
  ['HSL', 'N', 8, 2], // hệ số lương sản phẩm
  ['HSTN', 'N', 8, 2], // hệ số thu nhập
  ['HS', 'N', 8, 2], // hệ số quy đổi lương sản phẩm
  ['HSTG', 'N', 8, 2], // hệ số quy đổi thưởng
  ['DIEMP', 'N', 8, 2], // điểm tính công phép
  ['DIEM', 'N', 8, 2], // điểm năng suất
  ['CP', 'N', 6, 1], // công phép
  ['CD', 'N', 6, 1], // công đêm
  ['NC1', 'N', 6, 1], // ngày công thực tế
  ['CO', 'N', 6, 1], // công ốm
  ['CTD', 'N', 6, 1], // công tự do
  ['CDE', 'N', 6, 1], // công đẻ
  ['FTN', 'N', 8, 2], // % theo FTN
  ['TP', 'N', 14, 2], // tiền công phép
  ['TCD', 'N', 14, 2], // tiền làm đêm
  ['TTT', 'N', 14, 2], // tiền theo FTN
  ['TIEN1', 'N', 14, 2], // tiền lương sản phẩm
  ['THUONG', 'N', 14, 2], // tiền khuyến khích
];

/** The amounts the formulas give for a row's factors. */
function amounts(r) {
  const ccd = CONG_CHE_DO;
  return {
    TP: r.LC * r.HSDC * 2700000 * r.DIEMP / 9.8 * r.CP / ccd * r.HSL,
    TCD: r.LC * r.HSDC * 2700000 * r.CD / 26 * 0.35 * r.HSTN,
    TTT: r.FTN / 100 * 2700000 * r.NC1 / ccd * r.HSTN,
    TIEN1: r.LC * r.HSDC * r.DIEM * r.NC1 / ccd * r.HS,
    THUONG: r.LC * r.HSDC * r.DIEM * (ccd - r.CO - r.CTD - r.CDE) / ccd * r.HSTG,
  };
}

const factors = [
  { MA: 'NV001', HOTEN: 'Nguyen Van An', LC: 2, HSDC: 1, HSL: 1, HSTN: 1.5, HS: 1, HSTG: 1.5, DIEMP: 9.8, DIEM: 100, CP: 2, CD: 26, NC1: 25, CO: 1, CTD: 2, CDE: 2, FTN: 50 },
  { MA: 'NV002', HOTEN: 'Tran Thi Binh', LC: 3, HSDC: 1, HSL: 2, HSTN: 2, HS: 1, HSTG: 1, DIEMP: 9.8, DIEM: 50, CP: 1, CD: 13, NC1: 20, CO: 0, CTD: 5, CDE: 0, FTN: 20 },
  { MA: 'NV003', HOTEN: 'Le Van Cuong', LC: 4, HSDC: 1, HSL: 1, HSTN: 1, HS: 2, HSTG: 2, DIEMP: 9.8, DIEM: 25, CP: 5, CD: 0, NC1: 25, CO: 0, CTD: 0, CDE: 0, FTN: 10 },
  { MA: 'NV004', HOTEN: 'Pham Thi Dung', LC: 2, HSDC: 1, HSL: 1, HSTN: 1, HS: 1, HSTG: 1, DIEMP: 9.8, DIEM: 100, CP: 1, CD: 26, NC1: 25, CO: 0, CTD: 0, CDE: 0, FTN: 0 },
];
const rows = factors.map((r) => ({ ...r, ...amounts(r) }));
// One wrong amount: the check for TP must find exactly this row.
rows[3].TP += 1000;

const headerLength = 32 + 32 * fields.length + 1;
const recordLength = 1 + fields.reduce((n, [, , width]) => n + width, 0);
const header = Buffer.alloc(headerLength);
header[0] = 0x03; // dBASE III / FoxPro free table without memo
const now = new Date();
header[1] = now.getFullYear() - 1900;
header[2] = now.getMonth() + 1;
header[3] = now.getDate();
header.writeUInt32LE(rows.length, 4);
header.writeUInt16LE(headerLength, 8);
header.writeUInt16LE(recordLength, 10);
let offset = 1;
fields.forEach(([name, type, width, decimals], i) => {
  const at = 32 + 32 * i;
  header.write(name, at, 'ascii');
  header.write(type, at + 11, 'ascii');
  header.writeUInt32LE(offset, at + 12);
  header[at + 16] = width;
  header[at + 17] = decimals;
  offset += width;
});
header[headerLength - 1] = 0x0d;

const body = Buffer.alloc(recordLength * rows.length + 1, 0x20);
rows.forEach((row, r) => {
  let at = r * recordLength + 1;
  for (const [name, type, width, decimals] of fields) {
    const text = type === 'C' ? String(row[name]).padEnd(width) : Number(row[name]).toFixed(decimals).padStart(width);
    body.write(text.slice(0, width), at, 'ascii');
    at += width;
  }
});
body[body.length - 1] = 0x1a;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'bangluong.dbf'), Buffer.concat([header, body]));
console.log(join(OUT, 'bangluong.dbf'), `${rows.length} rows, Công chế độ = ${CONG_CHE_DO}`);
