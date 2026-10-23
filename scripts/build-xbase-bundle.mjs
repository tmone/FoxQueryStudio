// Bundles src/web/xbase.ts into dist/lv.xbase.js: one classic script that defines the global
// `lvXBase`, for hosts without a module loader (the OpenUI5 pages of the CnB legacy web).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const out = process.env.XBASE_OUT || 'dist/lv.xbase.js';

await build({
  entryPoints: ['src/web/xbase.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'lvXBase',
  platform: 'browser',
  // Chrome/Edge of the last years; the legacy site already needs them for OpenUI5 1.102.
  target: ['es2018'],
  outfile: out,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  define: { __XBASE_VERSION__: JSON.stringify(version) },
  banner: { js: `/* lv.xbase.js ${version} — xBase/T-SQL translation for the HRM web; built from FoxQuery Studio. Do not edit by hand. */` },
});
console.log(out);
