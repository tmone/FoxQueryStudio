import type { ColumnKind } from '../functions';
import type { ColumnContext, ColumnKindResolver, TableRef } from '../schema';
import { ConvertError, type Token } from '../tokenizer';
import { splitTsqlStatements, tokenizeTsql } from './tsql-tokenizer';

/**
 * T-SQL to FoxPro, for developers who write T-SQL and need the FoxPro form for a demo.
 * FoxPro differs from SQL Server in ways the output must compensate for:
 *   - `=`, `<>`, `IN` and `LIKE` compare up to the shorter string and are case-sensitive;
 *   - integer division does not truncate, `%` takes the sign of the divisor;
 *   - LEN counts trailing blanks; dates are a distinct type with their own literals.
 * Constructs FoxPro has no equivalent for (CTE, window functions, APPLY, PIVOT, variables)
 * are reported as errors rather than approximated.
 */
export interface ReverseOptions {
  resolveColumnKind?: ColumnKindResolver;
  /** Declared width of a character column; lets literals be padded so FoxPro sizes result columns correctly. */
  resolveColumnWidth?: (column: string, context: ColumnContext) => number | undefined;
  /** SQL Server compares text without regard to case by default; FoxPro never does. */
  caseInsensitive?: boolean;
}

export interface Diagnostic {
  line: number;
  message: string;
}

export interface ReverseResult {
  /** All statements, one per line; empty when there are errors. */
  foxpro: string;
  statements: { line: number; foxpro: string }[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Cursors (#temp tables) the statements create, lower-cased. */
  cursors: string[];
}

interface Unit {
  text: string;
  kind?: ColumnKind;
  /** True for a plain column reference. */
  column?: boolean;
  /** True for a string literal. */
  literal?: boolean;
  /** Width of a character column or literal, when known. */
  width?: number;
}

interface State {
  line: number;
  caseInsensitive: boolean;
  resolveColumnKind?: ColumnKindResolver;
  resolveColumnWidth?: ReverseOptions['resolveColumnWidth'];
  tables: TableRef[];
  cursors: Set<string>;
  warn(message: string): void;
}

const UNSUPPORTED_LEADS: Record<string, string> = {
  WITH: 'CTE (WITH) không có trong FoxPro; hãy viết thành truy vấn con hoặc INTO CURSOR trước.',
  DECLARE: 'Biến T-SQL (DECLARE/@biến) không có trong FoxPro SQL.',
  SET: 'Lệnh SET của T-SQL không chuyển được.',
  EXEC: 'Gọi stored procedure không chuyển được sang FoxPro.',
  EXECUTE: 'Gọi stored procedure không chuyển được sang FoxPro.',
  INSERT: 'Công cụ chỉ chuyển SELECT.',
  UPDATE: 'Công cụ chỉ chuyển SELECT.',
  DELETE: 'Công cụ chỉ chuyển SELECT.',
  MERGE: 'Công cụ chỉ chuyển SELECT.',
  CREATE: 'Công cụ chỉ chuyển SELECT.',
  ALTER: 'Công cụ chỉ chuyển SELECT.',
};
const UNSUPPORTED_WORDS: Record<string, string> = {
  OVER: 'Hàm cửa sổ (OVER) không có trong FoxPro.',
  APPLY: 'CROSS/OUTER APPLY không có trong FoxPro.',
  PIVOT: 'PIVOT không có trong FoxPro.',
  UNPIVOT: 'UNPIVOT không có trong FoxPro.',
  OFFSET: 'OFFSET/FETCH không có trong FoxPro; dùng TOP.',
  CROSS: 'CROSS JOIN không có trong FoxPro; liệt kê hai bảng sau FROM, cách nhau dấu phẩy.',
  COLLATE: 'COLLATE không có trong FoxPro.',
};
const UNSUPPORTED_FUNCTIONS: Record<string, string> = {
  FORMAT: 'FORMAT() không có trong FoxPro; dùng TRANSFORM() hoặc STR().',
  STRING_AGG: 'STRING_AGG() không có trong FoxPro.',
  DATENAME: 'DATENAME() không có trong FoxPro; dùng CMONTH()/CDOW() ngoài SQL.',
  NEWID: 'NEWID() không có trong FoxPro.',
  ROW_NUMBER: 'ROW_NUMBER() không có trong FoxPro.',
  RANK: 'RANK() không có trong FoxPro.',
  DENSE_RANK: 'DENSE_RANK() không có trong FoxPro.',
  DATALENGTH: 'DATALENGTH() không có trong FoxPro.',
  IIF: '',
};
delete UNSUPPORTED_FUNCTIONS.IIF;

const COMPARISONS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '!<', '!>']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const OPERATOR_FOX: Record<string, string> = { '!=': '<>', '!<': '>=', '!>': '<=' };
const KEYWORDS_BEFORE_PAREN = new Set(['AND', 'OR', 'NOT', 'IN', 'ON', 'WHERE', 'HAVING', 'FROM', 'JOIN', 'EXISTS', 'SELECT', 'BY', 'AS', 'WHEN', 'THEN', 'ELSE', 'UNION', 'ALL', 'ANY', 'SOME', 'LIKE', 'DISTINCT', 'TOP']);
const NOT_AN_ALIAS = new Set(['WHERE', 'ON', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'JOIN', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'INTO', 'AS']);
const STRING_FUNCTIONS = new Set(['UPPER', 'LOWER', 'LTRIM', 'RTRIM', 'ALLTRIM', 'LEFT', 'RIGHT', 'SUBSTR', 'STRTRAN', 'TRANSFORM', 'STR', 'DTOC', 'DTOS', 'CHR', 'REPLICATE', 'SPACE', 'STUFF', 'PADL', 'PADR']);
const DATE_FUNCTIONS = new Set(['DATE', 'TTOD', 'GOMONTH', 'CTOD']);
const DATETIME_FUNCTIONS = new Set(['DATETIME', 'DTOT']);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const DEFAULT_SCHEMA = 'dbo';

const isWord = (t: Token | undefined, word: string) => t?.kind === 'ident' && t.text.toUpperCase() === word;
const isPunct = (t: Token | undefined, text: string) => t?.kind === 'punct' && t.text === text;
const isDateKind = (kind: ColumnKind | undefined) => kind === 'date' || kind === 'datetime';
const isTextKind = (kind: ColumnKind | undefined) => kind === 'string' || kind === 'varstring';

function matchingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')') && --depth === 0) return i;
  }
  throw new ConvertError('Thiếu dấu ) đóng ngoặc.', tokens[open].line);
}

function splitList(tokens: Token[]): Token[][] {
  if (!tokens.length) return [];
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    if (depth === 0 && isPunct(t, ',')) parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts;
}

function findTopLevel(tokens: Token[], predicate: (t: Token, i: number) => boolean, from = 0): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) depth--;
    else if (depth === 0 && i >= from && predicate(tokens[i], i)) return i;
  }
  return -1;
}

function joinUnits(units: Unit[]): string {
  let text = '';
  for (const u of units) {
    const tight = !text || u.text === ',' || text.endsWith('(') && false;
    text += (tight ? '' : ' ') + u.text;
  }
  return text;
}

/** FoxPro string literal: double quotes unless the text has them, then single, else error. */
function foxString(value: string, line: number): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('[') && !value.includes(']')) return `[${value}]`;
  throw new ConvertError('Chuỗi chứa cả ba loại dấu nháy, FoxPro không biểu diễn được.', line);
}

/** A string that is really a date: `'2026-01-31'`, `'20260131'`, `'2026-01-31 10:00:00'`. */
function dateFromString(value: string): Unit | undefined {
  const compact = COMPACT_DATE.exec(value);
  if (compact) return { text: `{^${compact[1]}-${compact[2]}-${compact[3]}}`, kind: 'date' };
  const iso = ISO_DATE.exec(value);
  if (!iso) return undefined;
  if (iso[4] === undefined) return { text: `{^${iso[1]}-${iso[2]}-${iso[3]}}`, kind: 'date' };
  return { text: `{^${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}:${iso[6] ?? '00'}}`, kind: 'datetime' };
}

/** Table name as FoxPro sees it: no `dbo.`, `#temp` as a cursor, brackets removed. */
function foxName(name: string, state: State, line: number): string {
  const parts = name.split('.').map((p) => p.replace(/^\[(.*)\]$/, '$1'));
  if (parts.length > 1 && parts[0].toLowerCase() === DEFAULT_SCHEMA) parts.shift();
  if (parts.length > 1 && parts.length === 2 && !/^[A-Za-z_#]/.test(parts[1]) === false && parts[0].startsWith('#')) parts[0] = parts[0].slice(1);
  return parts
    .map((p, i) => {
      if (p.startsWith('#')) {
        state.cursors.add(p.slice(1).toLowerCase());
        return p.slice(1);
      }
      if (p === '*') return p;
      if (!/^[A-Za-z_À-￿][\wÀ-￿]*$/.test(p)) {
        throw new ConvertError(`Tên "${p}" có ký tự FoxPro không chấp nhận (khoảng trắng, dấu).`, line);
      }
      if (i === 0 && parts.length > 1 && /^[A-Za-z_]\w*$/.test(p) && state.cursors.has(p.toLowerCase())) return p;
      return p;
    })
    .join('.');
}

function collectTables(tokens: Token[]): TableRef[] {
  const tables: TableRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], 'FROM') && !isWord(tokens[i], 'JOIN')) continue;
    for (let at = i + 1; tokens[at]?.kind === 'ident' && !tokens[at].text.startsWith('#') || tokens[at]?.kind === 'ident'; ) {
      const ref: TableRef = { name: tokens[at].text.replace(/^dbo\./i, '').replace(/^#/, '') };
      at++;
      if (isWord(tokens[at], 'AS')) at++;
      if (tokens[at]?.kind === 'ident' && !NOT_AN_ALIAS.has(tokens[at].text.toUpperCase())) ref.alias = tokens[at++].text;
      tables.push(ref);
      if (!isPunct(tokens[at], ',')) break;
      at++;
    }
  }
  return tables;
}

// ---------- Functions ----------

type Handler = (args: Unit[], ctx: State, rawArgs: Token[][]) => Unit;

const text = (t: string, kind?: ColumnKind): Unit => ({ text: t, kind });
const num = (t: string): Unit => ({ text: t, kind: 'number' });
const needs = (name: string, args: Unit[], min: number, max: number, line: number) => {
  if (args.length < min || args.length > max) throw new ConvertError(`${name}() cần ${min === max ? min : `${min}-${max}`} tham số.`, line);
};

const DATEPART_FOX: Record<string, string> = { YEAR: 'YEAR', YY: 'YEAR', YYYY: 'YEAR', QUARTER: 'QUARTER', QQ: 'QUARTER', Q: 'QUARTER', MONTH: 'MONTH', MM: 'MONTH', M: 'MONTH', DAY: 'DAY', DD: 'DAY', D: 'DAY', HOUR: 'HOUR', HH: 'HOUR', MINUTE: 'MINUTE', MI: 'MINUTE', N: 'MINUTE', SECOND: 'SEC', SS: 'SEC', S: 'SEC', WEEKDAY: 'DOW', DW: 'DOW' };
const SECONDS: Record<string, number> = { HOUR: 3600, HH: 3600, MINUTE: 60, MI: 60, N: 60, SECOND: 1, SS: 1, S: 1 };
const DAYS: Record<string, number> = { DAY: 1, DD: 1, D: 1, WEEK: 7, WK: 7, WW: 7 };
const MONTHS: Record<string, number> = { MONTH: 1, MM: 1, M: 1, QUARTER: 3, QQ: 3, Q: 3, YEAR: 12, YY: 12, YYYY: 12 };

function dateAdd([part, n, d]: Unit[], ctx: State): Unit {
  const p = part.text.toUpperCase();
  const amount = /^-?[\d.]+$/.test(n.text) ? n.text : `(${n.text})`;
  if (p in DAYS) return { text: `${d.text} + ${DAYS[p] === 1 ? amount : `${DAYS[p]} * ${amount}`}`, kind: d.kind ?? 'date' };
  if (p in MONTHS) return { text: `GOMONTH(${d.text}, ${MONTHS[p] === 1 ? amount : `${MONTHS[p]} * ${amount}`})`, kind: 'date' };
  if (p in SECONDS) {
    if (d.kind === 'date') ctx.warn('DATEADD theo giờ/phút/giây trên cột ngày: FoxPro cần kiểu datetime, đã chuyển bằng DTOT().');
    const base = d.kind === 'date' ? `DTOT(${d.text})` : d.text;
    return { text: `${base} + ${SECONDS[p] === 1 ? amount : `${SECONDS[p]} * ${amount}`}`, kind: 'datetime' };
  }
  throw new ConvertError(`DATEADD với đơn vị ${part.text} không chuyển được.`, ctx.line);
}

function dateDiff([part, a, b]: Unit[], ctx: State): Unit {
  const p = part.text.toUpperCase();
  if (p in DAYS) {
    const toDate = (u: Unit) => (u.kind === 'datetime' ? `TTOD(${u.text})` : u.text);
    const diff = `(${toDate(b)} - ${toDate(a)})`;
    return num(DAYS[p] === 1 ? diff : `INT(${diff} / ${DAYS[p]})`);
  }
  if (p in MONTHS) {
    const months = `((YEAR(${b.text}) - YEAR(${a.text})) * 12 + MONTH(${b.text}) - MONTH(${a.text}))`;
    return num(MONTHS[p] === 1 ? months : `INT(${months} / ${MONTHS[p]})`);
  }
  if (p in SECONDS) {
    const toTime = (u: Unit) => (u.kind === 'date' ? `DTOT(${u.text})` : u.text);
    return num(`INT((${toTime(b)} - ${toTime(a)}) / ${SECONDS[p]})`);
  }
  throw new ConvertError(`DATEDIFF với đơn vị ${part.text} không chuyển được.`, ctx.line);
}

/** CAST(x AS type) and CONVERT(type, x[, style]). */
function castTo(type: string, x: Unit, style: string | undefined, ctx: State): Unit {
  const t = type.toLowerCase().replace(/\s+/g, '');
  const decimals = /^(decimal|numeric)\(\d+,(\d+)\)$/.exec(t)?.[2];
  if (decimals) return num(`ROUND(${x.text}, ${decimals})`);
  if (/^(int|bigint|smallint|tinyint)$/.test(t)) return num(`INT(${x.text})`);
  if (/^(decimal|numeric|money|smallmoney|float|real)/.test(t)) return num(x.text);
  if (/^(n?var)?char/.test(t)) {
    if (!style) {
      if (isDateKind(x.kind)) ctx.warn('CAST ngày sang chuỗi: FoxPro trả theo SET DATE (dd/mm/yyyy), SQL Server theo ngôn ngữ của phiên.');
      return text(`TRANSFORM(${x.text})`, 'string');
    }
    switch (style) {
      case '103': return text(`DTOC(${x.text})`, 'string');
      case '112': return text(`DTOS(${x.text})`, 'string');
      case '23': return text(`LEFT(DTOS(${x.text}), 4) + "-" + SUBSTR(DTOS(${x.text}), 5, 2) + "-" + RIGHT(DTOS(${x.text}), 2)`, 'string');
      case '101': ctx.warn('CONVERT kiểu 101 (mm/dd/yyyy): FoxPro cần SET DATE MDY.'); return text(`DTOC(${x.text})`, 'string');
      default: throw new ConvertError(`CONVERT kiểu ${style} không chuyển được.`, ctx.line);
    }
  }
  if (t === 'date') return text(isDateKind(x.kind) || x.kind === undefined ? `TTOD(${x.text})` : `CTOD(${x.text})`, 'date');
  if (/^(datetime|datetime2|smalldatetime)/.test(t)) return text(`DTOT(${x.text})`, 'datetime');
  if (t === 'bit') return text(`(${x.text} <> 0)`, 'bool');
  throw new ConvertError(`CAST sang ${type} không chuyển được.`, ctx.line);
}

/** `CASE WHEN ... THEN ... [ELSE ...] END` and `CASE x WHEN a THEN ...` → ICASE(). */
function caseExpression(tokens: Token[], state: State): { unit: Unit; next: number } {
  let depth = 0;
  let end = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (isWord(tokens[i], 'CASE')) depth++;
    else if (isWord(tokens[i], 'END')) {
      if (depth === 0) { end = i; break; }
      depth--;
    }
  }
  if (end < 0) throw new ConvertError('CASE thiếu END.', tokens[0].line);
  const body = tokens.slice(1, end);
  const parts: { word: string; tokens: Token[] }[] = [];
  let current: { word: string; tokens: Token[] } = { word: 'SUBJECT', tokens: [] };
  let nested = 0;
  for (const t of body) {
    if (isWord(t, 'CASE')) nested++;
    else if (isWord(t, 'END')) nested--;
    if (nested === 0 && (isWord(t, 'WHEN') || isWord(t, 'THEN') || isWord(t, 'ELSE'))) {
      parts.push(current);
      current = { word: t.text.toUpperCase(), tokens: [] };
    } else current.tokens.push(t);
  }
  parts.push(current);
  const subject = parts[0].tokens.length ? asOperand(rewrite(parts[0].tokens, state)) : undefined;
  const conditions: string[] = [];
  const results: Unit[] = [];
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const units = rewrite(part.tokens, state);
    if (part.word === 'WHEN') {
      const value = asOperand(units);
      conditions.push(!subject ? value.text : isTextual(subject) || isTextual(value) ? textComparison(subject, '=', value, state) : `${subject.text} == ${value.text}`);
    } else results.push(asOperand(units));
  }
  const padded = padBranches(results);
  // WHEN/THEN pairs, then the ELSE value if there is one.
  const args = conditions.flatMap((c, i) => [c, padded[i].text]).concat(padded.length > conditions.length ? [padded[padded.length - 1].text] : []);
  return { unit: { text: `ICASE(${args.join(', ')})`, kind: results[0]?.kind, width: widthOf(padded) }, next: end + 1 };
}

/**
 * FoxPro sizes a result column from the first row it evaluates, so a short literal in
 * the first row truncates every later value. Padding the literals to the widest branch
 * keeps the column wide enough; trailing blanks are what FoxPro shows anyway.
 */
function padBranches(branches: Unit[]): Unit[] {
  const widest = Math.max(...branches.map((u) => u.width ?? 0));
  const unknownText = branches.some((u) => !u.literal && u.width === undefined && isTextKind(u.kind));
  if (!widest || unknownText || !branches.some((u) => u.literal)) return branches;
  return branches.map((u) => (u.literal && u.width !== undefined && u.width < widest ? { ...u, text: `PADR(${u.text}, ${widest})`, width: widest } : u));
}
const textBranches = (units: Unit[]) => units.some((u) => u.literal || isTextKind(u.kind));
const widthOf = (units: Unit[]) => (textBranches(units) ? Math.max(0, ...units.map((u) => u.width ?? 0)) || undefined : undefined);

const HANDLERS: Record<string, Handler> = {
  ISNULL: (a, ctx) => { needs('ISNULL', a, 2, 2, ctx.line); const b = padBranches(a); return { text: `NVL(${b[0].text}, ${b[1].text})`, kind: a[0].kind ?? a[1].kind, width: widthOf(b) }; },
  COALESCE: (a, ctx) => { needs('COALESCE', a, 2, 99, ctx.line); const b = padBranches(a); return { text: b.slice(0, -1).reduceRight((acc, u) => `NVL(${u.text}, ${acc})`, b[b.length - 1].text), kind: a[0].kind, width: widthOf(b) }; },
  NULLIF: (a, ctx) => { needs('NULLIF', a, 2, 2, ctx.line); return { text: `IIF(${a[0].text} == ${a[1].text}, .NULL., ${a[0].text})`, kind: a[0].kind }; },
  LEN: (a, ctx) => { needs('LEN', a, 1, 1, ctx.line); return num(`LEN(RTRIM(${a[0].text}))`); },
  LENGTH: (a, ctx) => { needs('LENGTH', a, 1, 1, ctx.line); return num(`LEN(RTRIM(${a[0].text}))`); },
  LTRIM: (a) => text(`LTRIM(${a[0].text})`, 'string'),
  RTRIM: (a) => text(`RTRIM(${a[0].text})`, 'string'),
  TRIM: (a) => text(`ALLTRIM(${a[0].text})`, 'string'),
  UPPER: (a) => text(`UPPER(${a[0].text})`, 'string'),
  UCASE: (a) => text(`UPPER(${a[0].text})`, 'string'),
  LOWER: (a) => text(`LOWER(${a[0].text})`, 'string'),
  LCASE: (a) => text(`LOWER(${a[0].text})`, 'string'),
  LEFT: (a) => text(`LEFT(${a[0].text}, ${a[1].text})`, 'string'),
  RIGHT: (a) => text(`RIGHT(${a[0].text}, ${a[1].text})`, 'string'),
  SUBSTRING: (a, ctx) => { needs('SUBSTRING', a, 3, 3, ctx.line); return text(`SUBSTR(${a[0].text}, ${a[1].text}, ${a[2].text})`, 'string'); },
  CHARINDEX: (a, ctx) => { needs('CHARINDEX', a, 2, 2, ctx.line); return num(ctx.caseInsensitive ? `ATC(${a[0].text}, ${a[1].text})` : `AT(${a[0].text}, ${a[1].text})`); },
  LOCATE: (a, ctx) => { needs('LOCATE', a, 2, 2, ctx.line); return num(ctx.caseInsensitive ? `ATC(${a[0].text}, ${a[1].text})` : `AT(${a[0].text}, ${a[1].text})`); },
  REPLACE: (a, ctx) => { needs('REPLACE', a, 3, 3, ctx.line); if (ctx.caseInsensitive) ctx.warn('REPLACE: SQL Server thay không phân biệt hoa thường, STRTRAN của FoxPro thì có.'); return text(`STRTRAN(${a[0].text}, ${a[1].text}, ${a[2].text})`, 'string'); },
  REPLICATE: (a) => text(`REPLICATE(${a[0].text}, ${a[1].text})`, 'string'),
  SPACE: (a) => text(`SPACE(${a[0].text})`, 'string'),
  STUFF: (a) => text(`STUFF(${a.map((u) => u.text).join(', ')})`, 'string'),
  REVERSE: (_a, ctx) => { throw new ConvertError('REVERSE() không có trong FoxPro SQL.', ctx.line); },
  CHAR: (a) => text(`CHR(${a[0].text})`, 'string'),
  ASCII: (a) => num(`ASC(${a[0].text})`),
  STR: (a) => text(`STR(${a.map((u) => u.text).join(', ')})`, 'string'),
  CONCAT: (a) => text(a.map((u) => (u.kind && !isTextKind(u.kind) ? `TRANSFORM(${u.text})` : u.text)).join(' + '), 'string'),
  ROUND: (a, ctx) => {
    needs('ROUND', a, 2, 3, ctx.line);
    if (a[2] && a[2].text !== '0') return num(`INT(${a[0].text} * 10 ^ ${a[1].text}) / 10 ^ ${a[1].text}`);
    return num(`ROUND(${a[0].text}, ${a[1].text})`);
  },
  FLOOR: (a) => num(`FLOOR(${a[0].text})`),
  CEILING: (a) => num(`CEILING(${a[0].text})`),
  ABS: (a) => num(`ABS(${a[0].text})`),
  SIGN: (a) => num(`SIGN(${a[0].text})`),
  SQRT: (a) => num(`SQRT(${a[0].text})`),
  POWER: (a) => num(`(${a[0].text} ^ ${a[1].text})`),
  GETDATE: () => text('DATETIME()', 'datetime'),
  SYSDATETIME: () => text('DATETIME()', 'datetime'),
  NOW: () => text('DATETIME()', 'datetime'),
  CURDATE: () => text('DATE()', 'date'),
  YEAR: (a) => num(`YEAR(${a[0].text})`),
  MONTH: (a) => num(`MONTH(${a[0].text})`),
  DAY: (a) => num(`DAY(${a[0].text})`),
  DAYOFMONTH: (a) => num(`DAY(${a[0].text})`),
  QUARTER: (a) => num(`QUARTER(${a[0].text})`),
  HOUR: (a) => num(`HOUR(${a[0].text})`),
  MINUTE: (a) => num(`MINUTE(${a[0].text})`),
  SECOND: (a) => num(`SEC(${a[0].text})`),
  DATEPART: (a, ctx) => {
    const fox = DATEPART_FOX[a[0].text.toUpperCase()];
    if (!fox) throw new ConvertError(`DATEPART(${a[0].text}) không chuyển được.`, ctx.line);
    return num(`${fox}(${a[1].text})`);
  },
  DATEADD: (a, ctx) => { needs('DATEADD', a, 3, 3, ctx.line); return dateAdd(a, ctx); },
  DATEDIFF: (a, ctx) => { needs('DATEDIFF', a, 3, 3, ctx.line); return dateDiff(a, ctx); },
  DATEFROMPARTS: (a) => text(`DATE(${a.map((u) => u.text).join(', ')})`, 'date'),
  EOMONTH: (a, ctx) => {
    const shifted = a[1] ? `GOMONTH(${a[0].text}, ${a[1].text})` : a[0].text;
    if (a[1]) ctx.warn('EOMONTH với tham số tháng: đã dùng GOMONTH.');
    return text(`GOMONTH(DATE(YEAR(${shifted}), MONTH(${shifted}), 1), 1) - 1`, 'date');
  },
  IIF: (a) => { const b = padBranches(a.slice(1)); return { text: `IIF(${a[0].text}, ${b.map((u) => u.text).join(', ')})`, kind: a[1]?.kind ?? a[2]?.kind, width: widthOf(b) }; },
  COUNT: (a) => num(`COUNT(${a.map((u) => u.text).join(', ')})`),
  SUM: (a) => num(`SUM(${a[0].text})`),
  AVG: (a) => num(`AVG(${a[0].text})`),
  MIN: (a) => ({ text: `MIN(${a[0].text})`, kind: a[0].kind }),
  MAX: (a) => ({ text: `MAX(${a[0].text})`, kind: a[0].kind }),
};

// ---------- Expressions ----------

function columnContext(name: string, state: State): [string, ColumnContext] {
  const path = name.replace(/^#/, '').split('.');
  return [path[path.length - 1].replace(/^\[(.*)\]$/, '$1'), { qualifier: path.length > 1 ? path[path.length - 2] : undefined, tables: state.tables }];
}
const columnKind = (name: string, state: State) => state.resolveColumnKind?.(...columnContext(name, state));
const columnWidth = (name: string, state: State) => state.resolveColumnWidth?.(...columnContext(name, state));

function readUnit(tokens: Token[], i: number, state: State): { unit: Unit; next: number } {
  const t = tokens[i];
  state.line = t.line;
  const single = (unit: Unit) => ({ unit, next: i + 1 });
  switch (t.kind) {
    case 'string': {
      const date = dateFromString(t.text);
      return single(date ?? { text: foxString(t.text, t.line), kind: 'string', literal: true, width: t.text.length });
    }
    case 'number':
      return single(num(t.text));
    case 'op':
      return single({ text: OPERATOR_FOX[t.text] ?? t.text });
    case 'punct': {
      if (t.text === ')') throw new ConvertError('Thừa dấu ) đóng ngoặc.', t.line);
      if (t.text === '{') {
        // ODBC escape: {fn NAME(...)} or {d '...'} / {ts '...'}.
        const close = tokens.findIndex((x, k) => k > i && isPunct(x, '}'));
        if (close < 0) throw new ConvertError('Thiếu dấu } đóng.', t.line);
        const inner = tokens.slice(i + 1, close);
        if (isWord(inner[0], 'FN')) return { unit: rewrite(inner.slice(1), state)[0], next: close + 1 };
        if ((isWord(inner[0], 'D') || isWord(inner[0], 'TS')) && inner[1]?.kind === 'string') {
          const date = dateFromString(inner[1].text);
          if (date) return { unit: date, next: close + 1 };
        }
        throw new ConvertError('Cú pháp {...} không chuyển được.', t.line);
      }
      if (t.text !== '(') return single({ text: t.text });
      const close = matchingParen(tokens, i);
      const inner = tokens.slice(i + 1, close);
      if (isWord(inner[0], 'SELECT')) return { unit: { text: `(${convertSelect(inner, state)})` }, next: close + 1 };
      const units = rewrite(inner, state);
      return { unit: { text: `(${joinUnits(units)})`, kind: units.length === 1 ? units[0].kind : undefined }, next: close + 1 };
    }
    case 'ident': {
      const upper = t.text.toUpperCase();
      if (upper === 'CASE') {
        const r = caseExpression(tokens.slice(i), state);
        return { unit: r.unit, next: i + r.next };
      }
      if (t.text.startsWith('@')) throw new ConvertError(`Biến ${t.text} không có trong FoxPro SQL.`, t.line);
      if (upper in UNSUPPORTED_WORDS) throw new ConvertError(UNSUPPORTED_WORDS[upper], t.line);
      if (upper === 'NULL') return single({ text: 'NULL' });
      if (!isPunct(tokens[i + 1], '(') || KEYWORDS_BEFORE_PAREN.has(upper)) {
        if (/^[A-Z_]+$/.test(t.text) && KEYWORDS_BEFORE_PAREN.has(upper)) return single({ text: upper });
        if (/^(SELECT|FROM|WHERE|GROUP|ORDER|BY|HAVING|INNER|LEFT|RIGHT|FULL|OUTER|JOIN|ON|AS|AND|OR|NOT|IN|IS|LIKE|BETWEEN|EXISTS|DISTINCT|TOP|UNION|ALL|ASC|DESC|PERCENT|INTO)$/.test(upper)) return single({ text: upper });
        return single({ text: foxName(t.text, state, t.line), kind: columnKind(t.text, state), column: true, width: columnWidth(t.text, state) });
      }
      if (upper in UNSUPPORTED_FUNCTIONS) throw new ConvertError(UNSUPPORTED_FUNCTIONS[upper], t.line);
      const close = matchingParen(tokens, i + 1);
      const rawArgs = splitList(tokens.slice(i + 2, close));
      if (upper === 'CAST' || upper === 'TRY_CAST') {
        const asAt = rawArgs[0].findIndex((x) => isWord(x, 'AS'));
        if (asAt < 0) throw new ConvertError('CAST thiếu AS.', t.line);
        const value = rewrite(rawArgs[0].slice(0, asAt), state);
        const type = rawArgs[0].slice(asAt + 1).map((x) => x.text).join('');
        return { unit: castTo(type, { text: joinUnits(value), kind: value.length === 1 ? value[0].kind : undefined }, undefined, state), next: close + 1 };
      }
      if (upper === 'CONVERT' || upper === 'TRY_CONVERT') {
        const type = rawArgs[0].map((x) => x.text).join('');
        const value = rewrite(rawArgs[1], state);
        return { unit: castTo(type, { text: joinUnits(value), kind: value.length === 1 ? value[0].kind : undefined }, rawArgs[2]?.[0]?.text, state), next: close + 1 };
      }
      const args = rawArgs.map((arg) => {
        // DATEADD/DATEDIFF/DATEPART take a part name first, which is not an expression.
        if (/^DATE(ADD|DIFF|PART)$/.test(upper) && arg === rawArgs[0]) return { text: arg[0].text } as Unit;
        const units = rewrite(arg, state);
        return asOperand(units);
      });
      const handler = HANDLERS[upper];
      if (handler) return { unit: handler(args, state, rawArgs), next: close + 1 };
      state.warn(`Hàm ${t.text}() được giữ nguyên; FoxPro có thể không có hàm này.`);
      const kind = STRING_FUNCTIONS.has(upper) ? 'string' : DATE_FUNCTIONS.has(upper) ? 'date' : DATETIME_FUNCTIONS.has(upper) ? 'datetime' : undefined;
      return { unit: { text: `${t.text}(${args.map((u) => u.text).join(', ')})`, kind }, next: close + 1 };
    }
    default:
      return single({ text: t.text });
  }
}

/** Removes and returns the operand ending `units`, including its arithmetic chain. */
function popOperand(units: Unit[]): Unit[] {
  const operand = [units.pop()!];
  while (units.length >= 2 && ARITHMETIC.has(units[units.length - 1].text)) {
    operand.unshift(units.pop()!);
    operand.unshift(units.pop()!);
  }
  return operand;
}

const isTextual = (u: Unit) => u.literal || isTextKind(u.kind);
function chainKind(units: Unit[]): ColumnKind | undefined {
  if (units.length === 1) return units[0].kind;
  const operands = units.filter((_, i) => i % 2 === 0);
  const operators = units.filter((_, i) => i % 2 === 1);
  if (units.length % 2 === 0 || !operators.every((o) => o.text === '+' || o.text === '-' || o.text === '*')) return undefined;
  return operands.every((o) => o.kind === 'integer' || /^-?d+$/.test(o.text)) ? 'integer' : undefined;
}
const asOperand = (units: Unit[]): Unit => ({ text: joinUnits(units), kind: chainKind(units), literal: units.length === 1 && units[0].literal, column: units.length === 1 && units[0].column, width: units.length === 1 ? units[0].width : undefined });

/** Exact, case-insensitive text comparison as SQL Server does it, in FoxPro terms. */
function textComparison(left: Unit, operator: string, right: Unit, state: State): string {
  const wrap = (u: Unit) => (state.caseInsensitive ? `UPPER(${u.text})` : u.text);
  const equal = `${wrap(left)} == ${wrap(right)}`;
  if (operator === '=') return equal;
  if (operator === '<>') return `!(${equal})`;
  // FoxPro also stops at the shorter string for < and >; the ordinal order itself is the same.
  return `${wrap(left)} ${operator} ${wrap(right)}`;
}

function rewrite(tokens: Token[], state: State): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const last = units[units.length - 1];

    // `x = 'abc'`, `x <> y`: text comparisons are exact and case-insensitive on SQL Server.
    if (t.kind === 'op' && COMPARISONS.has(t.text) && last && !ARITHMETIC.has(last.text) && !COMPARISONS.has(last.text)) {
      const operator = OPERATOR_FOX[t.text] ?? t.text;
      const leftUnits = popOperand(units);
      const left = asOperand(leftUnits);
      const right = readChain(tokens, i + 1, state);
      const rightUnit = asOperand(right.units);
      const anyText = isTextual(left) || isTextual(rightUnit);
      const anyBool = left.kind === 'bool' || rightUnit.kind === 'bool';
      if (anyBool && /^[01]$/.test(rightUnit.text) && (operator === '=' || operator === '<>')) {
        // bit = 1 → the logical field itself.
        const truthy = (rightUnit.text === '1') === (operator === '=');
        units.push({ text: truthy ? left.text : `!${left.text}`, kind: 'bool' });
      } else if (anyText && (operator === '=' || operator === '<>' || operator === '<' || operator === '>' || operator === '<=' || operator === '>=')) {
        units.push({ text: textComparison(left, operator, rightUnit, state) });
      } else {
        units.push(...leftUnits, { text: operator }, ...right.units);
      }
      i = right.next;
      continue;
    }

    // `x LIKE 'a%'` is case-insensitive on SQL Server.
    if (isWord(t, 'LIKE') && last) {
      const negated = last.text === 'NOT';
      if (negated) units.pop();
      const left = asOperand(popOperand(units));
      const pattern = readUnit(tokens, i + 1, state);
      if (/[[]/.test(pattern.unit.text)) throw new ConvertError('Mẫu LIKE có [ ]: FoxPro không hỗ trợ lớp ký tự.', t.line);
      const wrap = (s: string) => (state.caseInsensitive ? `UPPER(${s})` : s);
      units.push({ text: `${negated ? 'NOT ' : ''}${wrap(left.text)} LIKE ${wrap(pattern.unit.text)}` });
      i = pattern.next;
      continue;
    }

    // `x IN ('a', 'b')`: FoxPro's IN compares by prefix, so spell the exact comparisons out.
    if (isPunct(t, '(') && last && isWord(tokens[i - 1], 'IN') && !isWord(tokens[i + 1], 'SELECT')) {
      units.pop();
      const negated = units[units.length - 1]?.text === 'NOT';
      if (negated) units.pop();
      const left = asOperand(popOperand(units));
      const close = matchingParen(tokens, i);
      const items = splitList(tokens.slice(i + 1, close)).map((item) => asOperand(rewrite(item, state)));
      if (items.some(isTextual) || isTextual(left)) {
        const tests = items.map((item) => textComparison(left, '=', item, state)).join(' OR ');
        units.push({ text: `${negated ? 'NOT ' : ''}(${tests})` });
      } else {
        units.push({ text: `${left.text} ${negated ? 'NOT ' : ''}IN (${items.map((u) => u.text).join(', ')})` });
      }
      i = close + 1;
      continue;
    }

    // Integer division and modulo keep SQL Server's meaning.
    if (t.kind === 'op' && (t.text === '/' || t.text === '%') && last && i + 1 < tokens.length) {
      const left = asOperand(popOperand(units));
      const right = readUnit(tokens, i + 1, state);
      const isInteger = (u: Unit) => /^-?\d+$/.test(u.text) || u.kind === 'integer';
      const bothIntegers = isInteger(left) && isInteger(right.unit);
      if (t.text === '%') units.push(num(`(${left.text} - ${right.unit.text} * INT(${left.text} / ${right.unit.text}))`));
      else if (bothIntegers) units.push(num(`INT(${left.text} / ${right.unit.text})`));
      else {
        if ((left.kind === 'number' || right.unit.kind === 'number') && (left.column || right.unit.column)) state.warn('Phép chia: SQL Server cắt phần thập phân khi cả hai vế là số nguyên, FoxPro thì không. Dùng INT() nếu cần.');
        units.push(left, { text: '/' }, right.unit);
      }
      i = right.next;
      continue;
    }

    // A leading minus belongs to the number: `-1`, not `- 1`.
    const startsOperand = !last || ARITHMETIC.has(last.text) || COMPARISONS.has(last.text) || last.text === '(' || last.text === ',' || /^(AND|OR|NOT|WHEN|THEN|ELSE|SELECT|BY)$/.test(last.text);
    if (t.kind === 'op' && t.text === '-' && startsOperand && tokens[i + 1]?.kind === 'number') {
      units.push(num(`-${tokens[i + 1].text}`));
      i += 2;
      continue;
    }

    const { unit, next } = readUnit(tokens, i, state);
    units.push(unit);
    i = next;
  }
  return units;
}

/** Reads an operand and any arithmetic that follows it. */
function readChain(tokens: Token[], start: number, state: State): { units: Unit[]; next: number } {
  const units: Unit[] = [];
  let i = start;
  for (;;) {
    const operand = readUnit(tokens, i, state);
    units.push(operand.unit);
    i = operand.next;
    if (tokens[i]?.kind !== 'op' || !ARITHMETIC.has(tokens[i].text) || i + 1 >= tokens.length) break;
    units.push({ text: tokens[i].text });
    i++;
  }
  return { units, next: i };
}

// ---------- Statements ----------

function convertSelect(tokens: Token[], state: State): string {
  const line = tokens[0].line;
  let body = [...tokens];
  // TOP (n) → TOP n
  const topAt = findTopLevel(body, (t, i) => isWord(t, 'TOP') && isPunct(body[i + 1], '('));
  if (topAt >= 0) body.splice(topAt + 1, 3, body[topAt + 2]);

  // INTO #cursor sits before FROM in T-SQL; FoxPro puts INTO CURSOR at the end.
  let cursor: string | undefined;
  const intoAt = findTopLevel(body, (t) => isWord(t, 'INTO'));
  if (intoAt >= 0) {
    const target = body[intoAt + 1];
    if (!target?.text.startsWith('#')) throw new ConvertError('INTO bảng thật không chuyển được; chỉ bảng tạm (#) thành cursor.', line);
    cursor = target.text.slice(1);
    state.cursors.add(cursor.toLowerCase());
    body = [...body.slice(0, intoAt), ...body.slice(intoAt + 2)];
  }
  for (const t of body) if (t.kind === 'ident' && t.text.toUpperCase() in UNSUPPORTED_WORDS) throw new ConvertError(UNSUPPORTED_WORDS[t.text.toUpperCase()], t.line);

  const previousTables = state.tables;
  state.tables = [...previousTables, ...collectTables(body)];
  let out = joinUnits(rewrite(body, state));
  state.tables = previousTables;
  if (cursor) out += ` INTO CURSOR ${cursor}`;
  return out;
}

function convertStatement(tokens: Token[], state: State): string | undefined {
  const head = tokens[0];
  state.line = head.line;
  const lead = head.text.toUpperCase();
  // `DROP TABLE IF EXISTS #x` is how the forward converter resets a cursor; nothing to say in FoxPro.
  if (lead === 'DROP' && tokens.some((t) => t.text.startsWith('#'))) return undefined;
  if (lead in UNSUPPORTED_LEADS) throw new ConvertError(UNSUPPORTED_LEADS[lead], head.line);
  if (lead !== 'SELECT') throw new ConvertError(`Lệnh ${head.text} không chuyển được (chỉ SELECT).`, head.line);
  return convertSelect(tokens, state);
}

export function convertTsql(source: string, options: ReverseOptions = {}): ReverseResult {
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const statements: { line: number; foxpro: string }[] = [];
  const state: State = {
    line: 1,
    caseInsensitive: options.caseInsensitive ?? true,
    resolveColumnKind: options.resolveColumnKind,
    resolveColumnWidth: options.resolveColumnWidth,
    tables: [],
    cursors: new Set(),
    warn: (message) => {
      if (!warnings.some((w) => w.line === state.line && w.message === message)) warnings.push({ line: state.line, message });
    },
  };

  let tokens: Token[] = [];
  try {
    tokens = tokenizeTsql(source);
  } catch (e) {
    if (!(e instanceof ConvertError)) throw e;
    errors.push({ line: e.line, message: e.message });
  }
  for (const statement of splitTsqlStatements(tokens)) {
    try {
      const foxpro = convertStatement(statement, state);
      if (foxpro !== undefined) statements.push({ line: statement[0].line, foxpro });
    } catch (e) {
      if (!(e instanceof ConvertError)) throw e;
      errors.push({ line: e.line, message: e.message });
    }
  }
  errors.sort((a, b) => a.line - b.line);
  return { foxpro: errors.length ? '' : statements.map((s) => s.foxpro).join('\n'), statements, errors, warnings, cursors: [...state.cursors] };
}
