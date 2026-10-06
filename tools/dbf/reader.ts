import { existsSync, readFileSync } from 'node:fs';

export type DbfValue = string | number | boolean | Date | null;
export type DbfRecord = Record<string, DbfValue>;

export interface DbfField {
  name: string;
  /** FoxPro type letter: C N F I Y B L D T M V Q G W. */
  type: string;
  length: number;
  decimals: number;
  nullable: boolean;
  /** NOCPTRANS: the bytes are not text in the table code page. */
  binary: boolean;
  offset: number;
}

export interface DbfTable {
  fields: DbfField[];
  /** Active records only; character values keep their fixed-width padding. */
  records: DbfRecord[];
  deletedCount: number;
}

const HEADER_SIZE = 32;
const FIELD_SIZE = 32;
const FIELD_TERMINATOR = 0x0d;
const FLAG_SYSTEM = 0x01;
const FLAG_NULLABLE = 0x02;
const FLAG_BINARY = 0x04;
const DELETED_MARK = 0x2a; // '*'
const NULL_FLAGS_TYPE = '0';
const JULIAN_UNIX_EPOCH = 2440588;
const MS_PER_DAY = 86_400_000;
const CURRENCY_SCALE = 10_000;
const CODE_PAGES: Record<number, string> = { 0x01: 'ibm437', 0x02: 'ibm850', 0x03: 'windows-1252', 0xc8: 'windows-1250', 0xc9: 'windows-1251' };

const isVarLength = (type: string) => type === 'V' || type === 'Q';
const isMemo = (type: string) => type === 'M' || type === 'G' || type === 'W';

/** Reads memo blocks from a FoxPro .fpt (or .dct) file. */
class MemoFile {
  private readonly data: Buffer;
  private readonly blockSize: number;

  constructor(path: string) {
    this.data = readFileSync(path);
    this.blockSize = this.data.readUInt16BE(6);
  }

  read(block: number): Buffer {
    const start = block * this.blockSize;
    const length = this.data.readUInt32BE(start + 4);
    return this.data.subarray(start + 8, start + 8 + length);
  }
}

function parseDate(text: string): Date | null {
  if (!/^\d{8}$/.test(text)) return null; // blank is FoxPro's empty date
  return new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))));
}

export function readDbf(path: string): DbfTable {
  const data = readFileSync(path);
  const recordCount = data.readUInt32LE(4);
  const headerLength = data.readUInt16LE(8);
  const recordLength = data.readUInt16LE(10);
  const decoder = new TextDecoder(CODE_PAGES[data[29]] ?? 'windows-1252');
  const ascii = (buf: Buffer) => buf.toString('latin1');

  const allFields: (DbfField & { system: boolean })[] = [];
  for (let at = HEADER_SIZE; data[at] !== FIELD_TERMINATOR; at += FIELD_SIZE) {
    const rawName = data.subarray(at, at + 11);
    const end = rawName.indexOf(0);
    allFields.push({
      name: ascii(rawName.subarray(0, end < 0 ? 11 : end)).toLowerCase(),
      type: String.fromCharCode(data[at + 11]),
      offset: data.readUInt32LE(at + 12),
      length: data[at + 16],
      decimals: data[at + 17],
      system: (data[at + 18] & FLAG_SYSTEM) !== 0,
      nullable: (data[at + 18] & FLAG_NULLABLE) !== 0,
      binary: (data[at + 18] & FLAG_BINARY) !== 0,
    });
  }

  // _NullFlags holds one bit per var-length field (value is shorter than the field)
  // followed by one bit per nullable field, allocated in field order.
  const nullFlags = allFields.find((f) => f.type === NULL_FLAGS_TYPE);
  const fields = allFields.filter((f) => !f.system && f.type !== NULL_FLAGS_TYPE);
  const flagBits = new Map<DbfField, { short?: number; isNull?: number }>();
  let nextBit = 0;
  for (const f of fields) {
    const bits: { short?: number; isNull?: number } = {};
    if (isVarLength(f.type)) bits.short = nextBit++;
    if (f.nullable) bits.isNull = nextBit++;
    flagBits.set(f, bits);
  }

  const memoPath = path.replace(/\.[^.]+$/, (ext) => (ext.toLowerCase() === '.dbc' ? '.dct' : '.fpt'));
  const memo = fields.some((f) => isMemo(f.type)) && existsSync(memoPath) ? new MemoFile(memoPath) : undefined;

  const records: DbfRecord[] = [];
  let deletedCount = 0;
  for (let r = 0; r < recordCount; r++) {
    const row = data.subarray(headerLength + r * recordLength, headerLength + (r + 1) * recordLength);
    if (row[0] === DELETED_MARK) {
      deletedCount++;
      continue;
    }
    const flagBytes = nullFlags ? row.subarray(nullFlags.offset, nullFlags.offset + nullFlags.length) : undefined;
    const bitSet = (bit: number | undefined) => bit !== undefined && !!flagBytes && (flagBytes[bit >> 3] & (1 << (bit & 7))) !== 0;

    const record: DbfRecord = {};
    for (const f of fields) {
      const bits = flagBits.get(f)!;
      const raw = row.subarray(f.offset, f.offset + f.length);
      if (bitSet(bits.isNull)) {
        record[f.name] = null;
        continue;
      }
      switch (f.type) {
        case 'C':
          record[f.name] = decoder.decode(raw);
          break;
        case 'V':
          record[f.name] = decoder.decode(bitSet(bits.short) ? raw.subarray(0, raw[f.length - 1]) : raw);
          break;
        case 'N':
        case 'F':
          record[f.name] = Number(ascii(raw).trim()) || 0;
          break;
        case 'I':
          record[f.name] = raw.readInt32LE(0);
          break;
        case 'Y':
          record[f.name] = Number(raw.readBigInt64LE(0)) / CURRENCY_SCALE;
          break;
        case 'B':
          record[f.name] = raw.readDoubleLE(0);
          break;
        case 'L':
          record[f.name] = 'TtYy'.includes(String.fromCharCode(raw[0]));
          break;
        case 'D':
          record[f.name] = parseDate(ascii(raw));
          break;
        case 'T': {
          const julianDay = raw.readInt32LE(0);
          // FoxPro stores the time as milliseconds that can be 1 ms short of the second.
          const seconds = Math.round(raw.readInt32LE(4) / 1000);
          record[f.name] = julianDay ? new Date((julianDay - JULIAN_UNIX_EPOCH) * MS_PER_DAY + seconds * 1000) : null;
          break;
        }
        case 'M': {
          const block = raw.readUInt32LE(0);
          record[f.name] = block && memo ? decoder.decode(memo.read(block)) : '';
          break;
        }
        default:
          // General, blob and varbinary fields carry no query-relevant data here.
          record[f.name] = null;
      }
    }
    records.push(record);
  }

  return { fields, records, deletedCount };
}
