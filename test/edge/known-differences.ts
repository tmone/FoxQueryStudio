/**
 * Checks whose SQL Server result is known to differ from FoxPro, with the reason.
 * Keys are the labels built in edge.integration.test.ts: the expression itself,
 * `WHERE <condition>` or `WHERE NOT (<condition>)`.
 */

const COLUMN_TYPING = 'FoxPro fixes the width and decimals of a computed column up front and rounds or drops digits to fit; SQL Server keeps the exact value.';
const BLANK_VALUE_PATTERN = 'In FoxPro the blanks that pad a value may also be matched by the pattern, so an all-blank value matches `_`; the converter trims them all.';
const FIELD_WIDTH ='FoxPro compares up to the width of the narrower field; the converter does not know declared column widths.';

export const KNOWN_DIFFERENCES: Record<string, string> = {
  // 1234567.89 + 99999999 does not fit N(11,2), so FoxPro keeps one decimal.
  'n + nn': COLUMN_TYPING,
  // A division of two integer constants gets a column without decimals: 1/3 is 0, 10/4 is 3.
  '1 / 3': COLUMN_TYPING,
  '10 / 4': COLUMN_TYPING,
  'n ** 2': COLUMN_TYPING,
  // The column takes the type of the first argument, N(8,0), so 1.5 becomes 2.
  'NVL(nn, n)': COLUMN_TYPING,
  // The column is sized from the fallback of the first row; values that do not fit come back as NULL.
  'EVL(nn, -1)': COLUMN_TYPING,
  'EVL(i, 99)': COLUMN_TYPING,
  "WHERE c LIKE '_'": BLANK_VALUE_PATTERN,
  "WHERE NOT (c LIKE '_')": BLANK_VALUE_PATTERN,
  'WHERE c = cn': FIELD_WIDTH,
  'WHERE NOT (c = cn)': FIELD_WIDTH,
  "WHERE 'abcdefghijklmnopq' = c": FIELD_WIDTH,
  "WHERE NOT ('abcdefghijklmnopq' = c)": FIELD_WIDTH,
  "WHERE c = 'abcdefghijklmnop'": FIELD_WIDTH,
  "WHERE NOT (c = 'abcdefghijklmnop')": FIELD_WIDTH,
};
