import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RESULT_CURSOR, toRunnable } from '../../src/shared/fox-statements';

// Runs FoxPro source in a real Visual FoxPro 9 and returns every result set, so
// converted queries can be compared against what FoxPro itself produces.

export const VFP_EXE = process.env.FQS_VFP_EXE ?? 'D:\\SureHCS\\tools\\vfp9\\vfp9.exe';
export const isVfpAvailable = () => existsSync(VFP_EXE);

export type VfpCell = string | number | boolean | Date | null;

export interface VfpScript {
  id: string;
  /** FoxPro statements, one per logical line (`;` continues a line). */
  source: string;
}

/** Where FoxPro finds the tables: a database container, a folder of free tables, or both. */
export interface VfpSource {
  database?: string;
  directory?: string;
}

export interface VfpResult {
  id: string;
  resultSets: { columns: string[]; rows: VfpCell[][] }[];
  errors: string[];
}

const TIMEOUT_MS = 180_000;
const CODE_PAGE = 'windows-1252';

/** Dumps a cursor with typed, delimiter-safe cells (strings as hex of their bytes). */
const DUMP_PROCEDURE = `
PROCEDURE fqs_dump(tcAlias)
  LOCAL lnI, lcLine, luV, lcT
  IF !USED(tcAlias)
    =FWRITE(gnOut, "#NOCURSOR" + CHR(13) + CHR(10))
    RETURN
  ENDIF
  SELECT (tcAlias)
  lcLine = "#SET"
  FOR lnI = 1 TO FCOUNT()
    lcLine = lcLine + "|" + FIELD(lnI)
  ENDFOR
  =FWRITE(gnOut, lcLine + CHR(13) + CHR(10))
  SCAN
    lcLine = "#ROW"
    FOR lnI = 1 TO FCOUNT()
      luV = EVALUATE(tcAlias + "." + FIELD(lnI))
      lcT = VARTYPE(luV)
      DO CASE
      CASE ISNULL(luV)
        lcLine = lcLine + "|X:"
      CASE lcT = "C"
        lcLine = lcLine + "|C:" + STRCONV(luV, 15)
      CASE lcT = "Y"
        lcLine = lcLine + "|N:" + ALLTRIM(STR(MTON(luV), 30, 8))
      CASE lcT = "N"
        lcLine = lcLine + "|N:" + ALLTRIM(STR(luV, 30, 8))
      CASE lcT = "D"
        lcLine = lcLine + "|D:" + DTOS(luV)
      CASE lcT = "T"
        lcLine = lcLine + "|T:" + TTOC(luV, 1)
      CASE lcT = "L"
        lcLine = lcLine + "|L:" + IIF(luV, "T", "F")
      OTHERWISE
        lcLine = lcLine + "|?:" + lcT
      ENDCASE
    ENDFOR
    =FWRITE(gnOut, lcLine + CHR(13) + CHR(10))
  ENDSCAN
  USE IN (tcAlias)
ENDPROC

PROCEDURE fqs_error(tnError, tcMessage)
  =FWRITE(gnOut, "#ERR|" + TRANSFORM(tnError) + "|" + STRCONV(tcMessage, 15) + CHR(13) + CHR(10))
ENDPROC
`;

function buildProgram(scripts: VfpScript[], source: VfpSource, outputPath: string): string {
  const lines = [
    'SET TALK OFF',
    'SET SAFETY OFF',
    'SET EXCLUSIVE OFF',
    'SET DELETED ON',
    'SET DATE DMY',
    'SET CENTURY ON',
    // Computed columns are rounded to SET DECIMALS; raise it so the arithmetic itself is compared.
    'SET DECIMALS TO 8',
    'PUBLIC gnOut',
    `gnOut = FCREATE("${outputPath}")`,
    'ON ERROR DO fqs_error WITH ERROR(), MESSAGE()',
    // Free tables are found by name in the default directory; a container is opened explicitly.
    ...(source.directory ? [`SET DEFAULT TO "${resolve(source.directory)}"`] : []),
    ...(source.database ? [`OPEN DATABASE "${resolve(source.database)}" SHARED NOUPDATE`] : []),
  ];
  scripts.forEach((script, index) => {
    lines.push(`=FWRITE(gnOut, "#CASE|${index}" + CHR(13) + CHR(10))`);
    for (const { statement, dumps } of toRunnable(script.source)) {
      // EXECSCRIPT compiles each statement on its own, so one bad statement cannot stop the program.
      lines.push('TEXT TO lcStatement NOSHOW', statement, 'ENDTEXT', '=EXECSCRIPT(lcStatement)');
      if (dumps) lines.push(`DO fqs_dump WITH "${RESULT_CURSOR}"`);
    }
  });
  lines.push('=FCLOSE(gnOut)', 'CLOSE DATABASES ALL', 'QUIT', DUMP_PROCEDURE);
  return lines.join('\r\n');
}

const decodeHex = (hex: string) => new TextDecoder(CODE_PAGE).decode(Buffer.from(hex, 'hex'));

function parseCell(cell: string): VfpCell {
  const value = cell.slice(2);
  switch (cell[0]) {
    case 'C':
      return decodeHex(value);
    case 'N':
      return Number(value);
    case 'L':
      return value === 'T';
    case 'D':
      return /^\d{8}$/.test(value) ? new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)))) : null;
    case 'T': {
      const [y, m, d, h, min, s] = [0, 4, 6, 8, 10, 12].map((at, i) => Number(value.slice(at, at + (i ? 2 : 4))));
      return value.trim() ? new Date(Date.UTC(y, m - 1, d, h, min, s)) : null;
    }
    case 'X':
      return null;
    default:
      throw new Error(`Unsupported FoxPro value type in oracle output: ${cell}`);
  }
}

function parseOutput(text: string, scripts: VfpScript[]): VfpResult[] {
  const results: VfpResult[] = scripts.map((s) => ({ id: s.id, resultSets: [], errors: [] }));
  let current: VfpResult | undefined;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [tag, ...cells] = line.split('|');
    if (tag === '#CASE') current = results[Number(cells[0])];
    else if (!current) throw new Error(`Oracle output before first case: ${line}`);
    else if (tag === '#SET') current.resultSets.push({ columns: cells.map((c) => c.toLowerCase()), rows: [] });
    else if (tag === '#ROW') current.resultSets[current.resultSets.length - 1].rows.push(cells.map(parseCell));
    else if (tag === '#ERR') current.errors.push(`${cells[0]}: ${decodeHex(cells[1])}`);
    else if (tag === '#NOCURSOR') current.errors.push('statement produced no cursor');
  }
  return results;
}

/** Runs a complete FoxPro program without a window; the program must end with QUIT. */
export function runProgram(program: string, workDir: string): void {
  if (/[^\x00-\xff]/.test(program)) throw new Error('FoxPro source must fit the Windows-1252 code page.');
  const prg = join(workDir, 'fqs_run.prg');
  const config = join(workDir, 'fqs_run.fpw');
  writeFileSync(prg, Buffer.from(program, 'latin1'));
  // CODEPAGE pins the session to Windows-1252 whatever the system locale is.
  writeFileSync(config, `SCREEN=OFF\r\nRESOURCE=OFF\r\nCODEPAGE=1252\r\nCOMMAND=DO "${prg}"\r\n`, 'latin1');
  try {
    execFileSync(VFP_EXE, ['-T', `-C${config}`], { cwd: workDir, timeout: TIMEOUT_MS, stdio: 'ignore' });
  } finally {
    for (const file of [prg, config, join(workDir, 'fqs_run.fxp')]) rmSync(file, { force: true });
  }
}

/** Runs all scripts in one FoxPro session and returns their result sets. */
export function runInVfp(scripts: VfpScript[], source: VfpSource): VfpResult[] {
  const dir = mkdtempSync(join(tmpdir(), 'fqs-vfp-'));
  try {
    const output = join(dir, 'out.txt');
    runProgram(buildProgram(scripts, source, output), dir);
    return parseOutput(readFileSync(output, 'latin1'), scripts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
