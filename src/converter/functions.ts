import { ConvertError, type Token } from './tokenizer';

/**
 * `varstring` is a string column without a fixed width (memo, varchar(max)). Inside the
 * converter it is handled as `string` plus a variable-length flag.
 */
/**
 * `varstring` is a string column without a fixed width; `integer` a whole-number column.
 * The forward converter treats them as `string` and `number`; the reverse one needs the detail.
 */
export type ColumnKind = 'string' | 'varstring' | 'number' | 'integer' | 'date' | 'datetime' | 'bool';

export interface FunctionContext {
  line: number;
  dateStyle: 'dmy' | 'mdy';
  /** SET ANSI: when false (FoxPro default) = against a string literal matches by prefix. */
  ansi: boolean;
  warn(message: string): void;
}

/**
 * `args` are already converted to T-SQL; `rawArgs` are the original tokens of each
 * argument and `kinds` the value kind of each argument, where it could be worked out.
 */
export type FunctionHandler = (args: string[], ctx: FunctionContext, rawArgs: Token[][], kinds: (ColumnKind | undefined)[]) => string;

/** FoxPro compares strings byte by byte (case-sensitive) under the default SET COLLATE MACHINE. */
const BINARY_COLLATION = 'Latin1_General_BIN2';
/** A Sunday, used to compute the day of week independently of SET DATEFIRST. */
const REFERENCE_SUNDAY = "'19000107'";

/** ODBC scalar-function escape, parsed natively by SQL Server. */
const fn = (name: string, ...args: string[]) => `{fn ${name}(${args.join(', ')})}`;

const trimBoth = (x: string) => fn('LTRIM', fn('RTRIM', x));
const asText = (x: string) => `CAST(${x} AS nvarchar(4000))`;
/** Cast to Unicode first so the collation change cannot remap characters of a varchar code page. */
const binaryText = (x: string) => `CAST(${x} AS nvarchar(max)) COLLATE ${BINARY_COLLATION}`;
/** A bare string literal must be Unicode so it does not inherit a fixed-width column type. */
const unicodeLiteral = (x: string) => (x.startsWith("'") ? `N${x}` : x);

export function stringLiteral(value: string): string {
  const quoted = `'${value.replace(/'/g, "''")}'`;
  // Non-ASCII text (Vietnamese) must be an N literal to survive nvarchar comparison.
  return /[^\x00-\x7F]/.test(value) ? `N${quoted}` : quoted;
}

/**
 * LIKE pattern for FoxPro's `=` with SET ANSI OFF: the comparison stops at the end
 * of the literal, so `ma = "NV"` is true for every value starting with NV.
 */
export function prefixPattern(value: string): string {
  const escaped = value.replace(/ +$/, '').replace(/[[%_]/g, (ch) => `[${ch}]`);
  return stringLiteral(`${escaped}%`);
}

/** Length of a string including trailing blanks, which T-SQL LEN() leaves out. */
export const lengthSql = (x: string) => `(LEN(${x} + N'.') - 1)`;

/**
 * `subject = literal` under SET ANSI OFF: equal up to the end of the shorter side.
 * A column is fixed-width in FoxPro, so there only the literal can be the shorter one.
 */
export function prefixEquals(subject: string, literal: string, isColumn: boolean): string {
  const startsWith = `${subject} LIKE ${prefixPattern(literal)}`;
  return isColumn ? startsWith : `(${startsWith} OR ${subject} = LEFT(${stringLiteral(literal)}, ${lengthSql(subject)}))`;
}

const isStringLiteral = (tokens: Token[] | undefined) => tokens?.length === 1 && tokens[0].kind === 'string';

/** Case-sensitive substring test, as FoxPro's `$` operator. */
export const containsSql = (needle: string, haystack: string) => `(CHARINDEX(${needle}, ${binaryText(haystack)}) > 0)`;

function arity(name: string, min: number, max: number, handler: FunctionHandler): FunctionHandler {
  return (args, ctx, rawArgs, kinds) => {
    if (args.length < min || args.length > max) {
      const expected = min === max ? `${min}` : `${min}-${max}`;
      throw new ConvertError(`Hàm ${name}() cần ${expected} tham số, nhận ${args.length}.`, ctx.line);
    }
    return handler(args, ctx, rawArgs, kinds);
  };
}

/** SQL Server CONVERT style matching FoxPro SET DATE. */
const dateStyleCode = (ctx: FunctionContext) => (ctx.dateStyle === 'dmy' ? 103 : 101);

/** EMPTY() as in FoxPro: blank, zero or false, and never true for NULL. */
function empty([x]: string[], ctx: FunctionContext, _rawArgs: Token[][], [kind]: (ColumnKind | undefined)[]): string {
  switch (kind) {
    // The IS NOT NULL test makes the result a definite false for NULL, so NOT EMPTY(NULL) is true.
    case 'number':
    case 'bool':
      return `(${x} IS NOT NULL AND ${x} = 0)`;
    case 'date':
    case 'datetime':
      // Verified with FoxPro 9 reading SQL Server over ODBC: NULL, 1899-12-30 and 1900-01-01
      // are all non-empty, so no stored date can ever be EMPTY().
      ctx.warn(`EMPTY(${x}): cột ngày trên SQL Server không bao giờ rỗng theo FoxPro, điều kiện này luôn sai. Dùng ISNULL(${x}) để tìm ngày chưa có.`);
      return '(1 = 0)';
    case 'string':
      // T-SQL `=` ignores trailing blanks, so an all-blank value also equals ''.
      return `(${x} IS NOT NULL AND ${x} = '')`;
    default:
      ctx.warn(`EMPTY(${x}): không xác định được kiểu dữ liệu, đang so sánh như chuỗi.`);
      return `(${x} IS NOT NULL AND ${x} = '')`;
  }
}

/** EVL(x, y): y when x is empty, otherwise x. */
function evl([x, fallback]: string[], ctx: FunctionContext, rawArgs: Token[][], kinds: (ColumnKind | undefined)[]): string {
  return `CASE WHEN ${empty([x], ctx, rawArgs, kinds)} THEN ${fallback} ELSE ${x} END`;
}

/** Number of case-sensitive, non-overlapping occurrences of `search` in `s`. */
function occurs([search, s]: string[]): string {
  const removed = `REPLACE(${binaryText(s)}, ${search}, '')`;
  return `CASE WHEN ${lengthSql(search)} = 0 THEN 0 ELSE (${lengthSql(s)} - ${lengthSql(removed)}) / ${lengthSql(search)} END`;
}

/** Position of the last case-sensitive occurrence of `search` in `s`, 0 when absent. */
function rat([search, s]: string[]): string {
  const fromEnd = `CHARINDEX(REVERSE(${search}), REVERSE(${binaryText(s)}))`;
  return `CASE WHEN ${fromEnd} = 0 THEN 0 ELSE ${lengthSql(s)} - ${fromEnd} - ${lengthSql(search)} + 2 END`;
}

function inlist([x, ...list]: string[], ctx: FunctionContext, [rawSubject, ...rawList]: Token[][]): string {
  if (ctx.ansi || !rawList.some(isStringLiteral)) return `(${x} IN (${list.join(', ')}))`;
  const isColumn = rawSubject.length === 1 && rawSubject[0].kind === 'ident';
  const tests = list.map((item, i) => (isStringLiteral(rawList[i]) ? prefixEquals(x, rawList[i][0].text, isColumn) : `${x} = ${item}`));
  return `(${tests.join(' OR ')})`;
}

/** FoxPro reads the leading number and ignores the rest: VAL("12abc") = 12, VAL("abc") = 0. */
function val([s]: string[]): string {
  const text = `LTRIM(${s})`;
  // The minus sign comes first in the set: after a character it would start a range.
  const prefix = `LEFT(${text}, PATINDEX('%[^-0-9.]%', ${text} + 'x') - 1)`;
  return `CASE WHEN ${s} IS NULL THEN NULL ELSE COALESCE(TRY_CAST(${prefix} AS float), 0) END`;
}

/** STR() rounds half away from zero; rounding before T-SQL STR avoids its binary-float rounding. */
function str([x, length, decimals]: string[]): string {
  const rounded = `ROUND(${x}, ${decimals ?? '0'})`;
  return `STR(${[rounded, length, decimals].filter((arg) => arg !== undefined).join(', ')})`;
}

/** The fill pattern starts at the left edge, so it is cut to the gap rather than right-aligned. */
function padl([x, n, pad]: string[]): string {
  const kept = `LEFT(${asText(x)}, ${n})`;
  return `LEFT(REPLICATE(${pad ?? "' '"}, ${n}), ${n} - (LEN(${kept} + N'.') - 1)) + ${kept}`;
}

/** TRANSFORM() of NULL is the text .NULL. in FoxPro, not NULL. */
function transform([x]: string[], ctx: FunctionContext, _rawArgs: Token[][], [kind]: (ColumnKind | undefined)[]): string {
  const text = kind === 'date' ? `CONVERT(varchar(10), ${x}, ${dateStyleCode(ctx)})` : kind === 'bool' ? `IIF(${x} = 1, '.T.', '.F.')` : asText(x);
  return `COALESCE(${text}, '.NULL.')`;
}

/** FoxPro averages an integer field as an integer, but an expression as a decimal. */
function avg([x]: string[], _ctx: FunctionContext, [raw]: Token[][]): string {
  const isPlain = raw.length === 1 || raw[0]?.text.toUpperCase() === 'DISTINCT';
  return isPlain ? `AVG(${x})` : `AVG(1.0 * (${x}))`;
}

function icase(args: string[]): string {
  const branches: string[] = [];
  for (let i = 0; i + 1 < args.length; i += 2) branches.push(`WHEN ${args[i]} THEN ${args[i + 1]}`);
  const otherwise = args.length % 2 ? ` ELSE ${args[args.length - 1]}` : '';
  return `CASE ${branches.join(' ')}${otherwise} END`;
}

const HANDLERS: Record<string, FunctionHandler> = {
  ALLTRIM: arity('ALLTRIM', 1, 1, ([x]) => trimBoth(x)),
  LTRIM: arity('LTRIM', 1, 1, ([x]) => fn('LTRIM', x)),
  RTRIM: arity('RTRIM', 1, 1, ([x]) => fn('RTRIM', x)),
  TRIM: arity('TRIM', 1, 1, ([x]) => fn('RTRIM', x)),
  UPPER: arity('UPPER', 1, 1, ([x]) => fn('UCASE', x)),
  LOWER: arity('LOWER', 1, 1, ([x]) => fn('LCASE', x)),
  LEFT: arity('LEFT', 2, 2, ([s, n]) => fn('LEFT', s, n)),
  RIGHT: arity('RIGHT', 2, 2, ([s, n]) => fn('RIGHT', s, n)),
  // T-SQL LEN ignores trailing blanks; FoxPro counts them.
  LEN: arity('LEN', 1, 1, ([x]) => `(LEN(${x} + N'.') - 1)`),
  SUBSTR: arity('SUBSTR', 2, 3, ([s, start, len]) => fn('SUBSTRING', s, start, len ?? fn('LENGTH', s))),
  AT: arity('AT', 2, 2, ([search, s]) => `CHARINDEX(${search}, ${binaryText(s)})`),
  ATC: arity('ATC', 2, 2, ([search, s]) => `CHARINDEX(LOWER(${search}), LOWER(CAST(${s} AS nvarchar(max))) COLLATE ${BINARY_COLLATION})`),
  STRTRAN: arity('STRTRAN', 2, 3, ([s, from, to]) => `REPLACE(${binaryText(s)}, ${from}, ${to ?? "''"}) COLLATE DATABASE_DEFAULT`),
  // FoxPro keeps the leftmost characters when the value is longer than the width.
  PADL: arity('PADL', 2, 3, padl),
  PADR: arity('PADR', 2, 3, ([x, n, pad]) => `LEFT(${asText(x)} + REPLICATE(${pad ?? "' '"}, ${n}), ${n})`),
  CHR: arity('CHR', 1, 1, ([x]) => `CHAR(${x})`),
  ASC: arity('ASC', 1, 1, ([x]) => `ASCII(${x})`),
  TRANSFORM: arity('TRANSFORM', 1, 1, transform),
  VAL: arity('VAL', 1, 1, val),
  STR: arity('STR', 1, 3, str),

  // COALESCE, not ISNULL: ISNULL truncates the fallback to the first argument's type.
  NVL: arity('NVL', 2, 2, ([a, b]) => `COALESCE(${unicodeLiteral(a)}, ${unicodeLiteral(b)})`),
  EMPTY: arity('EMPTY', 1, 1, empty),
  EVL: arity('EVL', 2, 2, evl),
  OCCURS: arity('OCCURS', 2, 2, occurs),
  RAT: arity('RAT', 2, 2, rat),
  INLIST: arity('INLIST', 2, 99, inlist),
  ICASE: arity('ICASE', 2, 199, icase),
  INT: arity('INT', 1, 1, ([x]) => `ROUND(${x}, 0, 1)`),
  // FoxPro's result takes the sign of the divisor; T-SQL % takes the sign of the dividend.
  MOD: arity('MOD', 2, 2, ([a, b]) => `(((${a}) % (${b}) + (${b})) % (${b}))`),
  AVG: arity('AVG', 1, 1, avg),

  DATE: arity('DATE', 0, 3, (args) => (args.length === 3 ? `DATEFROMPARTS(${args.join(', ')})` : fn('CURDATE'))),
  DATETIME: arity('DATETIME', 0, 0, () => fn('NOW')),
  YEAR: arity('YEAR', 1, 1, ([d]) => fn('YEAR', d)),
  MONTH: arity('MONTH', 1, 1, ([d]) => fn('MONTH', d)),
  DAY: arity('DAY', 1, 1, ([d]) => fn('DAYOFMONTH', d)),
  QUARTER: arity('QUARTER', 1, 1, ([d]) => fn('QUARTER', d)),
  DOW: arity('DOW', 1, 1, ([d]) => `(DATEDIFF(day, ${REFERENCE_SUNDAY}, ${d}) % 7 + 1)`),
  HOUR: arity('HOUR', 1, 1, ([d]) => fn('HOUR', d)),
  MINUTE: arity('MINUTE', 1, 1, ([d]) => fn('MINUTE', d)),
  SEC: arity('SEC', 1, 1, ([d]) => fn('SECOND', d)),
  GOMONTH: arity('GOMONTH', 2, 2, ([d, n]) => `DATEADD(month, ${n}, ${d})`),
  TTOD: arity('TTOD', 1, 1, ([d]) => `CAST(${d} AS date)`),
  DTOT: arity('DTOT', 1, 1, ([d]) => `CAST(${d} AS datetime)`),
  DTOS: arity('DTOS', 1, 1, ([d]) => `CONVERT(varchar(8), ${d}, 112)`),
  DTOC: arity('DTOC', 1, 2, ([d, sortable], ctx) =>
    sortable ? `CONVERT(varchar(8), ${d}, 112)` : `CONVERT(varchar(10), ${d}, ${dateStyleCode(ctx)})`,
  ),
  // An unparsable string gives FoxPro's empty date, which is NULL here.
  CTOD: arity('CTOD', 1, 1, ([s], ctx) => `TRY_CONVERT(date, ${s}, ${dateStyleCode(ctx)})`),
};

const STRING_FUNCTIONS = ['ALLTRIM', 'LTRIM', 'RTRIM', 'TRIM', 'UPPER', 'LOWER', 'LEFT', 'RIGHT', 'SUBSTR', 'STRTRAN', 'PADL', 'PADR', 'CHR', 'TRANSFORM', 'STR', 'DTOC', 'DTOS', 'REPLICATE', 'SPACE', 'STUFF'];
const NUMBER_FUNCTIONS = ['LEN', 'AT', 'ATC', 'ASC', 'VAL', 'INT', 'MOD', 'ROUND', 'ABS', 'SIGN', 'OCCURS', 'RAT', 'SQRT', 'CEILING', 'FLOOR', 'YEAR', 'MONTH', 'DAY', 'DOW', 'QUARTER', 'HOUR', 'MINUTE', 'SEC', 'COUNT', 'SUM', 'AVG'];
/** Kind of value a function returns, where expression typing needs to know it. */
const RETURN_KINDS: Record<string, ColumnKind> = {
  ...Object.fromEntries(STRING_FUNCTIONS.map((name) => [name, 'string' as const])),
  ...Object.fromEntries(NUMBER_FUNCTIONS.map((name) => [name, 'number' as const])),
  DATE: 'date',
  CTOD: 'date',
  TTOD: 'date',
  GOMONTH: 'date',
  DATETIME: 'datetime',
  DTOT: 'datetime',
};

export const returnKind = (name: string): ColumnKind | undefined => RETURN_KINDS[name.toUpperCase()];

/** True when argument `index` of the function is a logical condition rather than a value. */
export function isConditionArg(name: string, index: number, argCount: number): boolean {
  const upper = name.toUpperCase();
  if (upper === 'IIF') return index === 0;
  if (upper === 'ICASE') return index % 2 === 0 && index < argCount - (argCount % 2);
  return false;
}

/**
 * Returns the handler for a FoxPro function call, or undefined when the call
 * should pass through unchanged (aggregates, T-SQL functions, keywords).
 */
export function findHandler(name: string, argCount: number): FunctionHandler | undefined {
  const upper = name.toUpperCase();
  // BETWEEN(x, lo, hi) is the FoxPro function; anything else is the SQL operator.
  if (upper === 'BETWEEN') {
    return argCount === 3 ? ([x, lo, hi]) => `(${x} BETWEEN ${lo} AND ${hi})` : undefined;
  }
  // One-argument ISNULL is FoxPro's null test; two arguments is already T-SQL.
  if (upper === 'ISNULL') {
    return argCount === 1 ? ([x]) => `(${x} IS NULL)` : undefined;
  }
  return HANDLERS[upper];
}

export const FOXPRO_FUNCTIONS = [...Object.keys(HANDLERS), 'BETWEEN', 'ISNULL', 'IIF'].sort();
