import { createColumnResolver, type ColumnContext, type ColumnKind, type ColumnKindResolver } from '../../src/converter';
import type { FoxTable } from '../../tools/dbf/database';
import { createTableSql, insertSql } from '../../tools/dbf/to-sql';
import { runBatches, type SqlBatchResult, type SqlCell } from '../../tools/sqlrun';

export type Cell = string | number | boolean | Date | null;
export type Normalized = string | number | boolean | null;

export const NUMBER_DECIMALS = 4;

/** Converter column kind for each FoxPro field type. */
export const KIND_BY_TYPE: Record<string, ColumnKind> = {
  C: 'string', V: 'varstring', M: 'varstring',
  N: 'number', F: 'number', I: 'number', Y: 'number', B: 'number',
  L: 'bool', D: 'date', T: 'datetime',
};

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Brings a value from FoxPro, SQL Server or the reference to one comparable form. */
export function normalize(value: Cell | SqlCell, decimals = NUMBER_DECIMALS): Normalized {
  if (value instanceof Date) {
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    return `${date} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}`;
  }
  // FoxPro result columns are fixed-width, so trailing blanks carry no information.
  if (typeof value === 'string') return value.replace(/ +$/, '');
  if (typeof value === 'number') return Number(value.toFixed(decimals)) + 0;
  return value;
}

export function normalizeRows(rows: (Cell | SqlCell)[][], ordered: boolean, decimals = NUMBER_DECIMALS): Normalized[][] {
  const normalized = rows.map((row) => row.map((cell) => normalize(cell, decimals)));
  return ordered ? normalized : normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function requireOk(results: SqlBatchResult[]): SqlBatchResult[] {
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`${failed.id}: ${failed.error}`);
  return results;
}

/**
 * Drops and recreates a LocalDB database, then loads the FoxPro tables into it.
 * collation overrides the server default (case-insensitive) for the whole database.
 */
export function importDatabase(database: string, tables: FoxTable[], collation?: string): void {
  requireOk(
    runBatches('master', [
      { id: 'drop', sql: `IF DB_ID('${database}') IS NOT NULL BEGIN ALTER DATABASE ${database} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${database}; END` },
      { id: 'create', sql: `CREATE DATABASE ${database}${collation ? ` COLLATE ${collation}` : ''}` },
    ]),
  );
  requireOk(
    runBatches(
      database,
      tables.flatMap((t) => [
        { id: `create ${t.name}`, sql: createTableSql(t) },
        ...insertSql(t).map((sql, i) => ({ id: `insert ${t.name} #${i}`, sql })),
      ]),
    ),
  );
}

/** Declared width of character fields, for the reverse converter's literal padding. */
export function columnWidthResolver(tables: FoxTable[]): (column: string, context: ColumnContext) => number | undefined {
  const byTable = new Map(tables.map((t) => [t.name.toLowerCase(), new Map(t.fields.filter((f) => f.type === 'C').map((f) => [f.name.toLowerCase(), f.length]))]));
  return (column, { qualifier, tables: refs }) => {
    const wanted = qualifier?.toLowerCase();
    const candidates = wanted ? refs.filter((r) => r.alias?.toLowerCase() === wanted || r.name.toLowerCase() === wanted) : refs;
    const widths = new Set(candidates.map((r) => byTable.get(r.name.replace(/^dbo\./i, '').toLowerCase())?.get(column.toLowerCase())).filter((w) => w !== undefined));
    return widths.size === 1 ? [...widths][0] : undefined;
  };
}

/** Column kinds of the FoxPro tables, looked up through the tables each statement reads, as the app does. */
export function columnKindResolver(tables: FoxTable[]): ColumnKindResolver {
  const kindOf = (f: FoxTable['fields'][number]) => (f.type === 'I' || (f.type === 'N' && f.decimals === 0) ? 'integer' : KIND_BY_TYPE[f.type]);
  return createColumnResolver(tables.map((t) => ({ name: t.name, columns: t.fields.map((f) => ({ name: f.name, kind: kindOf(f) })) })));
}
