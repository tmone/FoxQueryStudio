import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readOnlyViolation, RESULT_CURSOR, toRunnable } from '../shared/fox-statements';
import type { CellValue, DbApi, ExecuteResult, ResultSet, SchemaTable } from '../shared/types';

/**
 * Runs queries on a FoxPro database with FoxPro itself: a windowless Visual FoxPro process
 * that stays up while the database is open. Each query tab gets a private data session, so
 * its cursors live between runs and never meet another tab's.
 *
 * FoxPro has no console to talk through, so requests and answers are exchanged as files in
 * a private folder: one request at a time, each file moved into place when complete.
 */

const CODE_PAGE = 'windows-1252';
const CRLF = '\r\n';
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_MS = 10;
const EXIT_TIMEOUT_MS = 5000;
const STANDARD_LOCATIONS = ['C:\\Program Files (x86)\\Microsoft Visual FoxPro 9\\vfp9.exe', 'C:\\Program Files\\Microsoft Visual FoxPro 9\\vfp9.exe'];

/** SQL Server type name that gives each FoxPro field type its column kind in the converters. */
const TYPE_NAME: Record<string, string> = { C: 'char', V: 'varchar', M: 'text', N: 'decimal', F: 'decimal', I: 'int', Y: 'money', B: 'float', L: 'bit', D: 'date', T: 'datetime' };

/** The server loop; `@WORK@`, `@DIR@` and `@DBC@` are filled in for each database. */
const SERVER_PROGRAM = String.raw`
SET TALK OFF
SET SAFETY OFF
SET EXCLUSIVE OFF
SET TABLEPROMPT OFF
PUBLIC gnOut, gnMax, goSessions, gcDatabase
DECLARE Sleep IN kernel32 INTEGER
goSessions = CREATEOBJECT("Collection")
gcDatabase = "@DBC@"
gnOut = -1
ON ERROR DO fqs_error WITH ERROR(), MESSAGE()
SET DEFAULT TO "@DIR@"
LOCAL lcRequestFile, lcAnswerFile, lcPartFile, lcRequest, lcOp, lcSession, lcStatement, llDump, llHave, lnLines, lnI
LOCAL ARRAY laLines[1]
lcRequestFile = "@WORK@\request.txt"
lcAnswerFile = "@WORK@\answer.txt"
lcPartFile = "@WORK@\answer.part"
=STRTOFILE("ready", "@WORK@\ready.txt")
DO WHILE .T.
  IF !FILE(lcRequestFile)
    =Sleep(10)
    LOOP
  ENDIF
  lcRequest = FILETOSTR(lcRequestFile)
  ERASE (lcRequestFile)
  gnOut = FCREATE(lcPartFile)
  lnLines = ALINES(laLines, lcRequest)
  lcOp = GETWORDNUM(laLines[1], 1, "|")
  lcSession = GETWORDNUM(laLines[1], 2, "|")
  gnMax = VAL(GETWORDNUM(laLines[1], 3, "|"))
  DO CASE
  CASE lcOp == "QUIT"
    =FCLOSE(gnOut)
    EXIT
  CASE lcOp == "CLOSE"
    IF goSessions.GetKey(lcSession) > 0
      SET DATASESSION TO 1
      goSessions.Remove(lcSession)
    ENDIF
  CASE lcOp == "SCHEMA"
    DO fqs_use WITH lcSession
    DO fqs_schema
  CASE lcOp == "EXEC"
    DO fqs_use WITH lcSession
    lcStatement = ""
    llHave = .F.
    FOR lnI = 2 TO lnLines
      IF LEFT(laLines[lnI], 3) == "#S|"
        IF llHave
          DO fqs_run WITH lcStatement, llDump
        ENDIF
        lcStatement = ""
        llDump = SUBSTR(laLines[lnI], 4, 1) == "1"
        llHave = .T.
      ELSE
        lcStatement = lcStatement + laLines[lnI] + CHR(13) + CHR(10)
      ENDIF
    ENDFOR
    IF llHave
      DO fqs_run WITH lcStatement, llDump
    ENDIF
  ENDCASE
  =FWRITE(gnOut, "#END" + CHR(13) + CHR(10))
  =FCLOSE(gnOut)
  RENAME (lcPartFile) TO (lcAnswerFile)
ENDDO
CLOSE DATABASES ALL
QUIT

PROCEDURE fqs_use(tcSession)
  LOCAL loSession
  IF goSessions.GetKey(tcSession) > 0
    SET DATASESSION TO goSessions.Item(tcSession).DataSessionId
    RETURN
  ENDIF
  loSession = CREATEOBJECT("Session")
  goSessions.Add(loSession, tcSession)
  SET DATASESSION TO loSession.DataSessionId
  * These settings are private to each data session.
  SET TALK OFF
  SET SAFETY OFF
  SET EXCLUSIVE OFF
  SET DELETED ON
  SET CENTURY ON
  * A missing table must be an error; the default is a file dialog nobody can see.
  SET TABLEPROMPT OFF
  IF !EMPTY(gcDatabase)
    OPEN DATABASE (gcDatabase) SHARED NOUPDATE
  ENDIF
ENDPROC

PROCEDURE fqs_run(tcStatement, tlDump)
  * EXECSCRIPT compiles each statement on its own, so one bad statement cannot stop the server.
  =EXECSCRIPT(tcStatement)
  IF tlDump
    DO fqs_dump WITH "${RESULT_CURSOR}"
  ENDIF
ENDPROC

PROCEDURE fqs_schema
  LOCAL lnTables, lnI, lnJ, lnFields, lcName
  LOCAL ARRAY laTables[1], laFiles[1], laFields[1]
  IF !EMPTY(gcDatabase)
    lnTables = ADBOBJECTS(laTables, "TABLE")
  ELSE
    lnTables = ADIR(laFiles, "*.dbf")
    IF lnTables > 0
      DIMENSION laTables[lnTables]
      FOR lnI = 1 TO lnTables
        laTables[lnI] = JUSTSTEM(laFiles[lnI, 1])
      ENDFOR
    ENDIF
  ENDIF
  FOR lnI = 1 TO lnTables
    lcName = laTables[lnI]
    USE (lcName) AGAIN SHARED NOUPDATE ALIAS fqs_s IN 0
    IF !USED("fqs_s")
      LOOP
    ENDIF
    lnFields = AFIELDS(laFields, "fqs_s")
    =FWRITE(gnOut, "#TBL|" + LOWER(lcName) + "|" + TRANSFORM(RECCOUNT("fqs_s")) + CHR(13) + CHR(10))
    FOR lnJ = 1 TO lnFields
      =FWRITE(gnOut, "#FLD|" + LOWER(laFields[lnJ, 1]) + "|" + laFields[lnJ, 2] + "|" + TRANSFORM(laFields[lnJ, 3]) + "|" + TRANSFORM(laFields[lnJ, 4]) + "|" + IIF(laFields[lnJ, 5], "1", "0") + CHR(13) + CHR(10))
    ENDFOR
    USE IN fqs_s
  ENDFOR
ENDPROC

* Dumps a cursor with typed, delimiter-safe cells (strings as hex of their bytes).
PROCEDURE fqs_dump(tcAlias)
  LOCAL lnI, lcLine, luV, lcT, lnRows
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
  lnRows = 0
  SCAN
    IF lnRows >= gnMax
      =FWRITE(gnOut, "#TRUNC" + CHR(13) + CHR(10))
      EXIT
    ENDIF
    lnRows = lnRows + 1
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
  IF gnOut >= 0
    =FWRITE(gnOut, "#ERR|" + TRANSFORM(tnError) + "|" + STRCONV(tcMessage, 15) + CHR(13) + CHR(10))
  ENDIF
ENDPROC
`;

const decodeHex = (hex: string) => new TextDecoder(CODE_PAGE).decode(Buffer.from(hex, 'hex'));
const fitsCodePage = (text: string) => !/[^\x00-\xff]/.test(text);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Display-ready values, in the forms the SQL Server driver's results use. */
function parseCell(cell: string): CellValue {
  const value = cell.slice(2);
  switch (cell[0]) {
    case 'C':
      // Character fields are fixed-width; the padding carries no information on screen.
      return decodeHex(value).replace(/ +$/, '');
    case 'N':
      return Number(value);
    case 'L':
      return value === 'T';
    case 'D':
      // FoxPro's empty date has no value to show.
      return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : '';
    case 'T': {
      if (!/^\d{14}$/.test(value)) return '';
      const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      const time = `${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}`;
      return time === '00:00:00' ? date : `${date} ${time}`;
    }
    case 'X':
      return null;
    default:
      return '(nhị phân)';
  }
}

interface Answer {
  resultSets: ResultSet[];
  errors: string[];
  truncated: boolean;
  tables: SchemaTable[];
}

function parseAnswer(text: string): Answer {
  const answer: Answer = { resultSets: [], errors: [], truncated: false, tables: [] };
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [tag, ...cells] = line.split('|');
    if (tag === '#SET') answer.resultSets.push({ columns: cells.map((c) => c.toLowerCase()), rows: [] });
    else if (tag === '#ROW') answer.resultSets[answer.resultSets.length - 1].rows.push(cells.map(parseCell));
    else if (tag === '#TRUNC') answer.truncated = true;
    else if (tag === '#ERR') answer.errors.push(decodeHex(cells[1]));
    else if (tag === '#TBL') answer.tables.push({ schema: '', name: cells[0], isView: false, columns: [] });
    else if (tag === '#FLD') {
      const [name, type, length, decimals, nullable] = cells;
      const width = Number(length);
      // A numeric field without decimals holds whole numbers; the converters treat it as an integer.
      const dataType = (type === 'N' || type === 'F') && decimals === '0' ? 'int' : (TYPE_NAME[type] ?? 'binary');
      const display = type === 'C' || type === 'V' ? `${type}(${width})` : type === 'N' || type === 'F' ? `${type}(${width},${decimals})` : type;
      answer.tables[answer.tables.length - 1].columns.push({ name, dataType, display, maxLength: type === 'C' || type === 'V' ? width : null, nullable: nullable === '1' });
    }
  }
  return answer;
}

/** Where Visual FoxPro 9 is: FQS_VFP_EXE, a copy shipped next to the app, or its standard install folder. */
export function findVfp(extra: string[] = []): string | undefined {
  return [process.env.FQS_VFP_EXE, ...extra, ...STANDARD_LOCATIONS].find((path) => path && existsSync(path));
}

export interface FoxEngine extends DbApi {
  /** Opens a database container (.dbc), or the folder of a free table (.dbf), for querying. */
  openDatabase(path: string): Promise<void>;
  /** Folder or container currently open. */
  readonly path: string | undefined;
}

export function createFoxEngine(locateVfp: () => string | undefined = findVfp): FoxEngine {
  let child: ChildProcess | undefined;
  let workDir: string | undefined;
  let openedPath: string | undefined;
  /** Requests run one at a time; FoxPro is single-threaded. */
  let queue: Promise<unknown> = Promise.resolve();

  const file = (name: string) => join(workDir!, name);

  async function waitFor(path: string, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
      if (!child) throw new Error(`FoxPro đã dừng khi ${what}.`);
      if (Date.now() > deadline) throw new Error(`FoxPro không trả lời khi ${what}.`);
      await delay(POLL_MS);
    }
  }

  function stop(): void {
    const dir = workDir;
    child?.kill();
    child = undefined;
    workDir = undefined;
    openedPath = undefined;
    // FoxPro may still hold its folder for a moment; a leftover temp folder is harmless.
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // Left for the system to clean up.
      }
    }
  }

  /** Lets FoxPro close its tables and leave by itself, then clears up. */
  async function shutdown(): Promise<void> {
    const running = child;
    if (!running) return;
    const exited = new Promise<void>((resolve) => running.once('exit', () => resolve()));
    await request('QUIT||0').catch(() => undefined);
    await Promise.race([exited, delay(EXIT_TIMEOUT_MS)]);
    stop();
  }

  function request(head: string, body: string[] = []): Promise<Answer> {
    const task = queue.then(async () => {
      if (!child || !workDir) throw new Error('Chưa mở CSDL FoxPro.');
      rmSync(file('answer.txt'), { force: true });
      writeFileSync(file('request.part'), Buffer.from([head, ...body].join(CRLF) + CRLF, 'latin1'));
      renameSync(file('request.part'), file('request.txt'));
      try {
        await waitFor(file('answer.txt'), REQUEST_TIMEOUT_MS, 'chạy lệnh');
      } catch (e) {
        // A query that never returns holds the only thread; the engine is given up on.
        stop();
        throw e;
      }
      return parseAnswer(readFileSync(file('answer.txt'), 'latin1'));
    });
    queue = task.catch(() => undefined);
    return task;
  }

  return {
    get path() {
      return openedPath;
    },

    async connect() {
      throw new Error('Engine FoxPro chỉ mở tệp CSDL FoxPro.');
    },

    async openDatabase(path) {
      const exe = locateVfp();
      if (!exe) throw new Error('Không tìm thấy Visual FoxPro 9 trên máy này (vfp9.exe). Đặt biến môi trường FQS_VFP_EXE trỏ tới nó.');
      const isContainer = path.toLowerCase().endsWith('.dbc');
      const directory = statSync(path).isDirectory() ? path : dirname(path);
      if (!fitsCodePage(path)) throw new Error('Đường dẫn có ký tự ngoài bảng mã Windows-1252; hãy chuyển CSDL sang thư mục có tên không dấu.');
      await shutdown();

      workDir = mkdtempSync(join(tmpdir(), 'fqs-fox-'));
      const program = SERVER_PROGRAM.replaceAll('@WORK@', workDir).replaceAll('@DIR@', directory).replaceAll('@DBC@', isContainer ? path : '');
      writeFileSync(file('server.prg'), Buffer.from(program.replace(/\r?\n/g, CRLF), 'latin1'));
      // CODEPAGE pins the session to Windows-1252 whatever the system locale is.
      writeFileSync(file('server.fpw'), `SCREEN=OFF${CRLF}RESOURCE=OFF${CRLF}CODEPAGE=1252${CRLF}COMMAND=DO "${file('server.prg')}"${CRLF}`, 'latin1');
      const started = spawn(exe, ['-T', `-C${file('server.fpw')}`], { cwd: workDir, stdio: 'ignore', windowsHide: true });
      child = started;
      started.on('exit', () => {
        if (child === started) child = undefined;
      });
      started.on('error', () => {
        if (child === started) child = undefined;
      });
      try {
        await waitFor(file('ready.txt'), STARTUP_TIMEOUT_MS, 'khởi động');
      } catch (e) {
        stop();
        throw e;
      }
      openedPath = path;
    },

    disconnect: shutdown,

    async closeSession(sessionId) {
      if (child) await request(`CLOSE|${sessionId}|0`).catch(() => undefined);
    },

    async loadSchema() {
      const answer = await request('SCHEMA|__schema|0');
      await request('CLOSE|__schema|0');
      if (!answer.tables.length) throw new Error(answer.errors[0] ?? 'Không tìm thấy bảng nào.');
      return answer.tables.sort((a, b) => a.name.localeCompare(b.name));
    },

    async execute(sessionId, source, maxRows): Promise<ExecuteResult> {
      const started = Date.now();
      const failed = (error: string, sessionReset?: boolean): ExecuteResult => ({ resultSets: [], messages: [], error, truncated: false, sessionReset, elapsedMs: Date.now() - started });
      if (!fitsCodePage(source)) return failed('Lệnh có ký tự ngoài bảng mã Windows-1252 của CSDL FoxPro.');
      const statements = toRunnable(source);
      const violation = statements.map((s) => readOnlyViolation(s.statement)).find(Boolean);
      if (violation) return failed(violation);

      let answer: Answer;
      try {
        answer = await request(`EXEC|${sessionId}|${maxRows}`, statements.flatMap((s) => [`#S|${s.dumps ? 1 : 0}`, ...s.statement.split('\n')]));
      } catch (e) {
        return failed((e as Error).message, true);
      }
      return {
        resultSets: answer.resultSets,
        messages: [],
        error: answer.errors.length ? answer.errors.join('\n') : undefined,
        truncated: answer.truncated,
        elapsedMs: Date.now() - started,
      };
    },
  };
}
