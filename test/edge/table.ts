// A small FoxPro table packed with boundary values: blanks, NULLs, negatives, leap days,
// accented text, LIKE wildcards, values that fill a field completely. FoxPro itself
// creates it, so the .dbf is exactly what a FoxPro application would have written.

/** FoxPro program that creates edge.dbf in the current directory. */
export const CREATE_EDGE_TABLE = `
SET SAFETY OFF
CREATE TABLE edge FREE CODEPAGE = 1252 ( ;
  id I, c C(12), cn C(8) NULL, v V(10) NULL, n N(10,2), nn N(8,0) NULL, ;
  i I, inn I NULL, y Y, d D, dn D NULL, t T NULL, l L, m M)
INSERT INTO edge VALUES (1, 'abc', 'x', 'var', 0, 0, 0, 0, $0, {^2026-01-31}, {^2024-02-29}, {^2026-01-31 10:30:15}, .T., 'memo one')
INSERT INTO edge VALUES (2, 'ABC', .NULL., .NULL., 1.5, .NULL., 1, .NULL., $1.5, {^1999-12-31}, .NULL., .NULL., .F., '')
INSERT INTO edge VALUES (3, '', '', '', -2.5, -3, -7, -7, -$2.5, {^2024-02-29}, {^2000-01-01}, {^2000-01-01 00:00:00}, .T., 'line one' + CHR(13) + CHR(10) + 'line two')
INSERT INTO edge VALUES (4, '  lead', 'ab', 'ab  ', 2.345, 12, 7, 7, $2.345, {^2025-03-31}, {^2025-12-31}, {^2025-12-31 23:59:59}, .F., 'The Quick brown fox')
INSERT INTO edge VALUES (5, 'mid dle', 'AB', 'x', 1234567.89, 99999999, 100, 100, $1234567.8912, {^2026-10-05}, {^2026-10-05}, {^2026-10-05 12:00:00}, .T., 'abcABCabc')
INSERT INTO edge VALUES (6, 'Äöü ß', 'äb', 'Ä', 0.01, 1, 2, 3, $0.0001, {^2023-12-31}, {^2024-01-01}, {^2024-01-01 06:07:08}, .F., 'ß')
INSERT INTO edge VALUES (7, "o'neil", 'x y', "it's", -0.5, -1, -1, -1, -$0.5, {^2026-02-28}, {^2026-03-01}, {^2026-03-01 01:02:03}, .T., 'no quotes')
INSERT INTO edge VALUES (8, '12abc', '7', '-3.7x', 12, 12, 12, 12, $12, {^2026-01-01}, {^2026-01-01}, {^2026-01-01 00:00:00}, .F., '100% a_b [x]')
INSERT INTO edge VALUES (9, '100%', 'a_b', '[x]', 99.99, 100, 99, 99, $99.99, {^2026-12-31}, {^2027-01-01}, {^2026-12-31 23:59:59}, .T., '')
INSERT INTO edge VALUES (10, 'abcdefghijkl', 'abcdefgh', 'abcdefghij', 0.5, 0, 0, 0, $0.5, {^2026-06-15}, .NULL., {^2026-06-15 13:14:15}, .F., 'x')
INSERT INTO edge VALUES (11, 'ABCdef', 'Ab', 'aB', 7, 7, 3, 3, $7, {^2026-01-30}, {^2026-01-31}, {^2026-01-30 00:00:01}, .T., 'ABC')
INSERT INTO edge VALUES (12, '-3.7', '', '', -1234.56, -100, -100, -100, -$1234.56, {^2020-02-29}, {^2021-02-28}, {^2020-02-29 12:00:00}, .F., '')
USE IN edge
QUIT
`;
