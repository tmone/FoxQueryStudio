// Prints the structure and row count of every .dbf in a folder: node scripts/inspect-dbf.mjs <dir>
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readDbf } from '../src/dbf/reader.ts';

const dir = process.argv[2] ?? join('test', 'fixtures', 'northwind');
for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.dbf'))) {
  const table = readDbf(join(dir, file));
  const fields = table.fields.map((f) => `${f.name} ${f.type}(${f.length}${f.decimals ? `,${f.decimals}` : ''})${f.nullable ? ' null' : ''}`);
  console.log(`${file}: ${table.records.length} rows, ${table.deletedCount} deleted\n  ${fields.join(', ')}`);
}
