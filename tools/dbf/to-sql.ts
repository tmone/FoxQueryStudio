import type { FoxTable } from './database';
import type { DbfField, DbfValue } from './reader';

const INSERT_CHUNK_ROWS = 200;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * SQL Server type for a FoxPro field, or undefined when the field is not migrated.
 * Character fields stay fixed-width (nchar) so padding behaves as it does in FoxPro.
 */
export function sqlType(field: DbfField): string | undefined {
  switch (field.type) {
    case 'C':
      return `nchar(${field.length})`;
    case 'V':
      return `nvarchar(${field.length})`;
    case 'N':
    case 'F':
      return `decimal(${field.length}, ${field.decimals})`;
    case 'I':
      return 'int';
    case 'Y':
      return 'money';
    case 'B':
      return 'float';
    case 'L':
      return 'bit';
    case 'D':
      return 'date';
    case 'T':
      return 'datetime';
    case 'M':
      return field.binary ? undefined : 'nvarchar(max)';
    default:
      return undefined;
  }
}

export const migratedFields = (table: FoxTable) => table.fields.filter((f) => sqlType(f) !== undefined);

/** FoxPro's empty date has no SQL Server equivalent and is stored as NULL. */
const acceptsNull = (field: DbfField) => field.nullable || field.type === 'D' || field.type === 'T';

export function createTableSql(table: FoxTable): string {
  const columns = migratedFields(table).map((f) => `  [${f.name}] ${sqlType(f)} ${acceptsNull(f) ? 'NULL' : 'NOT NULL'}`);
  return `CREATE TABLE dbo.[${table.name}] (\n${columns.join(',\n')}\n)`;
}

function literal(value: DbfValue, field: DbfField): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return field.type === 'Y' ? value.toFixed(4) : field.decimals ? value.toFixed(field.decimals) : String(value);
  if (value instanceof Date) {
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    if (field.type === 'D') return `'${date}'`;
    return `'${date}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}'`;
  }
  // nchar re-pads on insert, so trailing blanks of fixed-width values need not be sent.
  const text = field.type === 'C' ? value.replace(/ +$/, '') : value;
  return `N'${text.replace(/'/g, "''")}'`;
}

export function insertSql(table: FoxTable): string[] {
  const fields = migratedFields(table);
  const columns = fields.map((f) => `[${f.name}]`).join(', ');
  const batches: string[] = [];
  for (let start = 0; start < table.records.length; start += INSERT_CHUNK_ROWS) {
    const rows = table.records
      .slice(start, start + INSERT_CHUNK_ROWS)
      .map((record) => `(${fields.map((f) => literal(record[f.name], f)).join(', ')})`);
    batches.push(`INSERT INTO dbo.[${table.name}] (${columns}) VALUES\n${rows.join(',\n')}`);
  }
  return batches;
}
