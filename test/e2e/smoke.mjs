// Launches the built app and checks the shell without a database: editor, menu,
// toolbar, keyboard shortcuts, status bar, file open and save.
// Run `npm run build` first.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const OUT_DIR = 'test-results';
mkdirSync(OUT_DIR, { recursive: true });
const workDir = mkdtempSync(join(tmpdir(), 'fqs-smoke-'));

// Shells spawned by an Electron host (VS Code) set this and make electron.exe run as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
// The FoxPro steps need Visual FoxPro 9; FQS_VFP_EXE says where it is when it is not installed in the usual place.
const VFP_EXE = process.env.FQS_VFP_EXE ?? String.raw`D:\SureHCS\tools\vfp9\vfp9.exe`;
env.FQS_VFP_EXE = VFP_EXE;
env.FQS_USER_DATA = join(workDir, 'user-data');
const app = await electron.launch({ args: ['.'], env });
const errors = [];
const ok = (name) => console.log(`ok  ${name}`);
try {
  const page = await app.firstWindow();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const tabCount = () => page.locator('.tab').count();
  const editorText = () => page.$eval('.monaco-editor .view-lines', (lines) => lines.innerText.replace(/ /g, ' '));

  await page.waitForSelector('.monaco-editor', { timeout: 30_000 });
  // As in SSMS, the pane under the editor opens only once a query has something to show.
  assert.equal(await page.isHidden('.output'), true);
  assert.equal(await page.textContent('#query-state'), 'Chưa chạy truy vấn');
  await page.click('.monaco-editor');
  await page.keyboard.type('* lương tháng 1\nSELECT ALLTRIM(ten), NVL(luong, 0) FROM nv ;\nWHERE ngay >= {^2026-01-01} AND active = .T. && ghi chú');

  // Syntax highlighting proves the FoxPro language is registered.
  const tokenClasses = await page.$$eval('.view-line span span', (spans) => [...new Set(spans.map((s) => s.className))]);
  assert.ok(tokenClasses.length >= 4, `expected several token styles, got ${tokenClasses.join(',')}`);
  ok('highlights FoxPro source');

  // ---- Menu ------------------------------------------------------------------------------
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => ({ label: item.label, items: item.submenu.items.map((i) => i.label) })));
  assert.deepEqual(menu.slice(0, 6).map((m) => m.label.replace('&', '')), ['Tệp', 'Sửa', 'Xem', 'Kết nối', 'Truy vấn', 'Trợ giúp']);
  assert.ok(menu[0].items.includes('Truy vấn mới') && menu[0].items.includes('Lưu thành…'));
  assert.ok(menu[3].items.includes('Kết nối…') && menu[3].items.includes('Làm mới danh sách đối tượng'));
  const clickMenu = (menuIndex, label) =>
    app.evaluate(({ Menu }, [index, text]) => Menu.getApplicationMenu().items[index].submenu.items.find((i) => i.label === text).click(), [menuIndex, label]);
  await clickMenu(0, 'Truy vấn mới');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2);
  await clickMenu(2, 'Thông báo');
  await page.waitForSelector('#pane-messages:not([hidden])');
  await clickMenu(2, 'Kết quả');
  ok('builds the application menu and runs its commands');

  // ---- Keyboard shortcuts ------------------------------------------------------------------
  await page.keyboard.press('Control+N');
  assert.equal(await tabCount(), 3);
  await page.keyboard.press('Control+W');
  assert.equal(await tabCount(), 2);
  await page.keyboard.press('F8');
  assert.equal(await page.isHidden('.explorer'), true);
  await page.keyboard.press('F8');
  assert.equal(await page.isVisible('.explorer'), true);
  await page.keyboard.press('Control+R');
  assert.equal(await page.isHidden('.output'), true);
  await page.keyboard.press('Control+R');
  assert.equal(await page.isVisible('.output'), true);
  ok('handles shortcuts once each: new tab, close tab, toggle panels');

  // ---- Status bar and toolbar while disconnected -------------------------------------------
  assert.equal(await page.textContent('#status-state'), 'Chưa có kết nối');
  assert.equal(await page.textContent('#status-connection'), 'Tab chưa gắn kết nối');
  assert.equal(await page.isDisabled('#btn-run'), true, 'run is disabled until connected');
  assert.equal(await page.isDisabled('#btn-disconnect'), true);
  assert.match(await page.textContent('#app-version'), /^v\d+\.\d+\.\d+$/);
  assert.equal(await page.isHidden('#btn-update'), true, 'no update button without a newer version');
  // The version sits in its own cell at the far right of the app status bar, as in SSMS.
  const [bar, box] = await page.evaluate(() => [document.getElementById('statusbar').getBoundingClientRect().right, document.querySelector('.statusbar .version-box').getBoundingClientRect().right]);
  assert.ok(Math.abs(bar - box) < 2, 'version box is flush right');
  await page.locator('.tab').first().click();
  await page.click('.monaco-editor');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.textContent('#status-position'), 'Dòng 2, Cột 1');
  assert.match(await page.textContent('#explorer-tree'), /Kết nối SQL Server hoặc mở CSDL FoxPro/);
  ok('shows connection state, editor position and version in the status bar');

  // ---- Save and open, with the native dialogs answered by the test ------------------------
  const saved = join(workDir, 'bang-luong.prg');
  await app.evaluate(({ dialog }, path) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })), saved);
  await page.keyboard.press('Control+S');
  await page.waitForFunction((name) => document.querySelector('.tab.active').textContent.startsWith(name), 'bang-luong.prg');
  assert.match(readFileSync(saved, 'utf8'), /^\* lương tháng 1\r?\nSELECT ALLTRIM\(ten\)/);

  // A source saved by FoxPro itself is in the Windows code page, not UTF-8.
  const legacy = join(workDir, 'cu.prg');
  writeFileSync(legacy, Buffer.from('SELECT * FROM kh WHERE ten = "Königlich"', 'latin1'));
  await app.evaluate(({ dialog }, path) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })), legacy);
  await page.keyboard.press('Control+O');
  await page.waitForFunction(() => document.querySelector('.tab.active').textContent.startsWith('cu.prg'));
  // The editor paints the new model a frame after the tab strip.
  await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines').innerText.includes('Königlich'));
  assert.match(await editorText(), /ten = "Königlich"/);
  assert.equal(await tabCount(), 3);
  ok('saves a query to a file and opens a FoxPro source in the Windows code page');
  await page.screenshot({ path: `${OUT_DIR}/smoke-editor.png` });

  // ---- Language switch and compare column -------------------------------------------------
  const language = () => page.textContent('#status-language');
  const compareText = () => page.$eval('#compare-editor .view-lines', (lines) => lines.innerText.replace(/ /g, ' '));
  await page.keyboard.press('Control+N');
  assert.equal(await language(), 'FOX-SQL');
  await page.keyboard.insertText('SELECT ALLTRIM(ten) AS ten FROM nv WHERE ma = "A01"');
  await page.keyboard.press('Control+Shift+D');
  assert.equal(await page.isVisible('.compare'), true);
  assert.equal(await page.textContent('#compare-title'), 'T-SQL · bản dịch, chỉ đọc');
  await page.waitForFunction(() => /LTRIM\(\{fn RTRIM\(ten\)\}\)/.test(document.querySelector('#compare-editor .view-lines').innerText.replace(/ /g, ' ')));
  await page.keyboard.insertText(' AND luong > 0');
  await page.waitForFunction(() => /luong > 0/.test(document.querySelector('#compare-editor .view-lines').innerText.replace(/ /g, ' ')));
  ok('shows the live T-SQL translation next to the FoxPro source');

  await page.keyboard.press('Control+Shift+L');
  assert.equal(await language(), 'T-SQL');
  assert.match(await editorText(), /LTRIM\(\{fn RTRIM\(ten\)\}\)/);
  assert.equal(await page.textContent('#tab-translation'), 'FoxPro đã dịch');
  assert.equal(await page.textContent('#compare-title'), 'FOX-SQL · bản dịch, chỉ đọc');
  assert.match(await compareText(), /LTRIM\(RTRIM\(ten\)\) AS ten FROM nv/);
  assert.equal(await page.getAttribute('.language-switch [data-language=tsql]', 'aria-pressed'), 'true');
  await page.click('.language-switch [data-language=foxpro]');
  assert.equal(await language(), 'FOX-SQL');
  assert.match(await editorText(), /LTRIM\(RTRIM\(ten\)\) AS ten FROM nv/);
  ok('rewrites the tab in the other language and back');
  await page.screenshot({ path: `${OUT_DIR}/smoke-compare.png` });

  // T-SQL that FoxPro cannot express must stay as it is, labelled as T-SQL.
  await page.keyboard.press('Control+Shift+L');
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('WITH x AS (SELECT 1 AS a) SELECT a FROM x');
  await page.keyboard.press('Control+Shift+L');
  assert.equal(await language(), 'T-SQL');
  assert.match(await editorText(), /WITH x AS/);
  assert.match(await page.textContent('#pane-messages'), /Chưa đổi sang FOX-SQL được/);
  await page.waitForFunction(() => document.querySelector('#compare-title').textContent === 'FOX-SQL · chưa dịch được');
  // A query opened from that tab starts in the same language.
  await page.keyboard.press('Control+N');
  assert.equal(await language(), 'T-SQL');
  await page.keyboard.press('Control+W');
  await page.keyboard.press('Control+W');
  await page.keyboard.press('Control+Shift+D');
  assert.equal(await page.isHidden('.compare'), true);
  ok('keeps untranslatable T-SQL unchanged and reports why');

  // ---- FoxPro database opened from disk: FoxPro itself is the engine, no server ----------
  const fixtures = resolve('test/fixtures/northwind');
  if (existsSync(join(fixtures, 'northwind.dbc')) && existsSync(VFP_EXE)) {
    const messages = () => page.textContent('#pane-messages');
    const visibleRows = () =>
      page.$$eval('#pane-results .grid-row', (rows) => rows.map((row) => [...row.querySelectorAll('.grid-cell:not(.rownum)')].map((cell) => cell.textContent)));
    /** Replaces the editor content and runs it with F5; resolves when the run has finished. */
    const run = async (source) => {
      await page.click('#editor');
      await page.keyboard.press('Control+A');
      await page.keyboard.insertText(source);
      await page.evaluate(() => (document.getElementById('pane-messages').textContent = ''));
      await page.keyboard.press('F5');
      await page.waitForFunction(() => document.getElementById('pane-messages').textContent !== '', null, { timeout: 120_000 });
      return messages();
    };

    assert.equal(await page.isDisabled('#btn-run'), true);
    await app.evaluate(({ dialog }, path) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })), join(fixtures, 'northwind.dbc'));
    await page.keyboard.press('Control+Shift+O');
    await page.waitForFunction(() => /Đã mở|Không mở được/.test(document.getElementById('pane-messages').textContent), null, { timeout: 180_000 });
    assert.match(await messages(), /Đã mở .*northwind\.dbc\./);
    await page.waitForSelector('#explorer-tree .server:not(.offline) .group', { timeout: 60_000 });
    assert.match(await page.textContent('#explorer-tree .server:not(.offline) > summary'), /^FoxPro \(.*northwind\.dbc\)$/);
    assert.equal(await page.textContent('#explorer-tree .group > summary'), 'Bảng (11)');
    assert.equal(await page.textContent('#status-state'), '1 kết nối đang mở');
    assert.match(await page.textContent('#status-connection'), /^FoxPro: .*northwind\.dbc$/);
    assert.equal(await page.isDisabled('#btn-run'), false);
    ok('opens a FoxPro database file with no server connection');

    // FoxPro: "Ger" matches Germany, because FoxPro compares up to the shorter string.
    await page.keyboard.press('Control+N');
    assert.equal(await language(), 'FOX-SQL');
    let text = await run('SELECT ALLTRIM(customerid) AS ma, ALLTRIM(country) AS nuoc FROM customers WHERE country = "Ger" ORDER BY 1 INTO CURSOR duc');
    assert.doesNotMatch(text, /Lỗi/);
    // A named cursor shows its rows right away, in the results pane, and still stays for later statements.
    assert.match(text, /Bảng 1: 11 dòng/);
    assert.equal(await page.$eval('.output-tabs > button.active', (b) => b.dataset.pane), 'results');
    assert.equal((await visibleRows()).length, 11);
    text = await run('SELECT COUNT(*) AS n FROM duc');
    assert.match(text, /Bảng 1: 1 dòng/);
    assert.deepEqual(await visibleRows(), [['11']]);
    assert.equal(await page.textContent('#status-cursor'), 'Cursor: duc');
    assert.equal(await page.textContent('#query-state'), 'Truy vấn chạy xong');
    text = await run('SELECT TOP 3 ma, nuoc FROM duc ORDER BY ma');
    assert.deepEqual(await visibleRows(), [['ALFKI', 'Germany'], ['BLAUS', 'Germany'], ['DRACD', 'Germany']]);
    ok('runs FoxPro source in FoxPro itself and keeps its cursor between runs');

    // A click on a table in the tree makes it the tab's work area, as USE does: commands need no table name.
    await page.click('#explorer-tree .table:has(> summary:has-text("orders")) > summary');
    await page.waitForFunction(() => document.getElementById('status-cursor').textContent === 'Bảng: orders');
    assert.equal(await page.$eval('#explorer-tree .table.current > summary .label', (l) => l.textContent), 'orders');
    text = await run('SUM freight FOR orderid = 10248');
    assert.match(text, /Bảng 1: 1 dòng/);
    assert.deepEqual(await visibleRows(), [['32.38']]);
    text = await run('SELECT TOP 3 ma, nuoc FROM duc ORDER BY ma');
    ok('runs a nameless command on the table clicked in the tree');

    // Export the result to Excel, with the save dialog answered by the test.
    const xlsx = join(workDir, 'duc.xlsx');
    await app.evaluate(({ dialog }, path) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })), xlsx);
    assert.equal(await page.isVisible('#btn-export'), true, 'the export button shows once there are rows');
    await page.click('#btn-export');
    await page.waitForFunction(() => /Đã xuất 3 dòng ra/.test(document.getElementById('pane-messages').textContent), null, { timeout: 30_000 });
    assert.ok(existsSync(xlsx), 'the workbook was written');
    const xlsxDir = join(workDir, 'duc-xlsx');
    mkdirSync(xlsxDir, { recursive: true });
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', xlsx, '-C', xlsxDir]);
    const sheet = readFileSync(join(xlsxDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
    assert.match(sheet, /<t>ma<\/t>.*<t>nuoc<\/t>/);
    assert.match(sheet, /<t>ALFKI<\/t>/);
    assert.match(sheet, /<t>Germany<\/t>/);
    ok('exports the result grid to an Excel workbook');
    await page.screenshot({ path: OUT_DIR + '/smoke-local-fox.png' });

    // T-SQL in another tab, on the same tables.
    await page.keyboard.press('Control+N');
    await page.keyboard.press('Control+Shift+L');
    assert.equal(await language(), 'T-SQL');
    text = await run("SELECT COUNT(*) AS n FROM dbo.orders WHERE orderdate >= '1997-01-01'");
    assert.match(text, /Bảng 1: 1 dòng/);
    assert.deepEqual(await visibleRows(), [['678']]);
    await page.click('.output-tabs > button[data-pane=tsql]');
    assert.equal(await page.textContent('#pane-tsql'), 'SELECT COUNT(*) AS n FROM orders WHERE orderdate >= {^1997-01-01}');
    text = await run('SELECT * FROM khong_co_bang');
    assert.match(text, /Lỗi từ FoxPro: .*khong_co_bang/i);
    assert.equal(await page.textContent('#query-state'), 'Truy vấn có lỗi');
    ok('runs T-SQL on the FoxPro database by turning it into FoxPro');
    await page.screenshot({ path: OUT_DIR + '/smoke-local-tsql.png' });

    // A payroll check typed the customer's way: the phrase is asked for, the table is found, the wrong row offered.
    if (!existsSync(resolve('test/fixtures/lamthao/bangluong.dbf'))) execFileSync(process.execPath, ['scripts/make-luong-sample.mjs'], { stdio: 'ignore' });
    await app.evaluate(({ dialog }, path) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })), resolve('test/fixtures/lamthao/bangluong.dbf'));
    await page.keyboard.press('Control+Shift+O');
    await page.waitForFunction(() => /Đã mở .*lamthao/.test(document.getElementById('pane-messages').textContent), null, { timeout: 120_000 });
    await page.waitForFunction(() => document.querySelectorAll('#explorer-tree .server:not(.offline) .group').length === 2, null, { timeout: 60_000 });
    await page.keyboard.press('Control+N');
    if ((await language()) !== 'FOX-SQL') await page.keyboard.press('Control+Shift+L');
    await page.click('#editor');
    await page.keyboard.insertText('SUM TP-LC*HSDC*2700000*DIEMP/9.8*CP/Công chế độ*HSL');
    await page.keyboard.press('F5');
    await page.waitForSelector('#param-dialog[open]');
    assert.equal(await page.textContent('#param-name'), 'Công chế độ');
    await page.fill('#param-dialog input[name=value]', '25');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Thời gian/.test(document.getElementById('pane-messages').textContent), null, { timeout: 60_000 });
    assert.deepEqual(await visibleRows(), [['1000']]);
    text = await messages();
    assert.match(text, /^Công chế độ = 25\nĐã mở bảng bangluong/);
    assert.match(text, /SELECT \*, TP-LC\*HSDC\*2700000\*DIEMP\/9\.8\*CP\/\(25\)\*HSL AS lech FROM bangluong WHERE ABS\(/);
    assert.equal(await page.textContent('#status-cursor'), 'Bảng: bangluong');
    await page.screenshot({ path: OUT_DIR + '/smoke-payroll-check.png' });
    ok("runs a payroll check as the customer types it: parameter asked, table found, wrong row offered");
    await page.click('#btn-disconnect');
    await page.waitForFunction(() => document.getElementById('status-state').textContent === '1 kết nối đang mở');
    await page.click('#explorer-tree .server.offline:has(summary:has-text("lamthao")) > summary', { button: 'right' });
    await page.click('.context-menu button:has-text("Xóa khỏi danh sách")');
    await page.waitForFunction(() => document.querySelectorAll('#explorer-tree .server').length === 1);
    await page.keyboard.press('Control+W');

    // Every run went to the history on disk; the list shows them newest first and finds them by text.
    await page.keyboard.press('Control+Shift+H');
    await page.waitForSelector('#history-list .journal-item');
    const historyTitles = () => page.$$eval('#history-list .journal-item .sql', (items) => items.map((i) => i.textContent));
    // The newest run is the payroll check, recorded as it ran: table opened, parameter in place.
    assert.equal((await historyTitles())[0], 'USE bangluong');
    assert.equal((await historyTitles())[1], 'SELECT * FROM khong_co_bang');
    assert.equal(await page.$eval('#history-list .journal-item:nth-child(2)', (i) => i.classList.contains('failed')), true, 'the failed run is marked');
    assert.match(await page.$eval('#history-list .journal-item:nth-child(3) .outcome', (i) => i.textContent), /^1 dòng/);
    await page.fill('#history-filter', 'country = "Ger"');
    await page.waitForFunction(() => document.querySelectorAll('#history-list .journal-item').length === 1);
    assert.match((await historyTitles())[0], /^SELECT ALLTRIM\(customerid\) AS ma/);
    const history = readFileSync(join(workDir, 'user-data', 'history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(history.length, 8);
    assert.match(history[0].connection, /^FoxPro \(.*northwind\.dbc\)$/);
    assert.equal(history[6].error.includes('khong_co_bang'), true);
    assert.match(history[7].sql, /^USE bangluong\nSUM TP-LC\*HSDC\*2700000\*DIEMP\/9\.8\*CP\/\(25\)\*HSL$/);
    await page.screenshot({ path: OUT_DIR + '/smoke-history.png' });
    ok('keeps every run in the history on disk and finds it again');

    // A history entry reopens in a new tab on the same connection; Ctrl+D keeps the tab's query as a bookmark.
    const tabsBefore = await page.$$eval('#tabs .tab', (t) => t.length);
    await page.dblclick('#history-list .journal-item');
    assert.equal(await page.$$eval('#tabs .tab', (t) => t.length), tabsBefore + 1, 'the entry opened in a new tab');
    assert.match(await editorText(), /INTO CURSOR duc/);
    await page.keyboard.press('Control+D');
    await page.waitForSelector('#bookmark-dialog[open]');
    await page.fill('#bookmark-dialog input[name=name]', 'Khách Đức');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#bookmark-list .journal-item');
    assert.deepEqual(await page.$$eval('#bookmark-list .journal-item .name', (items) => items.map((i) => i.textContent)), ['Khách Đức']);
    await page.keyboard.press('Control+W');
    // A bookmark carries no connection: it opens on the current one, which is made northwind again here.
    await page.click('.side-tabs > button[data-side=objects]');
    await page.click('#explorer-tree .server:not(.offline):has(summary:has-text("northwind")) > summary');
    await page.click('.side-tabs > button[data-side=bookmarks]');
    await page.dblclick('#bookmark-list .journal-item');
    await page.keyboard.press('F5');
    await page.waitForFunction(() => /Bảng 1: 11 dòng/.test(document.getElementById('pane-messages').textContent), null, { timeout: 60_000 });
    assert.deepEqual((await visibleRows()).slice(0, 2), [['ALFKI', 'Germany'], ['BLAUS', 'Germany']]);
    assert.deepEqual(JSON.parse(readFileSync(join(workDir, 'user-data', 'bookmarks.json'), 'utf8')).map((b) => b.name), ['Khách Đức']);
    ok('bookmarks a query and runs it again from the list');
    await page.screenshot({ path: OUT_DIR + '/smoke-journal.png' });
    await page.click('.side-tabs > button[data-side=objects]');

    await page.keyboard.press('Control+W');
    await page.keyboard.press('Control+W');
    await page.keyboard.press('Control+W');
    // Completion knows the tables and columns of the open FoxPro database, in both languages.
    const suggestions = async (text) => {
      await page.keyboard.press('Control+N');
      await page.keyboard.insertText(text);
      await page.keyboard.press('Control+Space');
      await page.waitForSelector('.suggest-widget.visible .monaco-list-row', { timeout: 10_000 });
      const labels = await page.$$eval('.suggest-widget.visible .monaco-list-row .label-name', (rows) => rows.map((r) => r.textContent));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+W');
      return labels;
    };
    assert.ok((await suggestions('SELECT * FROM cust')).includes('customers'), 'FoxPro tab offers the table');
    assert.ok((await suggestions('SELECT c. FROM customers c')).includes('companyname') || (await suggestions('SELECT comp FROM customers')).includes('companyname'), 'FoxPro tab offers the columns');
    await page.keyboard.press('Control+N');
    await page.keyboard.press('Control+Shift+L');
    await page.keyboard.press('Control+W');
    const tsqlTab = async (text) => {
      await page.keyboard.press('Control+N');
      await page.keyboard.press('Control+Shift+L');
      await page.keyboard.insertText(text);
      await page.keyboard.press('Control+Space');
      await page.waitForSelector('.suggest-widget.visible .monaco-list-row', { timeout: 10_000 });
      const labels = await page.$$eval('.suggest-widget.visible .monaco-list-row .label-name', (rows) => rows.map((r) => r.textContent));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+W');
      return labels;
    };
    assert.ok((await tsqlTab('SELECT * FROM ord')).includes('orders'), 'T-SQL tab offers the table');
    ok('completes table and column names of the FoxPro database in both languages');

    await page.click('#btn-disconnect');
    await page.waitForFunction(() => document.getElementById('status-state').textContent === 'Chưa có kết nối');
    assert.equal(await page.isDisabled('#btn-run'), true);
    // The database stays in the tree, closed, until it is removed.
    assert.match(await page.textContent('#explorer-tree .server.offline > summary'), /northwind\.dbc/);
    ok('closes the FoxPro database with Disconnect and keeps it listed');

    // A double-click reopens it; opening a table of a container opens the container itself.
    await page.dblclick('#explorer-tree .server.offline > summary');
    await page.waitForSelector('#explorer-tree .server:not(.offline)', { timeout: 60_000 });
    assert.equal(await page.textContent('#explorer-tree .group > summary'), 'Bảng (11)');
    await app.evaluate(({ dialog }, path) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })), join(fixtures, 'customers.dbf'));
    await page.keyboard.press('Control+Shift+O');
    await page.waitForFunction(() => /Đã mở|Không mở được/.test(document.getElementById('pane-messages').textContent), null, { timeout: 60_000 });
    assert.equal(await page.locator('#explorer-tree .server').count(), 1, 'the table belongs to the container already listed');
    assert.match(await messages(), /Đã mở .*northwind\.dbc/);
    ok('reopens a remembered database and resolves a table to its container');

    // Right-click → remove forgets it. The tree is rebuilt while the objects load, which closes any open menu, so wait for it to settle first.
    await page.waitForSelector('#explorer-tree .spinner', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForFunction(() => !document.querySelector('#explorer-tree .spinner') && document.querySelector('#explorer-tree .database .group'), null, { timeout: 60_000 });
    await page.click('#explorer-tree .server > summary', { button: 'right' });
    assert.equal(await page.locator('.context-menu button svg').count(), 4, 'every menu entry has an icon');
    await page.screenshot({ path: OUT_DIR + '/smoke-context-menu.png' });
    await page.click('.context-menu button:has-text("Xóa khỏi danh sách")');
    await page.waitForFunction(() => document.querySelectorAll('#explorer-tree .server').length === 0);
    assert.equal(await page.textContent('#status-state'), 'Chưa có kết nối');
    ok('removes a remembered database from the tree');
  } else {
    console.log('skip local FoxPro database (run `npm run fixtures`)');
  }

  // ---- Connect dialog ----------------------------------------------------------------------
  await page.click('#btn-connect');
  assert.equal(await page.isVisible('#connect-dialog'), true);
  // An unreachable server must surface an error instead of hanging the dialog.
  await page.fill('[name=server]', '127.0.0.1,1');
  await page.fill('[name=user]', 'x');
  await page.fill('[name=password]', 'x');
  await page.click('#connect-submit');
  await page.waitForSelector('#connect-error:not([hidden])', { timeout: 40_000 });
  assert.match(await page.textContent('#connect-error'), /Không kết nối được/);
  await page.screenshot({ path: `${OUT_DIR}/smoke-connect.png` });
  ok('reports an unreachable server in the connect dialog');

  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('\nsmoke ok');
} finally {
  await app.close();
  rmSync(workDir, { recursive: true, force: true });
}
