/** Cursor that receives the rows of a SELECT with no INTO clause, so they can be read back. */
export const RESULT_CURSOR = 'fqs_r';

export interface RunnableStatement {
  statement: string;
  /** The cursor whose rows the statement shows, when it produces one: a cursor it names, or RESULT_CURSOR. */
  shows?: string;
  /** For SUM, AVERAGE, CALCULATE and COUNT: how the figures are read back. */
  calc?: Calc;
}

export interface Calc {
  /** `array` when the command fills gaCalc (TO ARRAY); `value` when it sets gnCalc (COUNT). */
  kind: 'array' | 'value';
  /** Column labels, as typed; empty for SUM/AVERAGE without a list, where the server names the numeric fields. */
  labels: string[];
  /** The FOR condition, as typed, when there is one. */
  condition?: string;
}

/** Name of the one-row figure that COUNT yields. */
export const COUNT_LABEL = 'count';
/** Words that end the expression list of SUM/AVERAGE/CALCULATE. */
const CLAUSE_WORDS = /^(FOR|WHILE|ALL|NEXT|RECORD|REST|TO|NOOPTIMIZE)$/i;

/**
 * Walks `text` outside strings and parentheses, calling `visit` with the index of every
 * top-level character; a visit returning true stops the walk at that index.
 */
function scanTopLevel(text: string, visit: (index: number) => boolean | void): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') quote = ']';
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && visit(i)) return i;
  }
  return -1;
}

/** Splits an expression list on the commas that are not inside parentheses or strings. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scanTopLevel(text, (i) => {
    if (text[i] === ',') {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Index of the first clause word (FOR, WHILE, a scope, TO) outside parentheses and strings, or -1. */
function clauseStart(text: string): number {
  return scanTopLevel(text, (i) => {
    if (i > 0 && !/\s/.test(text[i - 1])) return false;
    const word = /^\w+/.exec(text.slice(i))?.[0];
    return !!word && CLAUSE_WORDS.test(word);
  });
}

/**
 * SUM, AVERAGE, CALCULATE and COUNT run as FoxPro commands on the current table; the user's
 * own TO target is dropped and the figures go to the server's variable instead.
 */
function toCalc(command: string, rest: string): RunnableStatement {
  const body = rest.replace(/\s+NOOPTIMIZE\b/gi, '').replace(/\s+TO\s+(ARRAY\s+)?\w+(\s*,\s*\w+)*\s*$/i, '').trim();
  const condition = forCondition(body);
  if (command === 'COUNT') return { statement: `COUNT ${body} TO gnCalc`.replace(/\s{2,}/g, ' '), calc: { kind: 'value', labels: [COUNT_LABEL], condition } };
  const at = clauseStart(body);
  const labels = splitTopLevel(at < 0 ? body : body.slice(0, at));
  return { statement: `${command} ${body} TO ARRAY gaCalc`.replace(/\s{2,}/g, ' '), calc: { kind: 'array', labels, condition } };
}

/** The expression after FOR, up to the next clause word, or undefined when there is no FOR. */
function forCondition(body: string): string | undefined {
  const at = scanTopLevel(body, (i) => (i === 0 || /\s/.test(body[i - 1])) && /^FOR\s/i.test(body.slice(i)));
  if (at < 0) return undefined;
  const rest = body.slice(at + 3).trim();
  const end = scanTopLevel(rest, (i) => i > 0 && /\s/.test(rest[i - 1]) && /^(WHILE|NEXT|RECORD|REST|ALL|TO|NOOPTIMIZE)\b/i.test(rest.slice(i)));
  return (end < 0 ? rest : rest.slice(0, end)).trim() || undefined;
}

/** Joins continuation lines and drops comments, returning one string per statement. */
export function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let pending: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    if (!pending.length && rawLine.trimStart().startsWith('*')) continue;
    const line = rawLine.replace(/&&.*$/, '').trimEnd();
    if (!line.trim()) continue;
    pending.push(line);
    if (!line.endsWith(';')) {
      statements.push(pending.join('\n'));
      pending = [];
    }
  }
  if (pending.length) statements.push(pending.join('\n'));
  return statements;
}

/**
 * Turns the statements into ones that leave their rows in a cursor instead of
 * opening a Browse window, and tells which statements produce a result set.
 */
export function toRunnable(source: string): RunnableStatement[] {
  return splitStatements(source).map((statement) => {
    const browse = /^\s*BROWSE\b(.*)$/is.exec(statement);
    if (browse) {
      const fields = /\bFIELDS\b(.*?)(?=\bFOR\b|$)/is.exec(browse[1])?.[1].trim() || '*';
      const condition = /\bFOR\b(.*)$/is.exec(browse[1])?.[1].trim();
      const where = condition ? ` WHERE ${condition}` : '';
      // BROWSE reads the table of the current work area, whatever USE or SELECT alias made it.
      return { statement: `SELECT ${fields} FROM (ALIAS())${where} INTO CURSOR ${RESULT_CURSOR}`, shows: RESULT_CURSOR };
    }
    const use = /^\s*USE\b(.*)$/is.exec(statement);
    if (use) {
      const rest = use[1].trim();
      // A table is only ever opened shared and read-only, in a free work area (SELECT 0) so the
      // cursor that was current is not closed in its place; USE on its own closes the current one.
      return { statement: rest ? `SELECT 0\nUSE ${rest}${/\bNOUPDATE\b/i.test(rest) ? '' : ' SHARED NOUPDATE'}` : 'USE' };
    }
    const calc = /^\s*(SUM|AVERAGE|CALCULATE|COUNT)\b(.*)$/is.exec(statement);
    if (calc) return toCalc(calc[1].toUpperCase(), calc[2]);
    const workArea = /^\s*SELECT\s+(\w+)\s*$/i.exec(statement);
    if (workArea) return { statement };
    // A named cursor stays for later statements; its rows are shown too, as the user expects to see them.
    const into = /\bINTO\s+CURSOR\s+(\w+)/i.exec(statement);
    if (into) return { statement, shows: into[1] };
    return { statement: `${statement} INTO CURSOR ${RESULT_CURSOR}`, shows: RESULT_CURSOR };
  });
}

/**
 * Why a statement may not run in the read-only tool, or undefined when it may.
 * Only queries are let through: nothing that changes a table or writes a file.
 */
/**
 * Functions FoxPro would run while evaluating a SELECT that change data, write files, run
 * code or reach outside the database; a query has no need for them.
 */
const SIDE_EFFECT_FUNCTIONS =
  /\b(EXECSCRIPT|EVALUATE|STRTOFILE|FCREATE|FOPEN|FWRITE|FPUTS|FCHSIZE|FFLUSH|FCLOSE|CREATEOBJECT|CREATEOBJECTEX|NEWOBJECT|GETOBJECT|SYS|TABLEUPDATE|TABLEREVERT|CURSORSETPROP|DBSETPROP|SETFLDSTATE|REQUERY|TEXTMERGE|ADDPROPERTY|COMPOBJ|GETINTERFACE|INDEXSEEK)\s*\(/i;
/** Macro substitution would let text become any command. */
const MACRO = /(^|[^&])&[A-Za-z_]/;

export function readOnlyViolation(statement: string): string | undefined {
  if (!/^\s*(SELECT|BROWSE|USE|SUM|COUNT|AVERAGE|CALCULATE)\b/i.test(statement)) {
    return 'Chỉ chạy được SELECT, BROWSE, USE, SUM, COUNT, AVERAGE và CALCULATE; công cụ này chỉ đọc dữ liệu.';
  }
  if (/(^|\n)\s*USE\b.*\bEXCLUSIVE\b/i.test(statement)) return 'USE … EXCLUSIVE khóa bảng với người khác; công cụ này chỉ mở bảng SHARED NOUPDATE.';
  const sideEffect = SIDE_EFFECT_FUNCTIONS.exec(statement);
  if (sideEffect) return `Hàm ${sideEffect[1].toUpperCase()}() có thể ghi dữ liệu hoặc chạy mã nên không được dùng trong truy vấn.`;
  if (MACRO.test(statement)) return 'Không dùng macro (&) trong truy vấn.';
  if (/\bINTO\s+(TABLE|DBF|ARRAY)\b/i.test(statement) || /\bTO\s+(FILE|PRINTER)\b/i.test(statement)) return 'Chỉ hỗ trợ INTO CURSOR; không ghi kết quả ra bảng, mảng hay tệp.';
  return undefined;
}

/** Figures below this are rounding, not a wrong formula. */
const MISMATCH_TOLERANCE = 0.005;

/**
 * The next step after a check like `SUM TP - LC*HSDC*…` comes back other than 0: the
 * rows where the stored amount and the formula disagree. Undefined when the figure is
 * not such a difference, or is 0.
 */
export function mismatchHint(label: string, value: unknown, table: string, condition?: string): string | undefined {
  if (typeof value !== 'number' || Math.abs(value) < MISMATCH_TOLERANCE || !table) return undefined;
  if (!/^\w+\s*-\s*\S/.test(label) || clauseStart(label) >= 0) return undefined;
  const where = `${condition ? `(${condition}) AND ` : ''}ABS(${label}) > ${MISMATCH_TOLERANCE}`;
  return `${label} = ${value}, khác 0 nên có dòng tính sai. Liệt kê các dòng lệch: SELECT *, ${label} AS lech FROM ${table} WHERE ${where}`;
}
