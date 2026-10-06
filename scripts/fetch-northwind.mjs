// Downloads the Visual FoxPro Northwind sample tables used by the conversion tests.
// The files come from the VFPX/Samples repository and are not committed here.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/VFPX/Samples/master/Northwind';
const OUT_DIR = join('test', 'fixtures', 'northwind');
const FILES = [
  'northwind.dbc', 'northwind.dct', 'northwind.dcx',
  'categories.dbf', 'categories.fpt',
  'customers.dbf',
  'employees.dbf', 'employees.fpt',
  'employeeterritories.dbf',
  'orderdetails.dbf',
  'orders.dbf',
  'products.dbf',
  'region.dbf',
  'shippers.dbf',
  'suppliers.dbf', 'suppliers.fpt',
  'territories.dbf',
];

mkdirSync(OUT_DIR, { recursive: true });
// Real FoxPro refuses to open a table whose structural index (.cdx) is missing.
const INDEXES = FILES.filter((f) => f.endsWith('.dbf')).map((f) => f.replace('.dbf', '.cdx'));
for (const name of [...FILES, ...INDEXES]) {
  const target = join(OUT_DIR, name);
  if (existsSync(target)) continue;
  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  console.log('downloaded', name);
}
console.log('Northwind fixtures ready in', OUT_DIR);
