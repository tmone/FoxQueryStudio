import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { FOXPRO_FUNCTIONS } from '../../converter';
import type { SchemaTable } from '../../shared/types';

export { monaco };

export const LANGUAGE_ID = 'foxpro';
/** Monaco's own SQL language, used for T-SQL. */
export const TSQL_LANGUAGE_ID = 'sql';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INTO', 'CURSOR', 'ORDER', 'GROUP', 'BY', 'HAVING', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'FULL', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL', 'DISTINCT', 'TOP', 'UNION',
  'ALL', 'ASC', 'DESC', 'BROWSE', 'FIELDS', 'FOR', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'READWRITE',
];
const AGGREGATES = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];
const FUNCTIONS = [...new Set([...FOXPRO_FUNCTIONS, ...AGGREGATES, 'IIF', 'STR', 'ROUND', 'ABS', 'SPACE', 'REPLICATE'])];

let schema: SchemaTable[] = [];

export function setSchema(tables: SchemaTable[]): void {
  schema = tables;
}

/** Quotes a name with brackets only when SQL Server requires it. */
export function quoteName(name: string): string {
  return /^[A-Za-z_][\w]*$/.test(name) ? name : `[${name.replace(/]/g, ']]')}]`;
}

/** FoxPro tables have no schema and are written by name alone. */
export const qualifiedName = (table: SchemaTable) => (table.schema ? `${quoteName(table.schema)}.${quoteName(table.name)}` : quoteName(table.name));

export const displayName = (table: SchemaTable) => (table.schema ? `${table.schema}.${table.name}` : table.name);

const bareName = (name: string) => name.split('.').pop()!.replace(/[[\]]/g, '').toLowerCase();

/** Finds the table a qualifier refers to: a table name or an alias declared after FROM/JOIN. */
function resolveTable(source: string, qualifier: string): SchemaTable | undefined {
  const wanted = qualifier.toLowerCase();
  let target = wanted;
  for (const match of source.matchAll(/\b(?:FROM|JOIN)\s+([\w.[\]]+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    if (match[2]?.toLowerCase() === wanted) target = bareName(match[1]);
  }
  return schema.find((t) => t.name.toLowerCase() === target);
}

function registerLanguage(): void {
  monaco.languages.register({ id: LANGUAGE_ID });

  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: '&&' },
    brackets: [['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: "'", close: "'", notIn: ['string'] },
      { open: '"', close: '"', notIn: ['string'] },
    ],
  });

  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
    ignoreCase: true,
    keywords: KEYWORDS,
    functions: FUNCTIONS,
    tokenizer: {
      root: [
        [/^\s*\*.*$/, 'comment'],
        [/&&.*$/, 'comment'],
        [/\{\^[^}]*\}/, 'number'],
        [/\.(T|F|Y|N|NULL|AND|OR|NOT)\./, 'keyword'],
        [/'[^']*'/, 'string'],
        [/"[^"]*"/, 'string'],
        [/\d+(\.\d+)?/, 'number'],
        [
          /[a-zA-Z_@À-￿][\wÀ-￿]*/,
          { cases: { '@keywords': 'keyword', '@functions': 'predefined', '@default': 'identifier' } },
        ],
        [/[=<>!#$+\-*/%]+/, 'operator'],
        [/[;,.()]/, 'delimiter'],
      ],
    },
  });

  // Tables and columns are offered in both languages; the T-SQL side is Monaco's own SQL language.
  monaco.languages.registerCompletionItemProvider([LANGUAGE_ID, TSQL_LANGUAGE_ID], {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
      const { CompletionItemKind: Kind, CompletionItemInsertTextRule: Rule } = monaco.languages;

      const columnItems = (table: SchemaTable) =>
        table.columns.map((c) => ({
          label: c.name,
          kind: Kind.Field,
          detail: `${c.display ?? c.dataType} · ${table.name}`,
          insertText: quoteName(c.name),
          range,
        }));

      const qualifier = /([\wÀ-￿]+)\.$/.exec(before)?.[1];
      if (qualifier) {
        const table = resolveTable(model.getValue(), qualifier);
        if (table) return { suggestions: columnItems(table) };
        // A schema qualifier: offer the tables inside it.
        const inSchema = schema.filter((t) => t.schema.toLowerCase() === qualifier.toLowerCase());
        return { suggestions: inSchema.map((t) => ({ label: t.name, kind: Kind.Struct, insertText: quoteName(t.name), range })) };
      }

      const source = model.getValue();
      const referenced = schema.filter((t) => new RegExp(`\\b${t.name.replace(/[^\w]/g, '.')}\\b`, 'i').test(source));
      return {
        suggestions: [
          ...KEYWORDS.map((k) => ({ label: k, kind: Kind.Keyword, insertText: k, range })),
          ...FUNCTIONS.map((f) => ({
            label: f,
            kind: Kind.Function,
            insertText: `${f}($0)`,
            insertTextRules: Rule.InsertAsSnippet,
            range,
          })),
          ...schema.map((t) => ({
            label: displayName(t),
            kind: t.isView ? Kind.Interface : Kind.Struct,
            detail: t.isView ? 'view' : 'bảng',
            insertText: qualifiedName(t),
            range,
          })),
          ...referenced.flatMap(columnItems),
        ],
      };
    },
  });
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const themeName = () => (darkQuery.matches ? 'vs-dark' : 'vs');

const editorOptions = (): monaco.editor.IStandaloneEditorConstructionOptions => ({
  theme: themeName(),
  automaticLayout: true,
  fontFamily: "Consolas, 'Cascadia Mono', monospace",
  fontSize: 14,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  tabSize: 2,
});

export function createEditor(host: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  registerLanguage();
  darkQuery.addEventListener('change', () => monaco.editor.setTheme(themeName()));
  return monaco.editor.create(host, { ...editorOptions(), model: null });
}

/** The read-only column that shows the translation next to the source. */
export function createCompareEditor(host: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(host, { ...editorOptions(), value: '', language: TSQL_LANGUAGE_ID, readOnly: true, domReadOnly: true, wordWrap: 'on' });
}

export const createModel = (text: string, languageId: string) => monaco.editor.createModel(text, languageId);
