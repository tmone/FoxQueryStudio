import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mismatchHint, readOnlyViolation, RESULT_CURSOR, toRunnable, type RunnableStatement } from '../shared/fox-statements';
import type { CellValue, DbBackend, ExecuteResult, ResultSet, SchemaTable } from '../shared/types';

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
/** Marks the start of each statement in a request to FoxPro. */
const FRAME_PREFIX = '#S|';
/** The session that lists the objects of the database; it comes and goes with each listing. */
const SCHEMA_SESSION = '__schema';
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
PUBLIC gnOut, gnMax, goSessions, gcDatabase, glFailed
DECLARE Sleep IN kernel32 INTEGER
goSessions = CREATEOBJECT("Collection")
gcDatabase = "@DBC@"
gnOut = -1
ON ERROR DO fqs_error WITH ERROR(), MESSAGE()
SET DEFAULT TO "@DIR@"
LOCAL lcRequestFile, lcAnswerFile, lcPartFile, lcRequest, lcOp, lcSession, lcStatement, lcFrame, lcShow, lcKind, lcLabels, llHave, lnLines, lnI
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
          DO fqs_run WITH lcStatement, lcShow, lcKind, lcLabels
        ENDIF
        lcStatement = ""
        * The frame: cursor to show | A (array) or V (value) for a figure command | its labels in hex, comma-separated; "-" for none.
        lcFrame = SUBSTR(laLines[lnI], 4)
        lcShow = GETWORDNUM(lcFrame, 1, "|")
        lcKind = GETWORDNUM(lcFrame, 2, "|")
        lcLabels = GETWORDNUM(lcFrame, 3, "|")
        llHave = .T.
      ELSE
        lcStatement = lcStatement + laLines[lnI] + CHR(13) + CHR(10)
      ENDIF
    ENDFOR
    IF llHave
      DO fqs_run WITH lcStatement, lcShow, lcKind, lcLabels
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

PROCEDURE fqs_run(tcStatement, tcShow, tcKind, tcLabels)
  LOCAL lnArea
  IF !(tcKind == "-")
    DO fqs_calc WITH tcStatement, tcKind, tcLabels
    RETURN
  ENDIF
  lnArea = SELECT()
  * EXECSCRIPT compiles each statement on its own, so one bad statement cannot stop the server.
  =EXECSCRIPT(tcStatement)
  * The result cursor is read once and closed, and the work area goes back to what it was, so a
  * table opened with USE stays current; a cursor the user named stays open and current, as in FoxPro.
  IF !(tcShow == "-")
    DO fqs_dump WITH tcShow, (LOWER(tcShow) == "${RESULT_CURSOR}")
    IF LOWER(tcShow) == "${RESULT_CURSOR}"
      SELECT (lnArea)
    ENDIF
  ENDIF
ENDPROC

* Runs SUM, AVERAGE, CALCULATE (TO ARRAY gaCalc) or COUNT (TO gnCalc) and writes the figures as one row.
PROCEDURE fqs_calc(tcStatement, tcKind, tcLabels)
  LOCAL lnI, lcLine, lnFields, lcCols
  LOCAL ARRAY laF[1]
  RELEASE gaCalc, gnCalc
  PUBLIC gaCalc[1], gnCalc
  gaCalc[1] = .NULL.
  gnCalc = .NULL.
  glFailed = .F.
  =EXECSCRIPT(tcStatement)
  IF glFailed
    RETURN
  ENDIF
  lcCols = IIF(tcLabels == "-", "", STRTRAN(tcLabels, ",", "|"))
  IF EMPTY(lcCols) AND tcKind == "A"
    * No list given: FoxPro summed every numeric field of the table, in field order.
    lnFields = AFIELDS(laF)
    FOR lnI = 1 TO lnFields
      IF INLIST(laF[lnI, 2], "N", "F", "I", "Y", "B")
        lcCols = lcCols + IIF(EMPTY(lcCols), "", "|") + STRCONV(LOWER(laF[lnI, 1]), 15)
      ENDIF
    ENDFOR
  ENDIF
  =FWRITE(gnOut, "#COLS|" + STRCONV(ALIAS(), 15) + "|" + lcCols + CHR(13) + CHR(10))
  lcLine = "#ROW"
  IF tcKind == "V"
    lcLine = lcLine + fqs_cell(gnCalc)
  ELSE
    FOR lnI = 1 TO ALEN(gaCalc)
      lcLine = lcLine + fqs_cell(gaCalc[lnI])
    ENDFOR
  ENDIF
  =FWRITE(gnOut, lcLine + CHR(13) + CHR(10))
ENDPROC

* One typed, delimiter-safe cell (strings as hex of their bytes), with its leading separator.
FUNCTION fqs_cell(luV)
  LOCAL lcT
  lcT = VARTYPE(luV)
  DO CASE
  CASE ISNULL(luV)
    RETURN "|X:"
  CASE lcT = "C"
    RETURN "|C:" + STRCONV(luV, 15)
  CASE lcT = "Y"
    RETURN "|N:" + ALLTRIM(STR(MTON(luV), 30, 8))
  CASE lcT = "N"
    RETURN "|N:" + ALLTRIM(STR(luV, 30, 8))
  CASE lcT = "D"
    RETURN "|D:" + DTOS(luV)
  CASE lcT = "T"
    RETURN "|T:" + TTOC(luV, 1)
  CASE lcT = "L"
    RETURN "|L:" + IIF(luV, "T", "F")
  ENDCASE
  RETURN "|?:" + lcT
ENDFUNC

PROCEDURE fqs_schema
  LOCAL lnTables, lnFiles, lnI, lnJ, lnFields, lcName
  LOCAL ARRAY laTables[1], laFiles[1], laFields[1]
  lnTables = 0
  IF !EMPTY(gcDatabase)
    lnTables = ADBOBJECTS(laTables, "TABLE")
  ENDIF
  * Free tables in the folder are listed too; a container's tables are already in the list.
  lnFiles = ADIR(laFiles, "*.dbf")
  FOR lnI = 1 TO lnFiles
    lcName = JUSTSTEM(laFiles[lnI, 1])
    IF lnTables = 0 OR ASCAN(laTables, lcName, 1, lnTables, 1, 1 + 2 + 4) = 0
      lnTables = lnTables + 1
      DIMENSION laTables[lnTables]
      laTables[lnTables] = lcName
    ENDIF
  ENDFOR
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
PROCEDURE fqs_dump(tcAlias, tlClose)
  LOCAL lnI, lcLine, lnRows
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
      * A General (OLE) field cannot be read as a value; it is reported as binary.
      IF TYPE(tcAlias + "." + FIELD(lnI)) = "G"
        lcLine = lcLine + "|?:G"
        LOOP
      ENDIF
      lcLine = lcLine + fqs_cell(EVALUATE(tcAlias + "." + FIELD(lnI)))
    ENDFOR
    =FWRITE(gnOut, lcLine + CHR(13) + CHR(10))
  ENDSCAN
  IF tlClose
    USE IN (tcAlias)
  ELSE
    GO TOP
  ENDIF
ENDPROC

PROCEDURE fqs_error(tnError, tcMessage)
  glFailed = .T.
  IF gnOut >= 0
    =FWRITE(gnOut, "#ERR|" + TRANSFORM(tnError) + "|" + STRCONV(tcMessage, 15) + CHR(13) + CHR(10))
  ENDIF
ENDPROC
`;

const decodeHex = (hex: string) => new TextDecoder(CODE_PAGE).decode(Buffer.from(hex, 'hex'));
const encodeHex = (text: string) => Buffer.from(text, 'latin1').toString('hex');
/** The frame line before each statement: what to show, the figure kind and its labels; `-` stands for none. */
const frameOf = (s: RunnableStatement) => `${FRAME_PREFIX}${s.shows ?? '-'}|${s.calc ? s.calc.kind[0].toUpperCase() : '-'}|${s.calc?.labels.length ? s.calc.labels.map(encodeHex).join(',') : '-'}`;
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
  /** Result sets that hold the figures of SUM/COUNT/…, with the table they were taken from. */
  figures: { set: number; table: string }[];
}

function parseAnswer(text: string): Answer {
  const answer: Answer = { resultSets: [], errors: [], truncated: false, tables: [], figures: [] };
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const [tag, ...cells] = line.split('|');
    if (tag === '#SET') answer.resultSets.push({ columns: cells.map((c) => c.toLowerCase()), rows: [] });
    else if (tag === '#COLS') {
      // Figures of a SUM/COUNT/…: the table's alias, then the labels as typed, in hex.
      answer.figures.push({ set: answer.resultSets.length, table: decodeHex(cells[0]).toLowerCase() });
      answer.resultSets.push({ columns: cells.slice(1).filter(Boolean).map(decodeHex), rows: [] });
    }
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

export interface FoxEngine extends DbBackend {
  /** Opens a database container (.dbc), or the folder of a free table (.dbf), for querying. */
  openDatabase(path: string): Promise<void>;
  /** Folder or container currently open. */
  readonly path: string | undefined;
}

/** One FoxPro process: its own work folder and its own queue of requests. */
interface Worker {
  child: ChildProcess | undefined;
  workDir: string;
  queue: Promise<unknown>;
}

/**
 * The engine runs one FoxPro process per query tab (session), so a long query in one tab
 * never holds up another: FoxPro is single-threaded, so independence means separate processes.
 * Each process costs about 20 MB and starts in under a second.
 */
export function createFoxEngine(locateVfp: () => string | undefined = findVfp): FoxEngine {
  let openedPath: string | undefined;
  let exe: string | undefined;
  let program: string | undefined;
  const workers = new Map<string, Worker>();

  async function waitFor(worker: Worker, name: string, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(join(worker.workDir, name))) {
      if (!worker.child) throw new Error(`FoxPro đã dừng khi ${what}.`);
      if (Date.now() > deadline) throw new Error(`FoxPro không trả lời khi ${what}.`);
      await delay(POLL_MS);
    }
  }

  function stop(sessionId: string, worker: Worker): void {
    if (workers.get(sessionId) === worker) workers.delete(sessionId);
    worker.child?.kill();
    worker.child = undefined;
    // FoxPro may still hold its folder for a moment; a leftover temp folder is harmless.
    try {
      rmSync(worker.workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Left for the system to clean up.
    }
  }

  function request(worker: Worker, sessionId: string, head: string, body: string[] = []): Promise<Answer> {
    const file = (name: string) => join(worker.workDir, name);
    const task = worker.queue.then(async () => {
      if (!worker.child) throw new Error('Chưa mở CSDL FoxPro.');
      rmSync(file('answer.txt'), { force: true });
      writeFileSync(file('request.part'), Buffer.from([head, ...body].join(CRLF) + CRLF, 'latin1'));
      renameSync(file('request.part'), file('request.txt'));
      try {
        await waitFor(worker, 'answer.txt', REQUEST_TIMEOUT_MS, 'chạy lệnh');
      } catch (e) {
        // A query that never returns holds this tab's process; only that process is given up on.
        stop(sessionId, worker);
        throw e;
      }
      return parseAnswer(readFileSync(file('answer.txt'), 'latin1'));
    });
    worker.queue = task.catch(() => undefined);
    return task;
  }

  /** Starts a FoxPro process for the session, or returns the one it already has. */
  async function workerFor(sessionId: string): Promise<Worker> {
    const existing = workers.get(sessionId);
    if (existing?.child) return existing;
    if (!exe || !program) throw new Error('Chưa mở CSDL FoxPro.');
    const workDir = mkdtempSync(join(tmpdir(), 'fqs-fox-'));
    const worker: Worker = { child: undefined, workDir, queue: Promise.resolve() };
    writeFileSync(join(workDir, 'server.prg'), Buffer.from(program.replaceAll('@WORK@', workDir).replace(/\r?\n/g, CRLF), 'latin1'));
    // CODEPAGE pins the session to Windows-1252 whatever the system locale is.
    writeFileSync(join(workDir, 'server.fpw'), `SCREEN=OFF${CRLF}RESOURCE=OFF${CRLF}CODEPAGE=1252${CRLF}COMMAND=DO "${join(workDir, 'server.prg')}"${CRLF}`, 'latin1');
    const started = spawn(exe, ['-T', `-C${join(workDir, 'server.fpw')}`], { cwd: workDir, stdio: 'ignore', windowsHide: true });
    worker.child = started;
    const gone = () => {
      if (worker.child === started) worker.child = undefined;
    };
    started.on('exit', gone);
    started.on('error', gone);
    workers.set(sessionId, worker);
    try {
      await waitFor(worker, 'ready.txt', STARTUP_TIMEOUT_MS, 'khởi động');
    } catch (e) {
      stop(sessionId, worker);
      throw e;
    }
    return worker;
  }

  /** Lets a FoxPro process close its tables and leave by itself, then clears up. */
  async function shutdown(sessionId: string): Promise<void> {
    const worker = workers.get(sessionId);
    const child = worker?.child;
    if (!worker || !child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await request(worker, sessionId, 'QUIT||0').catch(() => undefined);
    await Promise.race([exited, delay(EXIT_TIMEOUT_MS)]);
    stop(sessionId, worker);
  }

  return {
    get path() {
      return openedPath;
    },

    async openDatabase(path) {
      const found = locateVfp();
      if (!found) throw new Error('Không tìm thấy Visual FoxPro 9 trên máy này (vfp9.exe). Đặt biến môi trường FQS_VFP_EXE trỏ tới nó.');
      const isContainer = path.toLowerCase().endsWith('.dbc');
      const directory = statSync(path).isDirectory() ? path : dirname(path);
      if (!fitsCodePage(path)) throw new Error('Đường dẫn có ký tự ngoài bảng mã Windows-1252; hãy chuyển CSDL sang thư mục có tên không dấu.');
      await Promise.all([...workers.keys()].map(shutdown));
      exe = found;
      program = SERVER_PROGRAM.replaceAll('@DIR@', directory).replaceAll('@DBC@', isContainer ? path : '');
      // The first process proves FoxPro starts and the database opens; it then serves the object list.
      await workerFor(SCHEMA_SESSION);
      openedPath = path;
    },

    async disconnect() {
      await Promise.all([...workers.keys()].map(shutdown));
      openedPath = undefined;
    },

    closeSession: shutdown,

    async listDatabases() {
      const path = openedPath ?? '';
      return [path.split(/[\\/]/).filter(Boolean).pop() ?? path];
    },

    async loadSchema() {
      const worker = await workerFor(SCHEMA_SESSION);
      const answer = await request(worker, SCHEMA_SESSION, `SCHEMA|${SCHEMA_SESSION}|0`);
      await shutdown(SCHEMA_SESSION);
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
      // The request is framed by lines starting with "#S|"; such a line inside a statement would
      // be read by FoxPro as a new, unchecked statement.
      if (statements.some((s) => s.statement.split('\n').some((line) => line.startsWith(FRAME_PREFIX)))) return failed(`Dòng bắt đầu bằng ${FRAME_PREFIX} không được phép trong truy vấn.`);

      let answer: Answer;
      try {
        const worker = await workerFor(sessionId);
        answer = await request(worker, sessionId, `EXEC|${sessionId}|${maxRows}`, statements.flatMap((s) => [frameOf(s), ...s.statement.split('\n')]));
      } catch (e) {
        return failed((e as Error).message, true);
      }
      // A check of the form `SUM stored - formula` that is not 0 gets the query that lists the rows at fault.
      const calcs = statements.map((s) => s.calc).filter((c): c is NonNullable<typeof c> => !!c);
      const messages = answer.figures.flatMap(({ set, table }, k) => {
        const { columns, rows } = answer.resultSets[set];
        return columns.map((label, i) => mismatchHint(label, rows[0]?.[i], table, calcs[k]?.condition)).filter((hint): hint is string => !!hint);
      });
      return {
        resultSets: answer.resultSets,
        messages,
        error: answer.errors.length ? answer.errors.join('\n') : undefined,
        truncated: answer.truncated,
        elapsedMs: Date.now() - started,
      };
    },
  };
}
