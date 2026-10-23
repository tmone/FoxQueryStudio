/**
 * The browser bundle for other hosts (the CnB legacy web): everything that turns what a user
 * types into T-SQL, with no Electron, Node or SQL in it. The host runs the T-SQL itself.
 *
 * Built by `npm run build:xbase` into dist/lv.xbase.js as the global `lvXBase`.
 */
export { convertFoxPro, createColumnResolver, FOXPRO_FUNCTIONS } from '../converter';
export { convertTsql } from '../converter/reverse';
export { columnKindResolver, columnWidthResolver } from '../shared/column-kind';
export { applyParameters, findParameters, tableFor } from '../shared/fox-prepare';
export { COUNT_LABEL, mismatchHint, readOnlyViolation, splitStatements, splitTopLevel, toRunnable } from '../shared/fox-statements';
export { cursorNameFor, execStatement, execTemplate, parseExec, splitExecSegments, sqlLiteral, tsqlViolation, withoutExecLines } from '../shared/procedures';
export { runFoxQuery, runTsqlQuery } from '../shared/run-query';
export type { QuerySession } from '../shared/run-query';
export type { ExecuteResult, SchemaTable } from '../shared/types';

/** Version of the logic, for the host to show and for support to ask about. */
export const VERSION = __XBASE_VERSION__;

declare const __XBASE_VERSION__: string;
