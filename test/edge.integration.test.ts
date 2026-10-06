import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { convertFoxPro } from '../src/converter';
import { loadFoxDatabase } from '../src/dbf/database';
import { isLocalDbAvailable, runBatches, type SqlBatchResult } from '../tools/sqlrun';
import { isVfpAvailable, runInVfp, runProgram, type VfpResult } from '../tools/vfp/oracle';
import { CONDITIONS, TEXT_EXPRESSIONS, VALUE_EXPRESSIONS } from './edge/expressions';
import { KNOWN_DIFFERENCES } from './edge/known-differences';
import { CREATE_EDGE_TABLE } from './edge/table';
import { columnKindResolver, importDatabase, normalizeRows } from './support/harness';

// Expression-level comparison: every FoxPro expression in test/edge/expressions.ts is
// evaluated on a table of boundary values by a real Visual FoxPro 9 and, after
// conversion, by SQL Server. Both must return the same value on every row.

const DATABASE = 'FqsEdge';
// FoxPro compares and sorts by byte value (SET COLLATE MACHINE). A binary database
// collation keeps that property out of the comparison, so only the conversion is tested.
const COLLATION = 'Latin1_General_BIN2';
const SETUP_TIMEOUT_MS = 300_000;
const TEXT_WIDTH = 60;

interface Check {
  /** The expression or condition as listed. */
  label: string;
  fox: string;
}

const CHECKS: Check[] = [
  ...TEXT_EXPRESSIONS.map((e) => ({ label: e, fox: `SELECT id, PADR(${e}, ${TEXT_WIDTH}) AS r FROM edge ORDER BY id` })),
  ...VALUE_EXPRESSIONS.map((e) => ({ label: e, fox: `SELECT id, ${e} AS r FROM edge ORDER BY id` })),
  ...CONDITIONS.map((e) => ({ label: `WHERE ${e}`, fox: `SELECT id FROM edge WHERE ${e} ORDER BY id` })),
  ...CONDITIONS.map((e) => ({ label: `WHERE NOT (${e})`, fox: `SELECT id FROM edge WHERE NOT (${e}) ORDER BY id` })),
];

describe.skipIf(!isVfpAvailable() || !isLocalDbAvailable())('FoxPro expressions on boundary values', () => {
  let dir: string;
  const foxPro = new Map<string, VfpResult>();
  const sqlServer = new Map<string, SqlBatchResult>();
  const sqlText = new Map<string, string>();
  const conversionErrors = new Map<string, string[]>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fqs-edge-'));
    runProgram(CREATE_EDGE_TABLE, dir);
    const tables = loadFoxDatabase(dir);
    importDatabase(DATABASE, tables, COLLATION);
    const resolveColumnKind = columnKindResolver(tables);

    const batches = CHECKS.map((check) => {
      const converted = convertFoxPro(check.fox, { resolveColumnKind });
      sqlText.set(check.label, converted.sql);
      conversionErrors.set(check.label, converted.errors.map((e) => e.message));
      return { id: check.label, sql: converted.sql || 'SELECT 1 WHERE 1 = 0' };
    });
    for (const result of runBatches(DATABASE, batches)) sqlServer.set(result.id, result);
    for (const result of runInVfp(CHECKS.map((c) => ({ id: c.label, source: c.fox })), { directory: dir })) foxPro.set(result.id, result);

    // FQS_REPORT=<file> lists every difference, including the documented ones.
    if (process.env.FQS_REPORT) {
      const lines: string[] = [];
      for (const check of CHECKS) {
        const fox = foxPro.get(check.label)!;
        const sql = sqlServer.get(check.label)!;
        const problems = [...conversionErrors.get(check.label)!.map((e) => `converter: ${e}`), ...fox.errors.map((e) => `FoxPro: ${e}`)];
        if (sql.error) problems.push(`SQL Server: ${sql.error}`);
        const a = normalizeRows(fox.resultSets[0]?.rows ?? [], true);
        const b = normalizeRows(sql.resultSets[0]?.rows ?? [], true);
        if (!problems.length && JSON.stringify(a) !== JSON.stringify(b)) {
          const ids = new Set([...a, ...b].map((row) => row[0] as number));
          for (const id of [...ids].sort((x, y) => x - y)) {
            const x = JSON.stringify(a.find((row) => row[0] === id) ?? '(no row)');
            const y = JSON.stringify(b.find((row) => row[0] === id) ?? '(no row)');
            if (x !== y) problems.push(`id ${id}: FoxPro ${x} | SQL Server ${y}`);
          }
        }
        if (problems.length) lines.push(`${KNOWN_DIFFERENCES[check.label] ? '[known] ' : ''}${check.label}\n    ${sqlText.get(check.label)}\n    ${problems.join('\n    ')}`);
      }
      writeFileSync(process.env.FQS_REPORT, lines.join('\n\n'), 'utf8');
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('has no stale entries in the list of known differences', () => {
    const labels = new Set(CHECKS.map((c) => c.label));
    expect(Object.keys(KNOWN_DIFFERENCES).filter((label) => !labels.has(label))).toEqual([]);
  });

  it.each(CHECKS.filter((c) => !KNOWN_DIFFERENCES[c.label]).map((c) => [c.label, c] as const))('%s', (label) => {
    expect(conversionErrors.get(label), 'converter errors').toEqual([]);
    const fox = foxPro.get(label)!;
    const sql = sqlServer.get(label)!;
    expect(fox.errors, 'FoxPro errors').toEqual([]);
    expect(sql.error, `SQL Server rejected:\n${sqlText.get(label)}`).toBeNull();
    expect(normalizeRows(sql.resultSets[0].rows, true), sqlText.get(label)).toEqual(normalizeRows(fox.resultSets[0].rows, true));
  });

  // A documented difference that stops being one must be removed from the list.
  it.each(Object.entries(KNOWN_DIFFERENCES).filter(([label]) => CHECKS.some((c) => c.label === label)))('still differs: %s', (label) => {
    const fox = foxPro.get(label)!;
    const sql = sqlServer.get(label)!;
    const same =
      !fox.errors.length &&
      !sql.error &&
      !conversionErrors.get(label)!.length &&
      JSON.stringify(normalizeRows(sql.resultSets[0].rows, true)) === JSON.stringify(normalizeRows(fox.resultSets[0].rows, true));
    expect(same, 'this difference no longer exists').toBe(false);
  });
});
