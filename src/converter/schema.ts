import type { ColumnKind } from './functions';

/** A table named in a statement's FROM or JOIN clause. */
export interface TableRef {
  /** Table name as written, possibly schema-qualified. */
  name: string;
  alias?: string;
}

/** Where a column reference appears: its qualifier, if any, and the statement's tables. */
export interface ColumnContext {
  qualifier?: string;
  tables: TableRef[];
}

export type ColumnKindResolver = (column: string, context: ColumnContext) => ColumnKind | undefined;

export interface TableKinds {
  name: string;
  columns: { name: string; kind: ColumnKind | undefined }[];
}

const bare = (name: string) => name.split('.').pop()!.replace(/[[\]]/g, '').toLowerCase();

/**
 * Resolves a column's kind from the tables its statement reads. A column name alone
 * is not enough: in a real schema the same name has different types in different
 * tables, so the lookup is limited to the statement's own tables.
 */
export function createColumnResolver(tables: TableKinds[]): ColumnKindResolver {
  const byTable = new Map<string, Map<string, ColumnKind | undefined>>();
  for (const table of tables) {
    byTable.set(bare(table.name), new Map(table.columns.map((c) => [c.name.toLowerCase(), c.kind])));
  }

  return (column, { qualifier, tables: refs }) => {
    const name = bare(column);
    if (qualifier) {
      const wanted = bare(qualifier);
      const ref = refs.find((r) => r.alias?.toLowerCase() === wanted) ?? refs.find((r) => bare(r.name) === wanted);
      return ref ? byTable.get(bare(ref.name))?.get(name) : undefined;
    }
    // Unqualified: the column must mean the same kind in every table of the statement that has it.
    const kinds = new Set<ColumnKind | undefined>();
    for (const ref of refs) {
      const columns = byTable.get(bare(ref.name));
      if (columns?.has(name)) kinds.add(columns.get(name));
    }
    return kinds.size === 1 ? [...kinds][0] : undefined;
  };
}
