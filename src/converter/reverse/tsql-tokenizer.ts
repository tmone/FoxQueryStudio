import { ConvertError, type Token } from '../tokenizer';

export type { Token };

const NUMBER = /^(\d+(\.\d+)?|\.\d+)/;
const IDENT = /^[A-Za-z_#@À-￿][\wÀ-￿$]*/;
const OPERATORS = ['<>', '!=', '<=', '>=', '!<', '!>', '=', '<', '>', '+', '-', '*', '/', '%'];
const PUNCT = '(),;.{}';

/** Splits a T-SQL batch into tokens. Comments are dropped; a date literal never appears, T-SQL has none. */
export function tokenizeTsql(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const text = source;

  const push = (kind: Token['kind'], value: string) => tokens.push({ kind, text: value, line });

  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new ConvertError('Chú thích /* chưa đóng.', line);
      line += (text.slice(i, end).match(/\n/g) ?? []).length;
      i = end + 2;
      continue;
    }

    // N'...' and '...' with '' as the escaped quote.
    if (ch === "'" || (ch === 'N' && text[i + 1] === "'")) {
      let at = ch === 'N' ? i + 2 : i + 1;
      let value = '';
      for (;;) {
        const end = text.indexOf("'", at);
        if (end < 0) throw new ConvertError('Chuỗi chưa đóng dấu nháy.', line);
        value += text.slice(at, end);
        if (text[end + 1] === "'") {
          value += "'";
          at = end + 2;
          continue;
        }
        line += (value.match(/\n/g) ?? []).length;
        i = end + 1;
        break;
      }
      push('string', value);
      continue;
    }

    // "..." is a quoted identifier in T-SQL (QUOTED_IDENTIFIER ON), not a string.
    if (ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : '"';
      const end = text.indexOf(close, i + 1);
      if (end < 0) throw new ConvertError(`Thiếu dấu ${close} đóng tên định danh.`, line);
      let name = `[${text.slice(i + 1, end)}]`;
      i = end + 1;
      for (;;) {
        const next = /^\.(\[[^\]]*\]|"[^"]*"|[A-Za-z_À-￿][\wÀ-￿$]*|\*)/.exec(text.slice(i));
        if (!next) break;
        name += next[0].replace(/^\."([^"]*)"$/, '.[$1]');
        i += next[0].length;
      }
      push('ident', name);
      continue;
    }

    const num = NUMBER.exec(rest);
    if (num) {
      push('number', num[0]);
      i += num[0].length;
      continue;
    }

    const ident = IDENT.exec(rest);
    if (ident) {
      let name = ident[0];
      // Absorb dotted parts (alias.column, dbo.table, alias.*) into one token.
      for (;;) {
        const tail = text.slice(i + name.length);
        if (tail[0] !== '.') break;
        if (tail[1] === '*') {
          name += '.*';
          break;
        }
        const next = /^\.(\[[^\]]*\]|"[^"]*"|[A-Za-z_À-￿][\wÀ-￿$]*)/.exec(tail);
        if (!next) break;
        name += next[0].replace(/^\."([^"]*)"$/, '.[$1]');
      }
      push('ident', name);
      i += name.length;
      continue;
    }

    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      push('op', op);
      i += op.length;
      continue;
    }
    if (PUNCT.includes(ch)) {
      push('punct', ch);
      i++;
      continue;
    }
    throw new ConvertError(`Ký tự không hợp lệ: ${ch}`, line);
  }
  return tokens;
}

/** Splits tokens into statements at top-level semicolons, dropping empty ones. */
export function splitTsqlStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'punct' && t.text === '(') depth++;
    else if (t.kind === 'punct' && t.text === ')') depth--;
    if (depth === 0 && t.kind === 'punct' && t.text === ';') statements.push([]);
    else statements[statements.length - 1].push(t);
  }
  return statements.filter((s) => s.length);
}
