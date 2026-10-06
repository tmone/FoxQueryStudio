import { createColumnResolver, type ColumnContext, type ColumnKind, type ColumnKindResolver } from '../converter';
import type { LocalTable } from './local-db';
import type { SchemaColumn, SchemaTable } from './types';

/** CHARACTER_MAXIMUM_LENGTH that SQL Server reports for varchar(max) and nvarchar(max). */
const MAX_TYPE_LENGTH = -1;

const KIND_BY_TYPE: Record<string, ColumnKind> = {
  int: 'integer', bigint: 'integer', smallint: 'integer', tinyint: 'integer', decimal: 'number', numeric: 'number',
  money: 'number', smallmoney: 'number', float: 'number', real: 'number',
  bit: 'bool',
  date: 'date', datetime: 'datetime', datetime2: 'datetime', smalldatetime: 'datetime', datetimeoffset: 'datetime',
  char: 'string', varchar: 'string', nchar: 'string', nvarchar: 'string', text: 'varstring', ntext: 'varstring',
};

/** How FoxPro would see a SQL Server column; the (max) types arrive as memo fields with no fixed width. */
export function columnKind(column: SchemaColumn): ColumnKind | undefined {
  const kind = KIND_BY_TYPE[column.dataType.toLowerCase()];
  return kind === 'string' && column.maxLength === MAX_TYPE_LENGTH ? 'varstring' : kind;
}

/**
 * Column kinds of a loaded schema, looked up through the tables each statement reads.
 * A local FoxPro table hides a server table of the same name, as a cursor would.
 */
export function columnKindResolver(tables: SchemaTable[], local: LocalTable[] = []): ColumnKindResolver {
  return createColumnResolver([
    ...tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, kind: columnKind(c) })) })),
    ...local.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, kind: c.kind })) })),
  ]);
}

/** Widest character column FoxPro keeps as a fixed-width field; longer ones arrive as memo. */
const MAX_FIELD_WIDTH = 254;
const CHARACTER_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar']);
const bareName = (name: string) => name.split('.').pop()!.replace(/[[\]]/g, '').toLowerCase();

/** Declared width of character columns, looked up through the tables each statement reads. */
export function columnWidthResolver(tables: SchemaTable[], local: LocalTable[] = []): (column: string, context: ColumnContext) => number | undefined {
  const isField = (c: SchemaColumn) => CHARACTER_TYPES.has(c.dataType.toLowerCase()) && c.maxLength !== null && c.maxLength > 0 && c.maxLength <= MAX_FIELD_WIDTH;
  const byTable = new Map(tables.map((t) => [t.name.toLowerCase(), new Map(t.columns.filter(isField).map((c) => [c.name.toLowerCase(), c.maxLength!]))]));
  for (const t of local) byTable.set(t.name, new Map(t.columns.filter((c) => c.width !== undefined).map((c) => [c.name.toLowerCase(), c.width!])));
  return (column, { qualifier, tables: refs }) => {
    const wanted = qualifier && bareName(qualifier);
    const candidates = wanted ? refs.filter((r) => r.alias?.toLowerCase() === wanted || bareName(r.name) === wanted) : refs;
    const widths = new Set(candidates.map((r) => byTable.get(bareName(r.name))?.get(bareName(column))).filter((w) => w !== undefined));
    return widths.size === 1 ? [...widths][0] : undefined;
  };
}
