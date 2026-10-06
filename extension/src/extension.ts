import * as vscode from 'vscode';
import { convertFoxPro, type ConvertResult } from '../../src/converter';
import { convertTsql } from '../../src/converter/reverse';
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
const LANGUAGE_LABELS = { foxsql: 'FOX-SQL', sql: 'T-SQL' } as const;
let languageItem: vscode.StatusBarItem;
const trace = (message: string) => console.log(`[FoxQuery] ${message}`);
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

const GROUP_FOCUS_COMMANDS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'].map((n) => `workbench.action.focus${n}EditorGroup`);
const DOCK_POLL_MS = 250;
const DOCK_TIMEOUT_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const holdsDocument = (group: vscode.TabGroup, doc: vscode.TextDocument) =>
  group.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === doc.uri.toString());

/** The FoxPro document whose twin is `sqlDoc`, if any. */
function foxDocumentOf(sqlDoc: vscode.TextDocument): vscode.TextDocument | undefined {
  for (const [key, state] of states) if (state.tsqlDoc === sqlDoc) return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  return undefined;
}

/**
 * Turns a developer's T-SQL document into the twin of a new FoxPro document, so the
 * FoxPro side can be read, edited and run (the run goes through this very T-SQL document).
 */
async function pairFromTsql(sqlDoc: vscode.TextDocument): Promise<vscode.TextDocument | undefined> {
  const existing = foxDocumentOf(sqlDoc);
  if (existing && !existing.isClosed) return existing;
  const conversion = convertTsql(sqlDoc.getText());
  const toDiagnostic = (d: { line: number; message: string }, severity: vscode.DiagnosticSeverity) => {
    const diagnostic = new vscode.Diagnostic(sqlDoc.lineAt(Math.min(d.line, sqlDoc.lineCount) - 1).range, d.message, severity);
    diagnostic.source = DIAGNOSTICS_SOURCE;
    return diagnostic;
  };
  diagnostics.set(sqlDoc.uri, [
    ...conversion.errors.map((d) => toDiagnostic(d, vscode.DiagnosticSeverity.Error)),
    ...conversion.warnings.map((d) => toDiagnostic(d, vscode.DiagnosticSeverity.Warning)),
  ]);
  if (conversion.errors.length) {
    void vscode.window.showErrorMessage(`FoxQuery: không chuyển được sang FoxPro: ${conversion.errors[0].message} (dòng ${conversion.errors[0].line})`);
    return undefined;
  }
  const foxDoc = await vscode.workspace.openTextDocument({ language: FOXSQL, content: conversion.foxpro });
  states.set(foxDoc.uri.toString(), { tsqlDoc: sqlDoc, cursors: conversion.cursors, currentCursor: conversion.cursors[conversion.cursors.length - 1] });
  return foxDoc;
}

/** Shows the FoxPro document in the top group and its twin below it. */
async function showPair(foxDoc: vscode.TextDocument, focus: 'fox' | 'tsql'): Promise<void> {
  const state = await pairedDocument(foxDoc);
  // A T-SQL file the developer opened sits in the top group; it has to move down so the
  // FoxPro document can take its place instead of hiding behind it.
  const twinGroup = vscode.window.tabGroups.all.find((g) => holdsDocument(g, state.tsqlDoc));
  if (twinGroup?.viewColumn === vscode.ViewColumn.One) {
    await vscode.window.showTextDocument(state.tsqlDoc, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
  }
  await vscode.window.showTextDocument(foxDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, preview: false });
  if (focus === 'tsql') await showBelow(state.tsqlDoc, true);
}

/** The language label in the status bar: what the active editor is written in. */
function renderLanguageItem(): void {
  const doc = vscode.window.activeTextEditor?.document;
  const language = doc?.languageId === FOXSQL ? 'foxsql' : doc?.languageId === 'sql' ? 'sql' : undefined;
  if (!language) {
    languageItem.hide();
    return;
  }
  const other = language === 'foxsql' ? LANGUAGE_LABELS.sql : LANGUAGE_LABELS.foxsql;
  languageItem.text = `$(arrow-swap) ${LANGUAGE_LABELS[language]}`;
  languageItem.tooltip = `Đang viết ${LANGUAGE_LABELS[language]}. Nhấn để xem bản ${other}.`;
  languageItem.show();
}

/** Switches between the FoxPro and T-SQL views of the same query, pairing a plain T-SQL document first. */
async function switchLanguage(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) return;
  if (doc.languageId === FOXSQL) {
    await convertToSide(doc, true);
    return;
  }
  if (doc.languageId !== 'sql') return;
  const foxDoc = foxDocumentOf(doc) ?? (await pairFromTsql(doc));
  if (foxDoc) await showPair(foxDoc, 'fox');
}

/** Side-by-side comparison of a query in both languages, in the diff editor. */
async function compareLanguages(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc) return;
  let foxDoc: vscode.TextDocument | undefined;
  if (doc.languageId === FOXSQL) {
    foxDoc = doc;
    if (!(await convertToSide(doc, false))) return;
  } else if (doc.languageId === 'sql') {
    foxDoc = foxDocumentOf(doc) ?? (await pairFromTsql(doc));
  }
  if (!foxDoc) return;
  const state = await pairedDocument(foxDoc);
  await vscode.commands.executeCommand('vscode.diff', foxDoc.uri, state.tsqlDoc.uri, 'FOX-SQL ↔ T-SQL', { preview: false });
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
  // The twin may sit behind the results tab, so look at tabs rather than visible editors.
  const group = vscode.window.tabGroups.all.find((g) => holdsDocument(g, doc));
  if (group) {
    await vscode.window.showTextDocument(doc, { viewColumn: group.viewColumn, preserveFocus: !focus, preview: false });
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

/**
 * mssql opens its results beside the T-SQL twin, as a third group. Pull that tab into
 * the twin's group so the lower half is one tab strip: T-SQL and results.
 */
async function dockResultsWithTwin(foxDoc: vscode.TextDocument, state: QueryState): Promise<void> {
  for (let waited = 0; waited < DOCK_TIMEOUT_MS; waited += DOCK_POLL_MS) {
    const groups = vscode.window.tabGroups.all;
    const twinGroup = groups.find((g) => holdsDocument(g, state.tsqlDoc));
    const strayGroup = groups.find((g) => g !== twinGroup && !holdsDocument(g, foxDoc) && g.tabs.some((t) => t.input instanceof vscode.TabInputWebview));
    if (twinGroup && strayGroup) {
      await vscode.commands.executeCommand(GROUP_FOCUS_COMMANDS[strayGroup.viewColumn - 1]);
      // Groups are stacked, so move by order rather than by left/right.
      await vscode.commands.executeCommand(strayGroup.viewColumn > twinGroup.viewColumn ? 'workbench.action.moveEditorToPreviousGroup' : 'workbench.action.moveEditorToNextGroup');
      return;
    }
    await sleep(DOCK_POLL_MS);
  }
}

async function runQuery(): Promise<void> {
  const foxDoc = activeFoxDocument();
  if (!foxDoc) {
    void vscode.window.showInformationMessage('FoxQuery: mở một tệp FoxPro SQL (.fox) rồi nhấn F5.');
    return;
  }
  // mssql runs whatever editor is active, so the T-SQL twin must have focus.
  trace(`run: ${foxDoc.uri.toString()}`);
  const converted = await convertToSide(foxDoc, true);
  if (!converted) return;
  trace(`twin shown, active=${vscode.window.activeTextEditor?.document.uri.toString()}`);
  if (!converted.conversion.sql) {
    void vscode.window.showInformationMessage('FoxQuery: không có lệnh nào cần gửi lên máy chủ.');
  } else {
    await vscode.commands.executeCommand(MSSQL_RUN_QUERY);
    trace('mssql.runQuery returned');
    await dockResultsWithTwin(foxDoc, converted.state);
    trace('dock done');
  }
  // The mssql extension does not report back; cursors are taken as created once sent.
  converted.state.cursors = converted.conversion.cursors;
  converted.state.currentCursor = converted.conversion.currentCursor;
  // Results open in the lower group; typing continues in the FoxPro editor above.
  await vscode.window.showTextDocument(foxDoc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
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
  languageItem = vscode.window.createStatusBarItem('foxquery.language', vscode.StatusBarAlignment.Right, 200);
  languageItem.command = 'foxquery.switchLanguage';
  languageItem.name = 'FoxQuery: ngôn ngữ';
  context.subscriptions.push(languageItem);
  renderLanguageItem();
  void applyLeanLayoutOnce(context);
  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('foxquery.run', runQuery),
    vscode.commands.registerCommand('foxquery.showTsql', showTsql),
    vscode.commands.registerCommand('foxquery.newQuery', newQuery),
    vscode.commands.registerCommand('foxquery.switchLanguage', switchLanguage),
    vscode.commands.registerCommand('foxquery.compare', compareLanguages),
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
      renderLanguageItem();
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
