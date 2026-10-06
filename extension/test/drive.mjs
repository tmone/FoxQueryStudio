// Drives the isolated VS Code with the extension loaded, like a user: open luong.fox,
// press F5, pick the saved connection, type the password, check the mssql results.
//   FQS_E2E_PASSWORD=... node test/drive.mjs
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const EXE = 'D:/SureHCS/tmp/vscode-test/vscode-win32-x64-archive-1.140.0/Code.exe';
const ROOT = resolve('.vscode-test');
const OUT = resolve('test-results');
mkdirSync(OUT, { recursive: true });
const password = process.env.FQS_E2E_PASSWORD;
if (!password) throw new Error('set FQS_E2E_PASSWORD');

// Each run starts as a first run: no remembered layout, panels or editors.
import('node:fs').then(({ rmSync }) => { for (const dir of ['workspaceStorage']) rmSync(`${ROOT}/user-data/User/${dir}`, { recursive: true, force: true }); });
const { ELECTRON_RUN_AS_NODE: _x, ...env } = process.env;
const app = await electron.launch({
  executablePath: EXE,
  env,
  args: [
    `--extensionDevelopmentPath=${resolve('.')}`,
    `--extensions-dir=${ROOT}/extensions`,
    `--user-data-dir=${ROOT}/user-data`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    `${ROOT}/workspace/luong.fox`,
  ],
});
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, timeout: 10_000 }).catch((e) => log(`screenshot ${name} failed: ${String(e.message).slice(0, 80)}`));
const texts = (page, selector) => page.$$eval(selector, (nodes) => nodes.map((n) => n.textContent?.trim()).filter(Boolean));

/** Text of every webview frame whose content matches `pattern`. */
async function frameTexts(page, pattern) {
  const found = [];
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (pattern.test(text)) found.push(text.replace(/\s+/g, ' ').trim());
  }
  return found;
}

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  await page.waitForSelector('.editor-instance .monaco-editor', { timeout: 60_000 });
  log('workbench up');
  // First run of mssql downloads .NET and SQL Tools Service; wait for the status bar to settle.
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.statusbar-item')].some((i) => /Downloading|Activating|Installing/i.test(i.textContent ?? '')),
    null,
    { timeout: 600_000 },
  );
  // The download indicator can appear a moment after startup; require a quiet status bar for a while.
  for (let quiet = 0; quiet < 5; quiet++) {
    await page.waitForTimeout(1000);
    if (await page.locator('.statusbar-item', { hasText: /Downloading|Activating|Installing/ }).count()) { quiet = -1; }
  }
  // Apply the lean layout explicitly, since the profile may already remember a first run.
  await page.keyboard.press('F1');
  await page.keyboard.type('FoxQuery: Thu gọn');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  await shot(page, 'vsc-01-open');
  const sidebarTitle = await page.textContent('.part.sidebar .composite.title h2').catch(() => '(no sidebar)');
  log(`sidebar: ${sidebarTitle?.trim()} | activity bar visible: ${await page.isVisible('.part.activitybar')} | breadcrumbs: ${await page.isVisible('.breadcrumbs-control')}`);
  log(`status language: ${(await page.textContent('.statusbar-item[id="status.editor.mode"]').catch(() => ''))?.trim()}`);

  // mssql may open its welcome pages on first activation; close them and go back to the FoxPro file.
  await page.keyboard.press('Escape');
  // The debug side bar opened by the stray first F5 covers the editor; hide it.
  for (const button of await page.$$('.notification-list-item-toolbar-container .codicon-notifications-clear')) await button.click().catch(() => undefined);
  await page.locator('.tabs-container .tab', { hasText: 'luong' }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('.editor-group-container.active .monaco-editor .view-lines').first().click({ force: true });
  await page.keyboard.press('F5');
  log('F5 pressed');
  await page.waitForTimeout(4000);
  await shot(page, 'vsc-02-after-f5');

  // mssql asks which connection to use; the saved profile is listed, then the password.
  const quickInput = page.locator('.quick-input-widget');
  if (await quickInput.isVisible()) {
    log(`quick pick: ${(await texts(page, '.quick-input-list .monaco-list-row')).join(' | ')}`);
    const dev = page.locator('.quick-input-list .monaco-list-row', { hasText: 'TAKA dev' });
    if (await dev.count()) await dev.first().click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    await shot(page, 'vsc-03-picked');
    if (await quickInput.isVisible()) {
      log(`prompt: ${(await texts(page, '.quick-input-message')).join(' ')}`);
      await page.keyboard.type(password);
      await page.keyboard.press('Enter');
    }
  } else {
    log('no quick pick shown');
  }
  await page.waitForTimeout(15000);
  await shot(page, 'vsc-04-result');

  log(`tabs: ${(await texts(page, '.tabs-container .tab .label-name')).join(' | ')}`);
  const results = await frameTexts(page, /EmployeeCode|rows|Messages/i);
  for (const text of results) log(`results webview: ${text.slice(0, 500)}`);
  if (!results.length) log('results webview: not found');

  // ---- Cursors across two separate runs on the same tab -----------------------------------
  async function runFox(source, label) {
    await page.locator('.tabs-container .tab', { hasText: 'luong' }).first().click();
    await page.waitForTimeout(500);
    await page.locator('.editor-group-container.active .monaco-editor .view-lines').first().click({ force: true });
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(source);
    await page.waitForTimeout(500);
    await page.keyboard.press('F5');
    await page.waitForTimeout(8000);
    await shot(page, label);
    const found = await frameTexts(page, /Results|Messages|rows/i);
    log(`${label}: tabs=${(await texts(page, '.tabs-container .tab .label-name')).join(' | ')}`);
    for (const text of found) log(`${label} webview: ${text.slice(0, 300)}`);
    const notes = await texts(page, '.notification-list-item-message');
    if (notes.length) log(`${label} notifications: ${notes.join(' | ')}`);
  }
  await runFox('SELECT DepartmentCode, COUNT(*) AS n FROM HCSEM_Employees WHERE !EMPTY(DepartmentCode) GROUP BY 1 INTO CURSOR curPB', 'vsc-05-cursor');
  await runFox('BROWSE FOR n >= 20', 'vsc-06-browse');


  // What the Problems panel holds: our converter diagnostics, or noise from the T-SQL twin.
  await page.keyboard.press('Control+Shift+M');
  await page.waitForTimeout(1500);
  log(`problems: ${(await texts(page, '.markers-panel .monaco-list-row')).join(' | ').slice(0, 600)}`);

  log(`status: ${(await texts(page, '.statusbar-item')).join(' • ')}`);
  const notifications = await texts(page, '.notification-list-item-message');
  if (notifications.length) log(`notifications: ${notifications.join(' | ')}`);
} finally {
  await app.close();
}
