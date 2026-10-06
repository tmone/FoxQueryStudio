import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readDbf, type DbfField, type DbfRecord } from './reader';

export interface FoxTable {
  name: string;
  fields: DbfField[];
  records: DbfRecord[];
}

/**
 * Long field names live in the database container (.dbc); the .dbf header only
 * keeps the first 10 characters. Returns table name to ordered field names.
 */
function readLongNames(dbcPath: string): Map<string, string[]> {
  const names = new Map<string, string[]>();
  if (!existsSync(dbcPath)) return names;
  const objects = readDbf(dbcPath).records;
  const text = (value: unknown) => String(value ?? '').trim().toLowerCase();
  for (const table of objects.filter((o) => text(o.objecttype) === 'table')) {
    const fields = objects.filter((o) => text(o.objecttype) === 'field' && o.parentid === table.objectid);
    names.set(text(table.objectname), fields.map((f) => text(f.objectname)));
  }
  return names;
}

/** Loads every table of a FoxPro database folder, with long field names when a .dbc is present. */
export function loadFoxDatabase(dir: string): FoxTable[] {
  const files = readdirSync(dir);
  const dbc = files.find((f) => f.toLowerCase().endsWith('.dbc'));
  const longNames = dbc ? readLongNames(join(dir, dbc)) : new Map<string, string[]>();

  return files
    .filter((f) => f.toLowerCase().endsWith('.dbf'))
    .map((file) => {
      const name = basename(file).slice(0, -4).toLowerCase();
      const table = readDbf(join(dir, file));
      const long = longNames.get(name);
      if (long?.length !== table.fields.length) return { name, fields: table.fields, records: table.records };

      const fields = table.fields.map((f, i) => ({ ...f, name: long[i] }));
      const records = table.records.map((record) =>
        Object.fromEntries(table.fields.map((f, i) => [long[i], record[f.name]])),
      );
      return { name, fields, records };
    });
}
