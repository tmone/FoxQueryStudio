import * as vscode from 'vscode';
import { convertFoxPro, type ConvertResult } from '../../src/converter';
import { applyLeanLayout, applyLeanLayoutOnce, restoreDefaultLayout } from './layout';

const FOXSQL = 'foxsql';
const DIAGNOSTICS_SOURCE = 'FoxQuery';
/** Command of the mssql extension that runs the active editor's text on its connection. */
const MSSQL_RUN_QUERY = 'mssql.runQuery';

/**
 * Cursors live as #temp tables on the connection of the T-SQL document, which the
 * mssql extension keeps open per document URI; so one T-SQL document per FoxPro tab.
 */
interface QueryState {
  tsqlDoc: vscode.TextDocument;
  cursors: string[];
  currentCursor?: string;
}

const states = new Map<string, QueryState>();
/** FoxPro document the user worked in last, used when a webview or the T-SQL twin has focus. */
let lastFoxDoc: vscode.TextDocument | undefined;
let diagnostics: vscode.DiagnosticCollection;

function reportDiagnostics(doc: vscode.TextDocument, conversion: ConvertResult): void {
  const toDiagnostic = (line: number, message: string, severity: vscode.DiagnosticSeverity) => {
    const range = doc.lineAt(Math.min(line, doc.lineCount) - 1).range;
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = DIAGNOSTICS_SOURCE;
    return diagnostic;
  };
  diagnostics.set(doc.uri, [
    ...conversion.errors.map((d) => toDiagnostic(d.line, d.message, vscode.DiagnosticSeverity.Error)),
    ...conversion.warnings.map((d) => toDiagnostic(d.line, d.message, vscode.DiagnosticSeverity.Warning)),
  ]);
}

/** The T-SQL document paired with a FoxPro document, created beside it on first use. */
async function pairedDocument(foxDoc: vscode.TextDocument): Promise<QueryState> {
  const key = foxDoc.uri.toString();
  let state = states.get(key);
  if (!state || state.tsqlDoc.isClosed) {
    const tsqlDoc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    state = { tsqlDoc, cursors: [], currentCursor: undefined };
    states.set(key, state);
  }
  return state;
}

/** Shows the T-SQL twin in a group under the FoxPro editor, creating that group on first use. */
async function showBelow(doc: vscode.TextDocument, focus: boolean): Promise<void> {
  const open = vscode.window.visibleTextEditors.find((ed) => ed.document === doc);
  if (open) {
    await vscode.window.showTextDocument(doc, { viewColumn: open.viewColumn, preserveFocus: !focus, preview: false });
    return;
  }
  await vscode.commands.executeCommand('workbench.action.splitEditorDown');
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preserveFocus: !focus, preview: false });
  // splitEditorDown duplicates the FoxPro editor into the new group; drop that copy.
  await vscode.commands.executeCommand('workbench.action.closeOtherEditors');
}

async function replaceText(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, whole, text);
  await vscode.workspace.applyEdit(edit);
}

function activeFoxDocument(): vscode.TextDocument | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.languageId === FOXSQL) return doc;
  // The T-SQL side may be focused; find the FoxPro document it belongs to.
  for (const [key, state] of states) if (state.tsqlDoc === doc) return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  return lastFoxDoc && !lastFoxDoc.isClosed ? lastFoxDoc : undefined;
}

/** Converts the FoxPro document into its T-SQL twin and shows the twin beside it. */
async function convertToSide(foxDoc: vscode.TextDocument, focusTsql: boolean): Promise<{ state: QueryState; conversion: ConvertResult } | undefined> {
  const state = await pairedDocument(foxDoc);
  const conversion = convertFoxPro(foxDoc.getText(), { knownCursors: state.cursors, currentCursor: state.currentCursor });
  reportDiagnostics(foxDoc, conversion);
  if (conversion.errors.length) {
    void vscode.window.showErrorMessage(`FoxQuery: ${conversion.errors[0].message} (dòng ${conversion.errors[0].line})`);
    return undefined;
  }
  await replaceText(state.tsqlDoc, conversion.sql);
  await showBelow(state.tsqlDoc, focusTsql);
  return { state, conversion };
}

async function runQuery(): Promise<void> {
  const foxDoc = activeFoxDocument();
  if (!foxDoc) {
    void vscode.window.showInformationMessage('FoxQuery: mở một tệp FoxPro SQL (.fox) rồi nhấn F5.');
    return;
  }
  // mssql runs whatever editor is active, so the T-SQL twin must have focus.
  const converted = await convertToSide(foxDoc, true);
  if (!converted) return;
  if (!converted.conversion.sql) {
    void vscode.window.showInformationMessage('FoxQuery: không có lệnh nào cần gửi lên máy chủ.');
  } else {
    await vscode.commands.executeCommand(MSSQL_RUN_QUERY);
  }
  // The mssql extension does not report back; cursors are taken as created once sent.
  converted.state.cursors = converted.conversion.cursors;
  converted.state.currentCursor = converted.conversion.currentCursor;
}

async function showTsql(): Promise<void> {
  const foxDoc = activeFoxDocument();
  if (foxDoc) await convertToSide(foxDoc, false);
}

async function newQuery(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: FOXSQL, content: '' });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
}

export function activate(context: vscode.ExtensionContext): void {
  if (vscode.window.activeTextEditor?.document.languageId === FOXSQL) lastFoxDoc = vscode.window.activeTextEditor.document;
  diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTICS_SOURCE);
  void applyLeanLayoutOnce(context);
  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('foxquery.run', runQuery),
    vscode.commands.registerCommand('foxquery.showTsql', showTsql),
    vscode.commands.registerCommand('foxquery.newQuery', newQuery),
    vscode.commands.registerCommand('foxquery.applyLayout', applyLeanLayout),
    vscode.commands.registerCommand('foxquery.restoreLayout', restoreDefaultLayout),
    // Live conversion feedback while typing, without touching the twin.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== FOXSQL) return;
      const state = states.get(e.document.uri.toString());
      reportDiagnostics(e.document, convertFoxPro(e.document.getText(), { knownCursors: state?.cursors, currentCursor: state?.currentCursor }));
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === FOXSQL) lastFoxDoc = editor.document;
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      states.delete(doc.uri.toString());
    }),
  );
}

export function deactivate(): void {
  states.clear();
}
