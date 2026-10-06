import {
  containsSql,
  findHandler,
  isConditionArg,
  lengthSql,
  prefixEquals,
  prefixPattern,
  returnKind,
  stringLiteral,
  type ColumnKind,
  type FunctionContext,
} from './functions';
import { ConvertError, splitStatements, type Statement, type Token } from './tokenizer';

import type { ColumnKindResolver, TableRef } from './schema';

export { FOXPRO_FUNCTIONS, type ColumnKind } from './functions';
export { createColumnResolver, type ColumnContext, type ColumnKindResolver, type TableKinds, type TableRef } from './schema';

export interface ConvertOptions {
  /** Cursors created earlier in the same session (they live as #temp tables). */
  knownCursors?: Iterable<string>;
  /** Cursor that BROWSE reads when no cursor has been selected in this run. */
  currentCursor?: string;
  /**
   * Kind of a column, given its qualifier and the tables of its statement.
   * Build one from a schema with `createColumnResolver`.
   */
  resolveColumnKind?: ColumnKindResolver;
  /** Equivalent of FoxPro SET DATE, used by DTOC()/CTOD(). */
  dateStyle?: 'dmy' | 'mdy';
  /**
   * Equivalent of FoxPro SET ANSI. Off by default, as in FoxPro: `=`, `#` and IN
   * against a string literal compare only up to the end of the literal.
   */
  ansi?: boolean;
}

export interface Diagnostic {
  line: number;
  message: string;
}

export interface ConvertedStatement {
  line: number;
  sql: string;
}

export interface ConvertResult {
  /** All converted statements as one T-SQL batch; empty when there are errors. */
  sql: string;
  statements: ConvertedStatement[];
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** Every cursor known after this run, lower-cased. */
  cursors: string[];
  currentCursor?: string;
}

interface State extends FunctionContext {
  cursors: Set<string>;
  currentCursor?: string;
  resolveColumnKind?: ColumnKindResolver;
  /** Tables read by the statement being converted. */
  tables: TableRef[];
}

/** Words that can follow a table name in FROM without being its alias. */
const NOT_AN_ALIAS = new Set([
  'WHERE', 'ON', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'JOIN', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'INTO', 'AS',
]);

/** Lists the tables after every FROM and JOIN of a statement, subqueries included. */
function collectTables(tokens: Token[]): TableRef[] {
  const tables: TableRef[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], 'FROM') && !isWord(tokens[i], 'JOIN')) continue;
    // A FROM list can hold several comma-separated tables.
    for (let at = i + 1; tokens[at]?.kind === 'ident'; ) {
      const ref: TableRef = { name: tokens[at].text };
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

/** A converted operand, operator or keyword; `kind` is known only for typed operands. */
interface Unit {
  text: string;
  kind?: ColumnKind;
  /** Set on the operators that compare strings by prefix (`==` is always exact and is not marked). */
  comparison?: 'eq' | 'ne' | 'gt' | 'le';
  /** True for a plain column reference, which FoxPro treats as a fixed-width (padded) value. */
  column?: boolean;
}

/** FoxPro `/` never truncates; forcing a decimal operand avoids T-SQL integer division. */
const DIVIDE_SQL = '* 1.0 /';
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const ARITHMETIC_SQL = new Set(['+', '-', '*', '%', DIVIDE_SQL]);
const MULTIPLICATIVE = new Set(['*', '/', '%']);
const MULTIPLICATIVE_SQL = new Set(['*', DIVIDE_SQL]);
const COMPARISON = new Set(['=', '==', '<>', '!=', '#', '<', '>', '<=', '>=', '$']);
const LOGICAL_SQL: Record<string, string> = { T: '1', Y: '1', F: '0', N: '0', NULL: 'NULL', AND: 'AND', OR: 'OR', NOT: 'NOT' };
const OPERATOR_SQL: Record<string, string> = { '==': '=', '!=': '<>', '#': '<>', '!': 'NOT', '/': DIVIDE_SQL };
// `>=` and `<` give the same answer with or without the prefix rule, so they are not listed.
const PREFIX_COMPARISON: Record<string, NonNullable<Unit['comparison']>> = { '=': 'eq', '#': 'ne', '!=': 'ne', '<>': 'ne', '>': 'gt', '<=': 'le' };
const LOGICAL_CONDITION: Record<string, string> = { T: '1 = 1', Y: '1 = 1', F: '1 = 0', N: '1 = 0' };
/** FoxPro-only output modifiers that have no meaning on SQL Server. */
const IGNORED_CLAUSES = new Set(['NOCONSOLE', 'NOWAIT', 'PLAIN', 'READWRITE', 'NOFILTER']);
/** Words after which a bare logical column is a condition (`WHERE active`). */
const CONDITION_LEAD = new Set(['WHERE', 'AND', 'OR', 'NOT', 'ON', 'HAVING', 'FOR', 'WHEN']);
const PREDICATE_WORDS = new Set(['IS', 'IN', 'BETWEEN', 'LIKE']);
/** Keywords that may be followed by a parenthesis without being a function call. */
const KEYWORDS_BEFORE_PAREN = new Set([
  'AND', 'OR', 'NOT', 'IN', 'ON', 'WHERE', 'HAVING', 'FROM', 'JOIN', 'EXISTS', 'SELECT', 'BY', 'AS', 'WHEN', 'THEN',
  'ELSE', 'UNION', 'ALL', 'ANY', 'SOME', 'LIKE', 'FOR', 'DISTINCT', 'TOP', 'OVER',
]);
/** Words that can end an expression without being a column alias. */
const NON_ALIAS_WORDS = new Set(['NULL', 'END', 'ASC', 'DESC']);
const NON_OPERAND_WORDS = new Set(['IS', 'AND', 'OR', 'NOT', 'LIKE', 'IN', 'DISTINCT', 'THEN', 'ELSE', 'WHEN', 'SELECT', 'ALL', 'TOP', 'PERCENT']);
const AGGREGATES = new Set(['SUM', 'AVG', 'MIN', 'MAX']);
const GROUP_END_WORDS = ['HAVING', 'ORDER', 'UNION', 'INTO'];
const HAVING_END_WORDS = ['ORDER', 'UNION', 'INTO'];

const isWord = (t: Token | undefined, word: string) => t?.kind === 'ident' && t.text.toUpperCase() === word;
const isPunct = (t: Token | undefined, text: string) => t?.kind === 'punct' && t.text === text;
const isDateKind = (kind: ColumnKind | undefined) => kind === 'date' || kind === 'datetime';
const cursorTable = (name: string) => `#${name}`;
const raw = (text: string, line: number): Token => ({ kind: 'raw', text, line });

/** A string operand is the only kind that may take part in FoxPro's prefix comparison. */
const canBeString = (unit: Unit | undefined) => !!unit && (unit.kind === undefined || unit.kind === 'string');

function dateLiteral(token: Token, state: State): Unit {
  if (!token.text.startsWith('^')) {
    state.warn('Hằng ngày rỗng {} được chuyển thành NULL.');
    return { text: 'NULL' };
  }
  const m = /^\^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\s,T]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*([ap])?m?)?$/i.exec(token.text);
  if (!m) throw new ConvertError(`Hằng ngày không hợp lệ: {${token.text}}`, token.line);
  const pad = (v: string | number) => String(v).padStart(2, '0');
  const date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if (m[4] === undefined) return { text: `{d '${date}'}`, kind: 'date' };
  let hour = Number(m[4]);
  if (m[7]) hour = (hour % 12) + (m[7].toLowerCase() === 'p' ? 12 : 0);
  return { text: `{ts '${date} ${pad(hour)}:${pad(m[5] ?? 0)}:${pad(m[6] ?? 0)}'}`, kind: 'datetime' };
}

function joinUnits(units: Unit[]): string {
  let sql = '';
  for (const { text } of units) {
    const tight = !sql || text === ',' || text === '}' || sql.endsWith('{');
    sql += (tight ? '' : ' ') + text;
  }
  return sql;
}

function matchingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')') && --depth === 0) return i;
  }
  throw new ConvertError('Thiếu dấu ) đóng ngoặc.', tokens[open].line);
}

/** Splits at top-level commas. */
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

const joinList = (parts: Token[][], line: number) => parts.flatMap((part, i) => (i ? [raw(',', line), ...part] : part));

/** Index of the first top-level token matching `predicate`, or -1. */
function findTopLevel(tokens: Token[], predicate: (t: Token, i: number) => boolean, from = 0): number {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (isPunct(tokens[i], '(')) depth++;
    else if (isPunct(tokens[i], ')')) depth--;
    else if (depth === 0 && i >= from && predicate(tokens[i], i)) return i;
  }
  return -1;
}

/** True when a logical column at `i` stands alone as a condition instead of being compared. */
function isBareCondition(tokens: Token[], i: number, lead: string | undefined): boolean {
  if (!lead || !CONDITION_LEAD.has(lead.toUpperCase())) return false;
  const next = tokens[i + 1];
  if (!next) return true;
  if (next.kind === 'op') return !COMPARISON.has(next.text) && !ARITHMETIC.has(next.text);
  return !(next.kind === 'ident' && PREDICATE_WORDS.has(next.text.toUpperCase()));
}

/** Kind of a whole expression, when its operands make that certain. */
function expressionKind(units: Unit[]): ColumnKind | undefined {
  const body = units[0]?.text === '-' ? units.slice(1) : units;
  if (body.length === 1) return body[0].kind;
  const operands = body.filter((_, i) => i % 2 === 0);
  const operators = body.filter((_, i) => i % 2 === 1);
  if (body.length % 2 === 0 || !operators.every((op) => ARITHMETIC_SQL.has(op.text))) return undefined;
  if (operands.some((op) => op.kind === 'string')) return 'string';
  return operands.every((op) => op.kind === 'number') ? 'number' : undefined;
}

/** Converts one operand or keyword starting at `i`; groups and calls are a single unit. */
function readUnit(tokens: Token[], i: number, state: State, lead: string | undefined): { unit: Unit; next: number } {
  const t = tokens[i];
  const single = (unit: Unit) => ({ unit, next: i + 1 });
  switch (t.kind) {
    case 'string':
      return single({ text: stringLiteral(t.text), kind: 'string' });
    case 'number':
      return single({ text: t.text, kind: 'number' });
    case 'date':
      return single(dateLiteral(t, state));
    case 'logical':
      // A logical constant used as a whole condition (`WHERE .T.`) needs a comparison in T-SQL.
      if (LOGICAL_CONDITION[t.text] && isBareCondition(tokens, i, lead)) return single({ text: LOGICAL_CONDITION[t.text] });
      return single({ text: LOGICAL_SQL[t.text] });
    case 'op':
      return single({ text: OPERATOR_SQL[t.text] ?? t.text, comparison: PREFIX_COMPARISON[t.text] });
    case 'punct': {
      if (t.text === ')') throw new ConvertError('Thừa dấu ) đóng ngoặc.', t.line);
      if (t.text !== '(') return single({ text: t.text });
      const close = matchingParen(tokens, i);
      const inner = rewriteUnits(tokens.slice(i + 1, close), state, lead);
      return { unit: { text: `(${joinUnits(inner)})`, kind: expressionKind(inner) }, next: close + 1 };
    }
    case 'ident': {
      if (!isPunct(tokens[i + 1], '(') || KEYWORDS_BEFORE_PAREN.has(t.text.toUpperCase())) {
        const owner = t.text.split('.')[0].toLowerCase();
        // The temp table is created under the lower-cased name; a case-sensitive tempdb needs the same spelling.
        const text = state.cursors.has(owner) ? cursorTable([owner, ...t.text.split('.').slice(1)].join('.')) : t.text;
        const path = t.text.split('.');
        const resolved = state.resolveColumnKind?.(path[path.length - 1], { qualifier: path[path.length - 2], tables: state.tables });
        if (resolved === 'bool' && isBareCondition(tokens, i, lead)) return single({ text: `${text} = 1` });
        const kind = resolved === 'varstring' ? 'string' : resolved;
        return single({ text, kind, column: resolved !== 'varstring' });
      }
      const close = matchingParen(tokens, i + 1);
      const rawArgs = splitList(tokens.slice(i + 2, close));
      const argUnits = rawArgs.map((arg, k) => rewriteUnits(arg, state, isConditionArg(t.text, k, rawArgs.length) ? 'WHERE' : undefined));
      const args = argUnits.map(joinUnits);
      const handler = findHandler(t.text, args.length);
      const text = handler ? handler(args, state, rawArgs, argUnits.map(expressionKind)) : `${t.text}(${args.join(', ')})`;
      return { unit: { text, kind: returnKind(t.text) }, next: close + 1 };
    }
    default:
      return single({ text: t.text });
  }
}

/** Reads an operand plus any following operators from `operators`, e.g. `a * b / c`. */
function readChain(tokens: Token[], start: number, state: State, operators: Set<string>): { units: Unit[]; next: number } {
  const units: Unit[] = [];
  let i = start;
  for (;;) {
    const operand = readUnit(tokens, i, state, undefined);
    units.push(operand.unit);
    i = operand.next;
    if (tokens[i]?.kind !== 'op' || !operators.has(tokens[i].text) || i + 1 >= tokens.length) break;
    units.push(readUnit(tokens, i, state, undefined).unit);
    i++;
  }
  return { units, next: i };
}

/** Removes and returns the operand that ends `units`, with the operator chain from `operators` before it. */
function popOperand(units: Unit[], operators: Set<string>): Unit[] {
  const operand = [units.pop()!];
  while (units.length >= 2 && operators.has(units[units.length - 1].text)) {
    operand.unshift(units.pop()!);
    operand.unshift(units.pop()!);
  }
  return operand;
}

/**
 * FoxPro date arithmetic: date ± n moves by days (seconds for datetime) and
 * date - date is the distance. T-SQL needs DATEADD/DATEDIFF for typed dates.
 */
function dateArithmetic(left: Unit, operator: string, right: Unit[]): Unit {
  const rightKind = right.length === 1 ? right[0].kind : undefined;
  const rightSql = joinUnits(right);
  const part = left.kind === 'datetime' || rightKind === 'datetime' ? 'second' : 'day';
  if (isDateKind(rightKind)) {
    if (operator === '-') return { text: `DATEDIFF(${part}, ${rightSql}, ${left.text})`, kind: 'number' };
    return { text: `${left.text} + ${rightSql}` };
  }
  const amount = operator === '-' ? `-(${rightSql})` : rightSql;
  return { text: `DATEADD(${part}, ${amount}, ${left.text})`, kind: left.kind };
}

/** Relational comparison of an expression with a string literal under FoxPro's prefix rule. */
function prefixComparison(subject: string, comparison: NonNullable<Unit['comparison']>, literal: string): string {
  const pattern = prefixPattern(literal);
  const value = stringLiteral(literal);
  switch (comparison) {
    case 'gt':
      return `(${subject} > ${value} AND ${subject} NOT LIKE ${pattern})`;
    case 'le':
      return `(${subject} <= ${value} OR ${subject} LIKE ${pattern})`;
    case 'eq':
      return prefixEquals(subject, literal, false);
    default:
      return `NOT ${prefixEquals(subject, literal, false)}`;
  }
}

/** `lead` is the word the expression follows, when that makes it a condition. */
function rewriteUnits(tokens: Token[], state: State, lead?: string): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    state.line = t.line;
    const last = units[units.length - 1];
    const hasRight = i + 1 < tokens.length;

    if (t.kind === 'op' && t.text === '$') {
      // `a $ b` (substring test) binds looser than arithmetic, so take whole arithmetic operands.
      if (!last || !hasRight) throw new ConvertError('Toán tử $ thiếu toán hạng.', t.line);
      const left = popOperand(units, ARITHMETIC_SQL);
      const right = readChain(tokens, i + 1, state, ARITHMETIC);
      units.push({ text: containsSql(joinUnits(left), joinUnits(right.units)) });
      i = right.next;
      continue;
    }

    if (t.kind === 'op' && (t.text === '^' || t.text === '**')) {
      if (!last || !hasRight) throw new ConvertError('Toán tử lũy thừa thiếu toán hạng.', t.line);
      const negative = tokens[i + 1].kind === 'op' && tokens[i + 1].text === '-';
      const exponent = readUnit(tokens, i + (negative ? 2 : 1), state, undefined);
      units[units.length - 1] = { text: `POWER(CAST(${last.text} AS float), ${negative ? '-' : ''}${exponent.unit.text})`, kind: 'number' };
      i = exponent.next;
      continue;
    }

    if (t.kind === 'op' && t.text === '%') {
      // FoxPro's % is MOD(): the result takes the sign of the divisor.
      if (!last || !hasRight) throw new ConvertError('Toán tử % thiếu toán hạng.', t.line);
      const left = joinUnits(popOperand(units, MULTIPLICATIVE_SQL));
      const right = readUnit(tokens, i + 1, state, undefined);
      units.push({ text: `(((${left}) % (${right.unit.text}) + (${right.unit.text})) % (${right.unit.text}))`, kind: 'number' });
      i = right.next;
      continue;
    }

    // FoxPro compares strings only up to the end of the shorter one (SET ANSI OFF).
    const literalEnds = tokens[i + 1]?.kind !== 'op' || !ARITHMETIC.has(tokens[i + 1].text);
    if (t.kind === 'string' && !state.ansi && last?.comparison && literalEnds && canBeString(units[units.length - 2])) {
      const subject = units[units.length - 2];
      const isChain = ARITHMETIC_SQL.has(units[units.length - 3]?.text ?? '');
      if ((last.comparison === 'eq' || last.comparison === 'ne') && subject.column && !isChain) {
        // Kept as a bare LIKE so an index on the column stays usable.
        units[units.length - 1] = { text: last.comparison === 'eq' ? 'LIKE' : 'NOT LIKE' };
        units.push({ text: prefixPattern(t.text), kind: 'string' });
      } else {
        units.pop();
        units.push({ text: prefixComparison(joinUnits(popOperand(units, ARITHMETIC_SQL)), last.comparison, t.text) });
      }
      i++;
      continue;
    }

    if (t.kind === 'string' && last?.text.toUpperCase() === 'LIKE') {
      // FoxPro's LIKE ignores trailing blanks of the value; T-SQL does not unless the pattern ends in %.
      const subjectAt = units.length - (units[units.length - 2]?.text === 'NOT' ? 3 : 2);
      if (!t.text.endsWith('%') && units[subjectAt]) units[subjectAt] = { text: `RTRIM(${units[subjectAt].text})`, kind: 'string' };
      // `[` is an ordinary character in a FoxPro pattern but opens a character class in T-SQL.
      units.push({ text: stringLiteral(t.text.replace(/\[/g, '[[]')), kind: 'string' });
      i++;
      continue;
    }

    // The prefix rule also applies to every literal of an IN list.
    if (isPunct(t, '(') && last?.text.toUpperCase() === 'IN' && !state.ansi) {
      const close = matchingParen(tokens, i);
      const items = splitList(tokens.slice(i + 1, close));
      const negated = units[units.length - 2]?.text === 'NOT';
      const subjectAt = units.length - (negated ? 3 : 2);
      const subject = units[subjectAt];
      const isWholeOperand = !ARITHMETIC_SQL.has(units[subjectAt - 1]?.text ?? '');
      if (items.length && items.every((item) => item.length === 1 && item[0].kind === 'string') && canBeString(subject) && isWholeOperand) {
        const tests = items.map(([literal]) => prefixEquals(subject.text, literal.text, !!subject.column)).join(' OR ');
        units.length = subjectAt;
        units.push({ text: `${negated ? 'NOT ' : ''}(${tests})` });
        i = close + 1;
        continue;
      }
    }

    if (t.kind === 'op' && (t.text === '+' || t.text === '-') && isDateKind(last?.kind) && hasRight) {
      const right = readChain(tokens, i + 1, state, MULTIPLICATIVE);
      units[units.length - 1] = dateArithmetic(last, t.text, right.units);
      i = right.next;
      continue;
    }

    const start = i;
    const { unit, next } = readUnit(tokens, i, state, last ? last.text : lead);
    i = next;

    // Two strings that are not both fixed-width columns: the comparison stops at the shorter one.
    // A column counts as the longer side, since FoxPro pads it to its declared width.
    const subject = units[units.length - 2];
    const isEquality = last?.comparison === 'eq' || last?.comparison === 'ne';
    const isOperand = t.kind === 'ident' || (isPunct(t, '(') && !isWord(tokens[start + 1], 'SELECT'));
    const operandEnds = tokens[next]?.kind !== 'op' || !ARITHMETIC.has(tokens[next].text);
    const subjectIsWhole = !ARITHMETIC_SQL.has(units[units.length - 3]?.text ?? '');
    const hasStringSide = unit.kind === 'string' || subject?.kind === 'string';
    if (!state.ansi && isEquality && isOperand && operandEnds && subjectIsWhole && subject && hasStringSide && !(unit.column && subject.column) && canBeString(unit) && canBeString(subject)) {
      const [a, b] = [subject.text, unit.text];
      const equal = subject.column ? `LEFT(${a}, ${lengthSql(b)}) = ${b}` : unit.column ? `${a} = LEFT(${b}, ${lengthSql(a)})` : `LEFT(${a}, ${lengthSql(b)}) = LEFT(${b}, ${lengthSql(a)})`;
      units.length -= 2;
      units.push({ text: last.comparison === 'eq' ? `(${equal})` : `NOT (${equal})` });
      continue;
    }
    units.push(unit);
  }
  return units;
}

const rewrite = (tokens: Token[], state: State, lead?: string) => joinUnits(rewriteUnits(tokens, state, lead));

// ---------- SELECT list ----------

interface SelectItem {
  /** Expression tokens without the alias. */
  expr: Token[];
  /** Explicit alias, if any. */
  alias?: string;
  /** Result column name: the alias, or the column name of a plain field reference. */
  name?: string;
}

function parseSelectItem(tokens: Token[]): SelectItem {
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  const asAt = findTopLevel(tokens, (t) => isWord(t, 'AS'));
  if (asAt > 0 && asAt === tokens.length - 2 && last.kind === 'ident') {
    return { expr: tokens.slice(0, asAt), alias: last.text, name: last.text };
  }
  const endsOperand =
    prev &&
    (prev.kind === 'number' || prev.kind === 'string' || isPunct(prev, ')') ||
      (prev.kind === 'ident' && !NON_OPERAND_WORDS.has(prev.text.toUpperCase())));
  if (endsOperand && last.kind === 'ident' && !last.text.includes('.') && !NON_ALIAS_WORDS.has(last.text.toUpperCase())) {
    return { expr: tokens.slice(0, -1), alias: last.text, name: last.text };
  }
  if (tokens.length === 1 && last.kind === 'ident' && !last.text.endsWith('*')) {
    return { expr: tokens, name: last.text.split('.').pop() };
  }
  return { expr: tokens };
}

/** Token range of the first SELECT list: after SELECT [DISTINCT] [TOP n], before FROM. */
function selectListRange(body: Token[]): { start: number; end: number } {
  let start = 1;
  if (isWord(body[start], 'DISTINCT') || isWord(body[start], 'ALL')) start++;
  if (isWord(body[start], 'TOP')) {
    start += 2;
    if (isWord(body[start], 'PERCENT')) start++;
  }
  const fromAt = findTopLevel(body, (t) => isWord(t, 'FROM'));
  return { start, end: fromAt >= 0 ? fromAt : body.length };
}

/** Name FoxPro gives an unnamed result column: cnt, sum_field, or exp_N. */
function defaultColumnName(item: SelectItem, position: number): string {
  const [head, open] = item.expr;
  const wrapsWholeItem = head?.kind === 'ident' && isPunct(open, '(') && matchingParen(item.expr, 1) === item.expr.length - 1;
  if (wrapsWholeItem) {
    const fnName = head.text.toUpperCase();
    const inner = item.expr.slice(2, -1);
    const field = (token: Token | undefined) => (token?.kind === 'ident' ? token.text.split('.').pop() : undefined);
    if (fnName === 'COUNT') {
      if (inner.length === 2 && isWord(inner[0], 'DISTINCT') && field(inner[1])) return `dcnt_${field(inner[1])}`;
      return inner.length === 1 && field(inner[0]) ? `cnt_${field(inner[0])}` : 'cnt';
    }
    if (AGGREGATES.has(fnName) && inner.length === 1 && field(inner[0])) return `${fnName.toLowerCase()}_${field(inner[0])}`;
  }
  return `exp_${position}`;
}

/** A temp table needs a unique name for every column; FoxPro generates them silently. */
function nameCursorColumns(items: SelectItem[], line: number): Token[][] {
  const isStar = (item: SelectItem) => item.expr.length === 1 && item.expr[0].text.endsWith('*');
  const baseNames = items.map((item, i) => (isStar(item) ? undefined : (item.name ?? defaultColumnName(item, i + 1))));
  const count = new Map<string, number>();
  for (const name of baseNames) if (name) count.set(name.toLowerCase(), (count.get(name.toLowerCase()) ?? 0) + 1);

  const seen = new Map<string, number>();
  return items.map((item, i) => {
    const base = baseNames[i];
    if (!base) return item.expr;
    let name = base;
    // Duplicate field names get _a, _b... suffixes; an explicit alias is left for the user to fix.
    if (!item.alias && count.get(base.toLowerCase())! > 1) {
      const index = seen.get(base.toLowerCase()) ?? 0;
      seen.set(base.toLowerCase(), index + 1);
      name = `${base}_${String.fromCharCode(97 + index)}`;
    }
    const isPlainColumn = item.name !== undefined && !item.alias && name === base;
    return isPlainColumn ? item.expr : [...item.expr, raw('AS', line), raw(name, line)];
  });
}

/** FoxPro allows GROUP BY column positions and aliases; T-SQL needs the expressions. */
function expandGroupBy(body: Token[], items: SelectItem[]): Token[] {
  const groupAt = findTopLevel(body, (t, i) => isWord(t, 'GROUP') && isWord(body[i + 1], 'BY'));
  if (groupAt < 0) return body;
  const listStart = groupAt + 2;
  const endAt = findTopLevel(body, (t) => GROUP_END_WORDS.some((word) => isWord(t, word)), listStart);
  const listEnd = endAt >= 0 ? endAt : body.length;

  const keys = splitList(body.slice(listStart, listEnd)).map((key) => {
    if (key.length !== 1) return key;
    const [token] = key;
    if (token.kind === 'number' && /^\d+$/.test(token.text)) {
      const item = items[Number(token.text) - 1];
      if (!item) throw new ConvertError(`GROUP BY ${token.text}: không có cột thứ ${token.text} trong danh sách SELECT.`, token.line);
      return item.expr;
    }
    const aliased = items.find((item) => item.alias?.toLowerCase() === token.text.toLowerCase());
    return aliased ? aliased.expr : key;
  });
  return [...body.slice(0, listStart), ...joinList(keys, body[groupAt].line), ...body.slice(listEnd)];
}

/** FoxPro lets HAVING refer to a column alias; T-SQL needs the aliased expression. */
function expandHavingAliases(body: Token[], items: SelectItem[]): Token[] {
  const havingAt = findTopLevel(body, (t) => isWord(t, 'HAVING'));
  if (havingAt < 0) return body;
  const endAt = findTopLevel(body, (t) => HAVING_END_WORDS.some((word) => isWord(t, word)), havingAt + 1);
  const end = endAt >= 0 ? endAt : body.length;
  const line = body[havingAt].line;

  const clause = body.slice(havingAt + 1, end).flatMap((token, i, all) => {
    const item = token.kind === 'ident' && !isPunct(all[i + 1], '(') ? items.find((it) => it.alias?.toLowerCase() === token.text.toLowerCase()) : undefined;
    return item ? [{ kind: 'punct', text: '(', line } as Token, ...item.expr, { kind: 'punct', text: ')', line } as Token] : [token];
  });
  return [...body.slice(0, havingAt + 1), ...clause, ...body.slice(end)];
}

// ---------- Statements ----------

function requireCursor(state: State, line: number): string {
  if (!state.currentCursor) throw new ConvertError('Chưa có cursor nào. Hãy chạy SELECT ... INTO CURSOR trước.', line);
  return state.currentCursor;
}

function convertBrowse(tokens: Token[], state: State): string {
  const line = tokens[0].line;
  const table = cursorTable(requireCursor(state, line));
  const rest = tokens.slice(1).filter((t) => !isWord(t, 'NOWAIT') && !isWord(t, 'LAST') && !isWord(t, 'NORMAL'));
  const forAt = findTopLevel(rest, (t) => isWord(t, 'FOR'));
  const fieldsAt = findTopLevel(rest, (t) => isWord(t, 'FIELDS'));
  const head = rest.slice(0, Math.min(...[forAt, fieldsAt].filter((n) => n >= 0), rest.length));
  if (head.length || (forAt >= 0 && fieldsAt > forAt)) {
    throw new ConvertError('BROWSE chỉ hỗ trợ dạng: BROWSE [FIELDS ...] [FOR ...].', line);
  }
  const fields = fieldsAt >= 0 ? rewrite(rest.slice(fieldsAt + 1, forAt >= 0 ? forAt : rest.length), state) : '*';
  const where = forAt >= 0 ? ` WHERE ${rewrite(rest.slice(forAt + 1), state, 'FOR')}` : '';
  return `SELECT ${fields} FROM ${table}${where}`;
}

function convertSelect(tokens: Token[], state: State): string {
  const line = tokens[0].line;
  let body = tokens.filter((t, i) => i === 0 || t.kind !== 'ident' || !IGNORED_CLAUSES.has(t.text.toUpperCase()));
  let cursor: string | undefined;

  const intoAt = findTopLevel(body, (t) => isWord(t, 'INTO'));
  if (intoAt >= 0) {
    const target = body[intoAt + 1];
    const name = body[intoAt + 2];
    if (!isWord(target, 'CURSOR')) {
      throw new ConvertError('Chỉ hỗ trợ INTO CURSOR (công cụ chỉ đọc, không tạo bảng hay mảng).', line);
    }
    if (name?.kind !== 'ident' || !/^\w+$/.test(name.text)) {
      throw new ConvertError('Thiếu tên cursor sau INTO CURSOR.', line);
    }
    cursor = name.text.toLowerCase();
    body = [...body.slice(0, intoAt), ...body.slice(intoAt + 3)];
  }

  const range = selectListRange(body);
  const items = splitList(body.slice(range.start, range.end)).map(parseSelectItem);
  body = expandHavingAliases(expandGroupBy(body, items), items);

  if (cursor) {
    // T-SQL wants INTO before FROM; FoxPro usually puts it at the end.
    const list = joinList(nameCursorColumns(items, line), line);
    const into = [raw('INTO', line), raw(cursorTable(cursor), line)];
    body = [...body.slice(0, range.start), ...list, ...into, ...body.slice(range.end)];
  }

  const sql = rewrite(body, state);
  if (!cursor) return sql;
  state.cursors.add(cursor);
  state.currentCursor = cursor;
  return `DROP TABLE IF EXISTS ${cursorTable(cursor)};\n${sql}`;
}

/** Returns T-SQL, or undefined for statements that only change converter state. */
function convertStatement({ tokens }: Statement, state: State): string | undefined {
  const head = tokens[0];
  state.line = head.line;
  state.tables = collectTables(tokens);
  if (isWord(head, 'BROWSE')) return convertBrowse(tokens, state);
  if (!isWord(head, 'SELECT')) {
    throw new ConvertError(`Lệnh ${head.text.toUpperCase()} chưa được hỗ trợ (chỉ SELECT và BROWSE).`, head.line);
  }
  // `SELECT name` on its own selects a work area in FoxPro.
  if (tokens.length === 2 && tokens[1].kind === 'ident') {
    const name = tokens[1].text.toLowerCase();
    if (!state.cursors.has(name)) throw new ConvertError(`Cursor ${tokens[1].text} chưa tồn tại.`, head.line);
    state.currentCursor = name;
    return undefined;
  }
  return convertSelect(tokens, state);
}

export function convertFoxPro(source: string, options: ConvertOptions = {}): ConvertResult {
  const warnings: Diagnostic[] = [];
  const state: State = {
    line: 1,
    dateStyle: options.dateStyle ?? 'dmy',
    ansi: options.ansi ?? false,
    resolveColumnKind: options.resolveColumnKind,
    tables: [],
    cursors: new Set([...(options.knownCursors ?? [])].map((c) => c.toLowerCase())),
    currentCursor: options.currentCursor?.toLowerCase(),
    warn: (message) => warnings.push({ line: state.line, message }),
  };

  const split = splitStatements(source);
  const errors: Diagnostic[] = split.errors.map((e) => ({ line: e.line, message: e.message }));
  const statements: ConvertedStatement[] = [];

  for (const statement of split.statements) {
    try {
      const sql = convertStatement(statement, state);
      if (sql !== undefined) statements.push({ line: statement.line, sql });
    } catch (e) {
      if (!(e instanceof ConvertError)) throw e;
      errors.push({ line: e.line, message: e.message });
    }
  }

  errors.sort((a, b) => a.line - b.line);
  return {
    sql: errors.length ? '' : statements.map((s) => s.sql).join(';\n'),
    statements,
    errors,
    warnings,
    cursors: [...state.cursors],
    currentCursor: state.currentCursor,
  };
}
