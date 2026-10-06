// Prints the first differing rows of each case from a FQS_DUMP file:
//   $env:FQS_DUMP='test-results/dump.json'; npx vitest run test/northwind.integration.test.ts
//   node scripts/show-dump.mjs test-results/dump.json
import { readFileSync } from 'node:fs';

const MAX_ROWS = 4;
const norm = (v) => (typeof v === 'string' ? v.replace(/ +$/, '').replace(/T(\d\d:\d\d:\d\d\.\d{3})Z$/, ' $1') : typeof v === 'number' ? Number(v.toFixed(4)) : v);

for (const c of JSON.parse(readFileSync(process.argv[2], 'utf8'))) {
  const fox = c.foxPro.resultSets;
  const sql = c.sqlServer.resultSets;
  const notes = [...c.foxPro.errors.map((e) => `FoxPro error ${e}`)];
  if (c.sqlServer.error) notes.push(`SQL Server error ${c.sqlServer.error}`);
  if (fox.length !== sql.length) notes.push(`result sets: FoxPro ${fox.length}, SQL Server ${sql.length}`);
  fox.forEach((set, s) => {
    const other = sql[s]?.rows ?? [];
    if (set.rows.length !== other.length) notes.push(`set ${s + 1} rows: FoxPro ${set.rows.length}, SQL Server ${other.length}`);
    let shown = 0;
    set.rows.forEach((row, r) => {
      row.forEach((value, col) => {
        const a = norm(value);
        const b = norm(other[r]?.[col]);
        if (a !== b && shown++ < MAX_ROWS) notes.push(`set ${s + 1} row ${r + 1} ${set.columns[col]}: FoxPro ${JSON.stringify(a)} | SQL Server ${JSON.stringify(b)}`);
      });
    });
    if (shown > MAX_ROWS) notes.push(`  ... ${shown - MAX_ROWS} more differing cells`);
  });
  if (notes.length) console.log(`\n== ${c.name}\n${c.sql}\n${notes.join('\n')}`);
}
