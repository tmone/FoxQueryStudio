export type TokenKind = 'string' | 'number' | 'ident' | 'date' | 'logical' | 'op' | 'punct' | 'raw';

export interface Token {
  kind: TokenKind;
  /** Source text; for strings and dates this is the content without delimiters. */
  text: string;
  line: number;
}

export class ConvertError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
  }
}

const LOGICAL = /^\.(T|F|Y|N|NULL|AND|OR|NOT)\./i;
const NUMBER = /^(\d+(\.\d+)?|\.\d+)/;
const CURRENCY = /^\$(\d+(?:\.\d+)?|\.\d+)/;
const IDENT_START = /[A-Za-z_@À-￿]/;
const IDENT = /^[A-Za-z_@À-￿][\wÀ-￿]*/;
const OPERATORS = ['==', '<>', '!=', '<=', '>=', '**', '=', '<', '>', '+', '-', '*', '/', '%', '^', '!', '#', '$'];
const PUNCT = '(),;{}.?:';

/**
 * Tokenizes one physical line. FoxPro strings cannot span lines, so the caller
 * joins continuation lines at the token level.
 */
export function tokenizeLine(text: string, line: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (rest.startsWith('&&')) break; // inline comment

    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) throw new ConvertError('Chuỗi chưa đóng dấu nháy.', line);
      tokens.push({ kind: 'string', text: text.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }

    // Square brackets are kept as SQL Server quoted identifiers, not FoxPro strings.
    if (ch === '[') {
      const end = text.indexOf(']', i + 1);
      if (end < 0) throw new ConvertError('Thiếu dấu ] đóng tên định danh.', line);
      tokens.push({ kind: 'ident', text: text.slice(i, end + 1), line });
      i = end + 1;
      continue;
    }

    if (ch === '{') {
      const end = text.indexOf('}', i + 1);
      const inner = end < 0 ? '' : text.slice(i + 1, end).trim();
      if (end >= 0 && (inner.startsWith('^') || /^[\s/.:-]*$/.test(inner))) {
        tokens.push({ kind: 'date', text: inner, line });
        i = end + 1;
        continue;
      }
      if (end >= 0 && /^\d/.test(inner)) {
        throw new ConvertError('Hằng ngày phải viết dạng {^yyyy-mm-dd}.', line);
      }
    }

    const logical = LOGICAL.exec(rest);
    if (logical) {
      tokens.push({ kind: 'logical', text: logical[1].toUpperCase(), line });
      i += logical[0].length;
      continue;
    }

    // $12.50 is a currency literal; a $ followed by anything else is the substring operator.
    const currency = CURRENCY.exec(rest);
    if (currency) {
      tokens.push({ kind: 'number', text: currency[1], line });
      i += currency[0].length;
      continue;
    }

    const num = NUMBER.exec(rest);
    if (num) {
      tokens.push({ kind: 'number', text: num[0], line });
      i += num[0].length;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let ident = IDENT.exec(rest)![0];
      // Absorb dotted parts (alias.column, schema.table, alias.*) into one token.
      for (;;) {
        const tail = text.slice(i + ident.length);
        if (tail[0] !== '.' || LOGICAL.test(tail)) break;
        if (tail[1] === '*') {
          ident += '.*';
          break;
        }
        const next = /^\.(\[[^\]]*\]|[A-Za-z_À-￿][\wÀ-￿]*)/.exec(tail);
        if (!next) break;
        ident += next[0];
      }
      tokens.push({ kind: 'ident', text: ident, line });
      i += ident.length;
      continue;
    }

    if (ch === '&') {
      throw new ConvertError('Macro (&biến) chưa được hỗ trợ.', line);
    }

    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      tokens.push({ kind: 'op', text: op, line });
      i += op.length;
      continue;
    }

    if (PUNCT.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch, line });
      i++;
      continue;
    }

    throw new ConvertError(`Ký tự không hợp lệ: ${ch}`, line);
  }
  return tokens;
}

export interface Statement {
  line: number;
  tokens: Token[];
}

/** Splits source into logical statements, honoring `;` line continuation and comments. */
export function splitStatements(source: string): { statements: Statement[]; errors: ConvertError[] } {
  const statements: Statement[] = [];
  const errors: ConvertError[] = [];
  let pending: Token[] = [];
  let failed = false;

  const flush = () => {
    if (pending.length && !failed) statements.push({ line: pending[0].line, tokens: pending });
    pending = [];
    failed = false;
  };

  source.split(/\r?\n/).forEach((text, index) => {
    const line = index + 1;
    // A leading `*` is a comment only at the start of a statement.
    if (!pending.length && !failed && text.trimStart().startsWith('*')) return;

    let tokens: Token[];
    try {
      tokens = tokenizeLine(text, line);
    } catch (e) {
      errors.push(e as ConvertError);
      failed = true;
      tokens = [];
    }

    const last = tokens[tokens.length - 1];
    const continues = last?.kind === 'punct' && last.text === ';';
    if (continues) tokens.pop();
    pending.push(...tokens);
    if (!continues) flush();
  });
  flush();

  return { statements, errors };
}
