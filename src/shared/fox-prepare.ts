import { FOXPRO_FUNCTIONS } from '../converter/functions';
import { splitStatements } from './fox-statements';
import type { SchemaTable } from './types';

/**
 * Makes a batch typed the way payroll checks are written at customers runnable as is:
 *
 * - `SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/Công chế độ*HSL` names a value, not a field:
 *   a phrase with Vietnamese letters is a parameter; the user is asked for its value
 *   (remembered for the next run) and it is put in the statement in parentheses.
 * - There is no USE: the table is the one whose columns cover every field the check
 *   names; it is opened before the batch when the tab has no current table or cursor.
 */

/** Commands that read the current work area. */
const WORK_AREA_COMMANDS = /^\s*(SUM|AVERAGE|CALCULATE|COUNT|BROWSE)\b/i;
const OPENS_TABLE = /^\s*(USE)\b/i;
/** Words of these commands that are never field names. */
const COMMAND_WORDS = new Set(['SUM', 'AVERAGE', 'CALCULATE', 'COUNT', 'BROWSE', 'FIELDS', 'FOR', 'WHILE', 'ALL', 'NEXT', 'RECORD', 'REST', 'TO', 'ARRAY', 'NOOPTIMIZE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'NULL', 'TRUE', 'FALSE']);
const FUNCTIONS = new Set(FOXPRO_FUNCTIONS.map((f) => f.toUpperCase()));
/** A word with at least one letter outside ASCII (Vietnamese diacritics) is never a FoxPro name. */
const VIETNAMESE_WORD = /[^\x00-\x7F]/;
/** Phrases: words with letters, joined by single spaces; checked for Vietnamese letters afterwards. */
const PHRASE = /[\p{L}_][\p{L}\p{N}_]*(?: [\p{L}_][\p{L}\p{N}_]*)*/gu;
const IDENTIFIER = /\b[A-Za-z_]\w*\b/g;

/** Text outside string literals, with literals replaced by spaces of the same length, so positions hold. */
function outsideStrings(text: string): string {
  return text.replace(/"[^"]*"|'[^']*'|\[[^\]]*\]/g, (literal) => ' '.repeat(literal.length));
}

/** The parameter phrases of the batch, in order of first appearance, outside strings and comments. */
export function findParameters(source: string): string[] {
  const names: string[] = [];
  for (const statement of splitStatements(source)) {
    for (const match of outsideStrings(statement).matchAll(PHRASE)) {
      const words = match[0].split(' ');
      // The phrase is the longest run of Vietnamese words; plain words around it are fields or keywords.
      let run: string[] = [];
      const flush = () => {
        const phrase = run.join(' ');
        if (phrase && !names.includes(phrase)) names.push(phrase);
        run = [];
      };
      for (const word of words) (VIETNAMESE_WORD.test(word) ? run.push(word) : flush());
      flush();
    }
  }
  return names;
}

/** The batch with every parameter replaced by its value, in parentheses so operators around it keep their meaning. */
export function applyParameters(source: string, values: Record<string, string>): string {
  let result = source;
  // Longer phrases first, so a phrase that contains another is not cut by the shorter one.
  for (const [name, value] of Object.entries(values).sort((a, b) => b[0].length - a[0].length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), `(${value.trim()})`);
  }
  return result;
}

/** Field names a statement that reads the current work area refers to, lower-cased. */
function fieldsOf(statement: string): string[] {
  const text = outsideStrings(statement.replace(/^\s*\w+/, ''));
  const names = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const word = match[0];
    const upper = word.toUpperCase();
    const followedByParen = /^\s*\(/.test(text.slice(match.index! + word.length));
    if (COMMAND_WORDS.has(upper) || FUNCTIONS.has(upper) || followedByParen || /^\d/.test(word)) continue;
    names.add(word.toLowerCase());
  }
  return [...names];
}

export interface TableChoice {
  table?: string;
  /** Why no table could be chosen. */
  error?: string;
}

/**
 * The table to open for a batch of work-area commands without USE: the one whose columns
 * cover every field named. `undefined` table and no error means the batch needs none.
 */
export function tableFor(source: string, tables: SchemaTable[]): TableChoice {
  const statements = splitStatements(source);
  if (statements.some((s) => OPENS_TABLE.test(s))) return {};
  const readers = statements.filter((s) => WORK_AREA_COMMANDS.test(s));
  if (!readers.length) return {};
  const fields = [...new Set(readers.flatMap(fieldsOf))];
  if (!fields.length) return { error: 'Không biết chạy trên bảng nào: hãy USE bảng trước, hoặc nêu tên cột trong lệnh.' };
  const matches = tables.filter((t) => {
    const columns = new Set(t.columns.map((c) => c.name.toLowerCase()));
    return fields.every((f) => columns.has(f));
  });
  if (matches.length === 1) return { table: matches[0].name };
  if (!matches.length) return { error: `Không có bảng nào có đủ các cột ${fields.join(', ')}; hãy USE bảng trước.` };
  return { error: `Nhiều bảng có đủ các cột ${fields.join(', ')}: ${matches.map((t) => t.name).join(', ')}. Hãy USE bảng muốn kiểm tra trước.` };
}

export interface PrepareOptions {
  tables: SchemaTable[];
  /** True when the tab already has a current table or cursor, so no table needs choosing. */
  hasWorkArea: boolean;
  /** Asks the user for a parameter's value; undefined cancels the run. */
  ask(name: string): Promise<string | undefined>;
}

export interface PreparedBatch {
  source: string;
  /** What was done for the user, in the order it happened. */
  notes: string[];
  /** Set when the batch cannot run; `cancelled` when the user declined a parameter. */
  error?: string;
  cancelled?: boolean;
}

export async function prepareFoxBatch(source: string, options: PrepareOptions): Promise<PreparedBatch> {
  const notes: string[] = [];
  const values: Record<string, string> = {};
  for (const name of findParameters(source)) {
    const value = await options.ask(name);
    if (value === undefined || !value.trim()) return { source, notes, cancelled: true };
    values[name] = value;
    notes.push(`${name} = ${value.trim()}`);
  }
  let prepared = applyParameters(source, values);
  if (!options.hasWorkArea) {
    const choice = tableFor(prepared, options.tables);
    if (choice.error) return { source: prepared, notes, error: choice.error };
    if (choice.table) {
      prepared = `USE ${choice.table}\n${prepared}`;
      notes.push(`Đã mở bảng ${choice.table} (có đủ các cột của lệnh).`);
    }
  }
  return { source: prepared, notes };
}
