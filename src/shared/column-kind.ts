import { createColumnResolver, type ColumnKind, type ColumnKindResolver } from '../converter';
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

/** Column kinds of a loaded schema, looked up through the tables each statement reads. */
export function columnKindResolver(tables: SchemaTable[]): ColumnKindResolver {
  return createColumnResolver(tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, kind: columnKind(c) })) })));
}
