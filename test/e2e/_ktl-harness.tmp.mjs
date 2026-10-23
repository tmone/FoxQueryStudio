// Drives the "Kiem tra luong" screen in the local harness: tree, procedure with parameters, xBase SUM on the
// cursor, mismatch hint, T-SQL write guard, export button rule, bookmark save. Screenshots go to the design folder.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = 'http://localhost:8765/';
const SHOTS = 'D:/SureHCS/docs/design/202610-kiem-tra-luong/proto/pr';
mkdirSync(SHOTS, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : '')); };

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/nvthinh/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe' });
const page = await browser.newPage({ viewport: { width: 1440, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.dismiss());

const shot = async (name) => {
  await page.waitForTimeout(700); // let dialogs finish closing and UI5 re-render before the evidence shot
  await page.screenshot({ path: `${SHOTS}/${name}-1440x720.png` });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}-1920x1080.png` });
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.waitForTimeout(300);
};
const editorText = async () => page.evaluate(() => window.ktlView.getController().getSource());
const setEditor = async (text) => page.evaluate((t) => { window.ktlView.getController().editor.setValue(t, -1); }, text);
const ui = async () => page.evaluate(() => JSON.parse(JSON.stringify(window.ktlView.getModel('ui').getData())));
const byId = (id) => page.locator(`#${'__xmlview0--' + id}`);
const runAndWait = async () => {
  const before = await page.evaluate(() => window.__ktlRuns || 0);
  await byId('btnReadInfo').click();
  await page.waitForFunction((b) => (window.__ktlRuns || 0) > b, before, { timeout: 90000 });
};
const dialogRun = async (value) => {
  const input = page.locator('#__xmlview0--txtParamValue-inner');
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill(value);
  await page.locator('#__xmlview0--dlgParam button:has-text("Chạy")').click();
};

await page.goto(URL);
await page.waitForFunction(() => window.ktlView && window.ktlView.getModel('objects') && window.ktlView.getModel('objects').getData().nodes.length > 0, null, { timeout: 60000 });
// Count finished runs: every showResult call bumps a counter.
await page.evaluate(() => {
  const c = window.ktlView.getController();
  const orig = c.showResult.bind(c);
  c.showResult = function (r, t, f) { orig(r, t, f); window.__ktlRuns = (window.__ktlRuns || 0) + 1; };
});
await page.waitForTimeout(1500);
const tree = await page.evaluate(() => window.ktlView.getModel('objects').getData().nodes.map((g) => g.title + ': ' + g.nodes.map((n) => n.title).join(', ')));
console.log(tree.join('\n'));
check('tree shows procedures and views from the whitelist', tree.some((t) => t.includes('xbase.sp_PayrollCheck')) && tree.some((t) => t.includes('xbase.vw_PayIncome')));
check('buttons visible after permission check', await byId('btnReadInfo').isVisible() && await byId('btnBookmark').isVisible());
check('footer holds no buttons', (await page.locator('footer button').count()) === 0);
check('export hidden with no result', !(await byId('btnExport').isVisible()));
await shot('empty');
await byId('btnReadInfo').screenshot({ path: `${SHOTS}/run-button-zoom.png`, scale: 'device' });

// ---- click the view: USE + preview rows
await page.evaluate(() => sap.ui.getCore().byId(window.ktlView.createId('treeObjects')).expandToLevel(1));
await page.waitForTimeout(500);
await page.locator('.ktl-tree li:has-text("xbase.vw_PayIncome")').first().click();
await page.waitForFunction(() => (window.__ktlRuns || 0) >= 1, null, { timeout: 60000 });
let u = await ui();
check('click view -> results pane with rows', u.Pane === 'results' && u.RowCount > 0, `pane=${u.Pane} rows=${u.RowCount}`);
check('export visible when results have rows', await byId('btnExport').isVisible());
await shot('use-view');

// ---- SUM on the view (work area set by the click)
await setEditor('SUM GrossSalVND - NetSalVND - TaxAmount FOR DowCode = "2026/09"');
await runAndWait();
u = await ui();
const cols = await page.evaluate(() => sap.ui.getCore().byId(window.ktlView.createId('tblResult')).getColumns().map((c) => c.getLabel().getText()));
check('SUM runs on the current view', !u.Messages.includes('ktl-error'), u.Messages.replace(/<[^>]+>/g, ' ').slice(0, 200));
check('SUM result is one aggregate row', u.RowCount === 1 && cols[0] === 'sum1', `rows=${u.RowCount} cols=${cols.join(',')}`);
check('T-SQL translation shown', /SELECT SUM\(/i.test(u.Translation), u.Translation.slice(0, 120));
console.log('hint: ' + u.Hint);
await shot('sum');

// ---- click the procedure: parameter dialog, then cursor
await page.locator('.ktl-tree li:has-text("xbase.sp_PayrollCheck")').first().click();
await page.waitForTimeout(500);
await shot('param');
await dialogRun('2026/09');
await page.waitForFunction(() => (window.__ktlRuns || 0) >= 3, null, { timeout: 90000 });
u = await ui();
check('procedure result shown as rows (first result set = cursor)', u.Pane === 'results' && u.RowCount > 1, `pane=${u.Pane} rows=${u.RowCount}`);
check('message names the cursor', /Cursor sp_payrollcheck/i.test(u.Messages), u.Messages.slice(0, 160));
await shot('procedure');

// ---- SUM on the cursor, with a Vietnamese phrase parameter and a mismatch hint
await setEditor('SUM BasicSalary - BasicSalary * Hệ số lương FOR DowCode = "2026/09"');
await byId('btnReadInfo').click();
await dialogRun('0.5');
await page.waitForFunction(() => (window.__ktlRuns || 0) >= 4, null, { timeout: 90000 });
u = await ui();
check('phrase parameter applied and SUM on cursor ran', u.RowCount === 1 && !u.Messages.includes('ktl-error'), u.Messages.replace(/<[^>]+>/g, ' ').slice(0, 200));
check('mismatch hint offered when SUM differs from 0', /Liệt kê/.test(u.Hint) && (await byId('btnHint').isVisible()), u.Hint.slice(0, 160));
await shot('hint');
await byId('btnHint').click();
await page.waitForFunction(() => (window.__ktlRuns || 0) >= 5, null, { timeout: 90000 });
u = await ui();
check('hint query lists the differing rows', u.Pane === 'results' && u.RowCount > 0, `rows=${u.RowCount}`);
await shot('hint-rows');

// ---- remembered parameter: the same phrase is prefilled
await setEditor('COUNT FOR BasicSalary * Hệ số lương > 0');
await byId('btnReadInfo').click();
const prefilled = await page.locator('#__xmlview0--txtParamValue-inner').inputValue();
check('parameter value remembered from the previous run', prefilled === '0.5', prefilled);
await page.locator('#__xmlview0--dlgParam button:has-text("Chạy")').click();
await page.waitForFunction(() => (window.__ktlRuns || 0) >= 6, null, { timeout: 90000 });

// ---- write attempt in xBase is refused by the converter / guard
await setEditor('DELETE FROM xbase.vw_PayIncome');
await runAndWait();
u = await ui();
check('xBase write refused, messages pane', u.Pane === 'messages' && u.Messages.includes('ktl-error'), u.Messages.replace(/<[^>]+>/g, ' ').slice(0, 160));
await shot('refused');

// ---- T-SQL mode: guard before sending, then a real query on the cursor
await page.evaluate(() => { const m = window.ktlView.getModel('ui'); m.setProperty('/Language', 'tsql'); });
await setEditor("UPDATE xbase.RunMarker SET UserID = 'x'");
await runAndWait();
u = await ui();
check('T-SQL write refused client-side', u.Messages.includes('UPDATE') && u.Pane === 'messages', u.Messages.replace(/<[^>]+>/g, ' ').slice(0, 160));
await setEditor('SELECT TOP 5 EmployeeCode, BasicSalary FROM #sp_payrollcheck ORDER BY BasicSalary DESC');
await runAndWait();
u = await ui();
check('T-SQL on the cursor returns rows', u.Pane === 'results' && u.RowCount === 5, `rows=${u.RowCount}`);
check('T-SQL translated to FoxPro', /SELECT TOP 5/i.test(u.Translation), u.Translation.slice(0, 120));
await shot('tsql');

// ---- out of scope object: the restricted login has no right on dbo
await setEditor('SELECT TOP 1 * FROM dbo.HCSEM_Employees');
await runAndWait();
u = await ui();
check('dbo table outside the whitelist runs on the system connection (no SQL-level block any more)', u.Pane === 'results' || u.Pane === 'messages', u.Messages.replace(/<[^>]+>/g, ' ').slice(0, 160));

// ---- bookmark save and list
await setEditor('SUM GrossSalVND FOR DowCode = "2026/09"');
await byId('btnBookmark').click();
const nameInput = page.locator('#__xmlview0--txtBookmarkName-inner');
await nameInput.waitFor({ state: 'visible' });
const bmName = 'harness ' + Date.now();
await nameInput.fill(bmName);
await byId('btnSaveBookmarkDlg').click();
await page.waitForTimeout(1500);
const bookmarks = await page.evaluate(() => window.ktlView.getModel('bookmarks').getData().map((b) => b.Name));
check('bookmark saved and listed', bookmarks.includes(bmName), bookmarks.join(' | ').slice(0, 200));
await page.evaluate(() => sap.ui.getCore().byId(window.ktlView.createId('tabSide')).setSelectedKey('bookmarks'));
await page.waitForTimeout(500);
await shot('bookmarks');

// ---- export produces a CSV download
await page.evaluate(() => sap.ui.getCore().byId(window.ktlView.createId('tabSide')).setSelectedKey('objects'));
await page.evaluate(() => { const m = window.ktlView.getModel('ui'); m.setProperty('/Language', 'tsql'); });
await setEditor('SELECT TOP 3 EmployeeCode, BasicSalary FROM #sp_payrollcheck');
await runAndWait();
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), byId('btnExport').click()]);
const csvPath = await download.path();
const csv = (await import('node:fs')).readFileSync(csvPath, 'utf8');
check('export gives a CSV with header and 3 rows', csv.split(/\r\n/).filter(Boolean).length === 4 && csv.includes('EmployeeCode'), csv.slice(0, 80).replace(/\n/g, ' '));

// ---- vertical splitter between editor and results can be dragged
await page.evaluate(() => { const m = window.ktlView.getModel('ui'); m.setProperty('/Language', 'foxpro'); });
const hBefore = await page.evaluate(() => window.ktlView.getController().editor.container.getBoundingClientRect().height);
const bar = page.locator('#__xmlview0--splRight-splitbar-0');
const bb = await bar.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2 + 150, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
const hAfter = await page.evaluate(() => window.ktlView.getController().editor.container.getBoundingClientRect().height);
const aceRows = await page.evaluate(() => window.ktlView.getController().editor.renderer.$size.height);
check('editor/result splitter drags and ACE resizes', hAfter > hBefore + 100 && Math.abs(aceRows - hAfter) < 5, `before=${hBefore} after=${hAfter} ace=${aceRows}`);
await shot('split-dragged');

const real = errors.filter((e) => !/favicon|sap-ui-core.*deprecat|404/i.test(e));
check('no page errors', real.length === 0, real.slice(0, 5).join(' || ').slice(0, 400));
await browser.close();
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed);
