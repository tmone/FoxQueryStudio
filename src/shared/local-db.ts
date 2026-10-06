import type { ColumnKind } from '../converter';
import type { FoxTable } from '../dbf/database';
import type { DbfField } from '../dbf/reader';
import { createTableSql, insertSql, migratedFields, sqlType } from '../dbf/to-sql';

/**
 * A FoxPro database opened from a local folder. Its tables are copied into #temp tables of
 * a query tab's server session, which is exactly how FoxPro cursors live there: FoxPro
 * source reads them by name, T-SQL reads them as #name.
 */
export interface LocalDatabase {
  /** Folder the .dbf files were read from. */
  path: string;
  name: string;
  tables: LocalTable[];
  /** Tables left out, each with the reason. */
  skipped: string[];
}

export interface LocalTable {
  name: string;
  rowCount: number;
  columns: LocalColumn[];
}

export interface LocalColumn {
  name: string;
  /** SQL Server type the field is stored as. */
  dataType: string;
  kind: ColumnKind | undefined;
  /** Width of a fixed-width character field. */
  width?: number;
}

/** Window-level access to the local database, exposed through the preload bridge. */
export interface LocalDbApi {
  /** Asks for a folder and reads its tables; undefined when the dialog is cancelled. */
  open(): Promise<LocalDatabase | undefined>;
  close(): Promise<void>;
  /** Copies the named tables into the session's #temp tables, replacing earlier copies. */
  load(sessionId: string, tableNames: string[]): Promise<void>;
}

const KIND_BY_TYPE: Record<string, ColumnKind> = {
  C: 'string', V: 'varstring', M: 'varstring',
  N: 'number', F: 'number', I: 'integer', Y: 'number', B: 'number',
  L: 'bool', D: 'date', T: 'datetime',
};

/** A name the converters can write without brackets, as they do for cursors. */
const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;
/** Statements sent per round trip while copying a table. */
const BATCHES_PER_REQUEST = 20;

const kindOf = (field: DbfField): ColumnKind | undefined => (field.type === 'N' && field.decimals === 0 ? 'integer' : KIND_BY_TYPE[field.type]);

export const tempTableName = (table: string) => `#${table}`;

/** What the renderer needs to know about the tables; the records stay in the main process. */
export function describeDatabase(path: string, tables: FoxTable[]): LocalDatabase {
  const skipped: string[] = [];
  const described: LocalTable[] = [];
  for (const table of tables) {
    if (!PLAIN_NAME.test(table.name)) {
      skipped.push(`${table.name}: tên bảng có ký tự không dùng được trong truy vấn`);
      continue;
    }
    const fields = migratedFields(table);
    if (fields.length < table.fields.length) {
      const dropped = table.fields.filter((f) => !fields.includes(f)).map((f) => f.name);
      skipped.push(`${table.name}: bỏ cột kiểu nhị phân ${dropped.join(', ')}`);
    }
    described.push({
      name: table.name,
      rowCount: table.records.length,
      columns: fields.map((f) => ({ name: f.name, dataType: sqlType(f)!, kind: kindOf(f), width: f.type === 'C' ? f.length : undefined })),
    });
  }
  described.sort((a, b) => a.name.localeCompare(b.name));
  return { path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, tables: described, skipped };
}

/** The SQL that (re)creates one table as a #temp table, grouped into a few requests. */
export function loadTableSql(table: FoxTable): string[] {
  const target = `[${tempTableName(table.name)}]`;
  const statements = [`IF OBJECT_ID('tempdb..${target}') IS NOT NULL DROP TABLE ${target}`, createTableSql(table, target), ...insertSql(table, target)];
  const requests: string[] = [];
  for (let i = 0; i < statements.length; i += BATCHES_PER_REQUEST) requests.push(statements.slice(i, i + BATCHES_PER_REQUEST).join(';\n'));
  return requests;
}

/** Local tables a source mentions, by name or as #name. */
export function referencedTables(source: string, tables: LocalTable[]): string[] {
  const words = new Set((source.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []));
  return tables.filter((t) => words.has(t.name)).map((t) => t.name);
}
