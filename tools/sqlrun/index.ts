import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const LOCALDB_SERVER = '(localdb)\\MSSQLLocalDB';

export type SqlCell = string | number | boolean | null;

export interface SqlBatch {
  id: string;
  sql: string;
}

export interface SqlBatchResult {
  id: string;
  resultSets: { columns: string[]; rows: SqlCell[][] }[];
  error: string | null;
}

const SCRIPT = resolve('tools', 'sqlrun', 'run-batches.ps1');
const TIMEOUT_MS = 300_000;

/** Runs the batches in order on a single connection, so #temp tables carry over between them. */
export function runBatches(database: string, batches: SqlBatch[], server = LOCALDB_SERVER): SqlBatchResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'fqs-sql-'));
  try {
    const input = join(dir, 'in.json');
    const output = join(dir, 'out.json');
    writeFileSync(input, JSON.stringify(batches), 'utf8');
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Server', server, '-Database', database, '-InputFile', input, '-OutputFile', output],
      { timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function isLocalDbAvailable(): boolean {
  try {
    return runBatches('master', [{ id: 'ping', sql: 'SELECT 1' }])[0].error === null;
  } catch {
    return false;
  }
}
