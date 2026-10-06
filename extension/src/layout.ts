import * as vscode from 'vscode';

/**
 * Settings that strip the workbench down to what SSMS shows: object explorer on the
 * left, editor, results, status bar. Nothing here changes how queries run.
 */
const LEAN_SETTINGS: Record<string, unknown> = {
  'workbench.colorTheme': 'Default Light Modern',
  'window.autoDetectColorScheme': false,
  'workbench.activityBar.location': 'hidden',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.layoutControl.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'window.commandCenter': false,
  'chat.commandCenter.enabled': false,
  'editor.minimap.enabled': false,
  'breadcrumbs.enabled': false,
  'mssql.showGettingStarted': false,
  'mssql.enableQueryHistoryFeature': false,
  'mssql.showOverviewInObjectExplorer': false,
  // The per-editor icon strip of mssql is replaced by F5 and the menu.
  'workbench.editor.editorActionsLocation': 'hidden',
  // Results open as a tab in the lower group, next to the T-SQL twin, so the top group stays the FoxPro editor.
  'mssql.openQueryResultsInTabByDefault': true,
  'mssql.persistQueryResultTabs': true,
  'mssql.openQueryResultsInTabByDefaultDoNotShowPrompt': true,
  // The twin document holds #temp tables from earlier runs that the language service cannot see.
  'mssql.intelliSense.enableErrorChecking': false,
};

const APPLIED_KEY = 'foxquery.layoutApplied';
const OBJECT_EXPLORER_VIEW = 'workbench.view.extension.objectExplorer';

/** A key this VS Code version does not know must not stop the others from being written. */
async function writeSettings(values: Record<string, unknown>): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const results = await Promise.allSettled(Object.entries(values).map(([key, value]) => config.update(key, value, vscode.ConfigurationTarget.Global)));
  results.forEach((r, i) => r.status === 'rejected' && console.warn(`FoxQuery: không ghi được ${Object.keys(values)[i]}: ${r.reason}`));
}

export async function applyLeanLayout(): Promise<void> {
  await writeSettings(LEAN_SETTINGS);
  // The object explorer view exists only once mssql has activated.
  await vscode.extensions.getExtension('ms-mssql.mssql')?.activate();
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand(OBJECT_EXPLORER_VIEW);
  // Background Tasks has no setting; the view's own hide command does it.
  await vscode.commands.executeCommand('backgroundTasks.removeView').then(undefined, () => undefined);
  await vscode.commands.executeCommand('mssql.hideOverviewInObjectExplorer').then(undefined, () => undefined);
}

/** Puts every setting back to its default; the user's own values are not known. */
export async function restoreDefaultLayout(): Promise<void> {
  await writeSettings(Object.fromEntries(Object.keys(LEAN_SETTINGS).map((key) => [key, undefined])));
}

/** Applies the lean layout the first time the extension runs in a profile, and says how to undo it. */
export async function applyLeanLayoutOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(APPLIED_KEY)) return;
  await applyLeanLayout();
  await context.globalState.update(APPLIED_KEY, true);
  void vscode.window.showInformationMessage('FoxQuery đã thu gọn giao diện theo kiểu SSMS. Lệnh "FoxQuery: Khôi phục bố cục mặc định" để hoàn tác.');
}
