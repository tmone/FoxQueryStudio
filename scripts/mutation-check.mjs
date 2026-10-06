// Proves the comparisons against real FoxPro detect wrong conversions: re-introduces one
// known semantic bug at a time and reports which test cases fail.
// Usage: node scripts/mutation-check.mjs   (restores the source files afterwards)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

mkdirSync('test-results', { recursive: true });

const FUNCTIONS = 'src/converter/functions.ts';
const INDEX = 'src/converter/index.ts';
const READER = 'src/dbf/reader.ts';
const HARNESS = 'test/support/harness.ts';
const TEST_FILES = ['test/northwind.integration.test.ts', 'test/edge.integration.test.ts'];
const REPORT = 'test-results/mutation-report.json';
const BACKUP = 'test-results/mutation-backup.json';
const MAX_LISTED = 4;

const MUTATIONS = [
  // Arithmetic
  { name: 'integer division', file: INDEX, from: "const DIVIDE_SQL = '* 1.0 /';", to: "const DIVIDE_SQL = '/';" },
  { name: 'AVG of an expression truncates', file: FUNCTIONS, from: 'return isPlain ? `AVG(${x})` : `AVG(1.0 * (${x}))`;', to: 'return `AVG(${x})`;' },
  { name: 'AVG of an integer field made decimal', file: FUNCTIONS, from: 'return isPlain ? `AVG(${x})` : `AVG(1.0 * (${x}))`;', to: 'return `AVG(1.0 * (${x}))`;' },
  { name: 'MOD keeps dividend sign', file: FUNCTIONS, from: '`(((${a}) % (${b}) + (${b})) % (${b}))`', to: '`((${a}) % (${b}))`' },
  { name: '% operator keeps dividend sign', file: INDEX, from: '`(((${left}) % (${right.unit.text}) + (${right.unit.text})) % (${right.unit.text}))`', to: '`((${left}) % (${right.unit.text}))`' },
  { name: 'power computed on integers', file: INDEX, from: '`POWER(CAST(${last.text} AS float), ', to: '`POWER(${last.text}, ' },
  { name: 'VAL rejects trailing text', file: FUNCTIONS, from: 'COALESCE(TRY_CAST(${prefix} AS float), 0)', to: 'TRY_CAST(${s} AS float)' },
  { name: 'VAL loses the minus sign', file: FUNCTIONS, from: "'%[^-0-9.]%'", to: "'%[^0-9.-]%'" },
  { name: 'STR rounds as binary float', file: FUNCTIONS, from: "const rounded = `ROUND(${x}, ${decimals ?? '0'})`;", to: 'const rounded = x;' },
  // Strings
  { name: 'LEN ignores trailing blanks', file: FUNCTIONS, from: "LEN: arity('LEN', 1, 1, ([x]) => `(LEN(${x} + N'.') - 1)`),", to: "LEN: arity('LEN', 1, 1, ([x]) => fn('LENGTH', x))," },
  { name: 'AT ignores case', file: FUNCTIONS, from: '`CHARINDEX(${search}, ${binaryText(s)})`', to: "fn('LOCATE', search, s)" },
  { name: '$ ignores case', file: FUNCTIONS, from: '`(CHARINDEX(${needle}, ${binaryText(haystack)}) > 0)`', to: '`(CHARINDEX(${needle}, ${haystack}) > 0)`' },
  { name: 'STRTRAN ignores case', file: FUNCTIONS, from: '`REPLACE(${binaryText(s)}, ${from}, ${to ?? "\'\'"}) COLLATE DATABASE_DEFAULT`', to: '`REPLACE(${s}, ${from}, ${to ?? "\'\'"})`' },
  { name: 'PADL keeps rightmost chars', file: FUNCTIONS, from: 'const kept = `LEFT(${asText(x)}, ${n})`;', to: 'const kept = `RIGHT(${asText(x)}, ${n})`;' },
  { name: 'PADL fill right-aligned', file: FUNCTIONS, from: "return `LEFT(REPLICATE(${pad ?? \"' '\"}, ${n}), ${n} - (LEN(${kept} + N'.') - 1)) + ${kept}`;", to: "return `RIGHT(REPLICATE(${pad ?? \"' '\"}, ${n}) + ${kept}, ${n})`;" },
  { name: 'NVL via ISNULL', file: FUNCTIONS, from: '`COALESCE(${unicodeLiteral(a)}, ${unicodeLiteral(b)})`', to: '`ISNULL(${a}, ${b})`' },
  { name: 'TRANSFORM of a date uses ISO format', file: FUNCTIONS, from: "const text = kind === 'date' ?", to: "const text = kind === 'datetime' ?" },
  { name: 'TRANSFORM of NULL stays NULL', file: FUNCTIONS, from: "return `COALESCE(${text}, '.NULL.')`;", to: 'return text;' },
  // String comparison
  { name: '= compares exactly instead of by prefix', file: INDEX, from: 'ansi: options.ansi ?? false,', to: 'ansi: options.ansi ?? true,' },
  { name: '> and <= ignore the prefix rule', file: INDEX, from: ", '>': 'gt', '<=': 'le' };", to: ' };' },
  { name: 'expression never the shorter side', file: FUNCTIONS, from: 'return isColumn ? startsWith :', to: 'return true ? startsWith :' },
  { name: 'column = expression compared in full', file: INDEX, from: "const hasStringSide = unit.kind === 'string' || subject?.kind === 'string';", to: 'const hasStringSide = false;' },
  { name: 'memo treated as fixed width', file: HARNESS, from: "C: 'string', V: 'varstring', M: 'varstring',", to: "C: 'string', V: 'string', M: 'string'," },
  { name: 'LIKE keeps trailing blanks', file: INDEX, from: "if (!t.text.endsWith('%') && units[subjectAt])", to: "if (false && !t.text.endsWith('%') && units[subjectAt])" },
  { name: 'LIKE reads [ as a character class', file: INDEX, from: "stringLiteral(t.text.replace(/\\[/g, '[[]'))", to: 'stringLiteral(t.text)' },
  // NULL and logical values
  { name: 'EMPTY true for a NULL number', file: FUNCTIONS, from: 'return `(${x} IS NOT NULL AND ${x} = 0)`;', to: 'return `(${x} IS NULL OR ${x} = 0)`;' },
  { name: 'EMPTY true for a NULL date', file: FUNCTIONS, from: "return '(1 = 0)';", to: 'return `(${x} IS NULL)`;' },
  { name: 'bare logical field not expanded', file: INDEX, from: "if (resolved === 'bool' && isBareCondition(tokens, i, lead))", to: "if (false && resolved === 'bool' && isBareCondition(tokens, i, lead))" },
  { name: 'logical constant left as a number', file: INDEX, from: 'if (LOGICAL_CONDITION[t.text] && isBareCondition(tokens, i, lead))', to: 'if (false && LOGICAL_CONDITION[t.text] && isBareCondition(tokens, i, lead))' },
  // Dates
  { name: 'date arithmetic left to T-SQL', file: INDEX, from: "(t.text === '+' || t.text === '-') && isDateKind(last?.kind)", to: "(t.text === '+' || t.text === '-') && false && isDateKind(last?.kind)" },
  { name: 'DOW off by one', file: FUNCTIONS, from: '`(DATEDIFF(day, ${REFERENCE_SUNDAY}, ${d}) % 7 + 1)`', to: '`(DATEDIFF(day, ${REFERENCE_SUNDAY}, ${d}) % 7)`' },
  { name: 'datetime seconds read 1 ms short', file: READER, from: 'const seconds = Math.round(raw.readInt32LE(4) / 1000);', to: 'const seconds = Math.floor(raw.readInt32LE(4) / 1000);' },
  // Statements
  { name: 'GROUP BY positions kept', file: INDEX, from: 'body = expandHavingAliases(expandGroupBy(body, items), items);', to: 'body = expandHavingAliases(body, items);' },
  { name: 'HAVING alias kept', file: INDEX, from: 'body = expandHavingAliases(expandGroupBy(body, items), items);', to: 'body = expandGroupBy(body, items);' },
  { name: 'cursor columns not named', file: INDEX, from: 'const list = joinList(nameCursorColumns(items, line), line);', to: 'const list = joinList(items.map((item) => (item.alias ? [...item.expr, raw("AS", line), raw(item.alias, line)] : item.expr)), line);' },
];

function failingCases() {
  rmSync(REPORT, { force: true });
  try {
    execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...TEST_FILES, '--reporter=json', `--outputFile=${REPORT}`], { stdio: 'ignore' });
  } catch {
    // A non-zero exit is the expected outcome of a caught mutation.
  }
  const report = JSON.parse(readFileSync(REPORT, 'utf8'));
  const tests = report.testResults.flatMap((f) => f.assertionResults);
  // A file-level failure (conversion crash) leaves no per-test results.
  const crashed = report.testResults.filter((f) => f.status === 'failed' && !f.assertionResults.length).map((f) => `whole file: ${f.message.split('\n')[0]}`);
  return [...crashed, ...tests.filter((a) => a.status === 'failed').map((a) => a.title)];
}

/** A killed run cannot reach its `finally`, so the original is also kept on disk until restored. */
function restoreBackup() {
  if (!existsSync(BACKUP)) return;
  const { file, original } = JSON.parse(readFileSync(BACKUP, 'utf8'));
  writeFileSync(file, original);
  rmSync(BACKUP);
  console.log(`Restored ${file} from an interrupted run.`);
}

restoreBackup();
// Optional range, so a long list can be run in parts: node scripts/mutation-check.mjs 0 12
const [first = 0, end = MUTATIONS.length] = process.argv.slice(2).map(Number);
const selected = MUTATIONS.slice(first, end);

let undetected = 0;
for (const mutation of selected) {
  const original = readFileSync(mutation.file, 'utf8');
  if (!original.includes(mutation.from)) {
    console.log(`SKIP    ${mutation.name}: source text not found`);
    undetected++;
    continue;
  }
  writeFileSync(BACKUP, JSON.stringify({ file: mutation.file, original }));
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
  try {
    const failed = failingCases();
    if (!failed.length) undetected++;
    const listed = failed.slice(0, MAX_LISTED).map((title) => `\n          ${title}`).join('');
    const more = failed.length > MAX_LISTED ? `\n          ... and ${failed.length - MAX_LISTED} more` : '';
    console.log(`${failed.length ? 'CAUGHT ' : 'MISSED '} ${mutation.name} (${failed.length} failing)${listed}${more}`);
  } finally {
    writeFileSync(mutation.file, original);
    rmSync(BACKUP, { force: true });
  }
}
console.log(`\n${selected.length - undetected} of ${selected.length} mutations caught`);
process.exitCode = undetected ? 1 : 0;
