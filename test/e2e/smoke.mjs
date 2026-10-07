// Launches the built app and checks the shell without a database: editor, menu,
// toolbar, keyboard shortcuts, status bar, file open and save.
// Run `npm run build` first.
import assert from 'node:assert/strict';
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
  assert.equal(await page.textContent('#status-state'), 'Chưa kết nối');
  assert.equal(await page.isDisabled('#btn-run'), true, 'run is disabled until connected');
  assert.equal(await page.isDisabled('#btn-disconnect'), true);
  assert.match(await page.textContent('#app-version'), /^v\d+\.\d+\.\d+$/);
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
    assert.match(await messages(), /Đã mở .*northwind\.dbc: 11 bảng\./);
    assert.match(await page.textContent('#explorer-tree .server:not(.offline) > summary'), /^FoxPro \(.*northwind\.dbc\)$/);
    assert.equal(await page.textContent('#explorer-tree .group > summary'), 'Bảng (11)');
    assert.match(await page.textContent('#status-state'), /Đã kết nối/);
    assert.match(await page.textContent('#connection-status'), /^FoxPro: .*northwind\.dbc$/);
    assert.equal(await page.isDisabled('#btn-run'), false);
    ok('opens a FoxPro database file with no server connection');

    // FoxPro: "Ger" matches Germany, because FoxPro compares up to the shorter string.
    await page.keyboard.press('Control+N');
    assert.equal(await language(), 'FOX-SQL');
    let text = await run('SELECT ALLTRIM(customerid) AS ma, ALLTRIM(country) AS nuoc FROM customers WHERE country = "Ger" ORDER BY 1 INTO CURSOR duc');
    assert.doesNotMatch(text, /Lỗi/);
    text = await run('SELECT COUNT(*) AS n FROM duc');
    assert.match(text, /Bảng 1: 1 dòng/);
    assert.deepEqual(await visibleRows(), [['11']]);
    assert.equal(await page.textContent('#status-cursor'), 'Cursor: duc');
    assert.equal(await page.textContent('#query-state'), 'Truy vấn chạy xong');
    text = await run('SELECT TOP 3 ma, nuoc FROM duc ORDER BY ma');
    assert.deepEqual(await visibleRows(), [['ALFKI', 'Germany'], ['BLAUS', 'Germany'], ['DRACD', 'Germany']]);
    ok('runs FoxPro source in FoxPro itself and keeps its cursor between runs');
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
    await page.waitForFunction(() => document.getElementById('status-state').textContent === 'Chưa kết nối');
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

    // Right-click → remove forgets it.
    await page.click('#explorer-tree .server > summary', { button: 'right' });
    await page.click('.context-menu button:has-text("Xóa khỏi danh sách")');
    await page.waitForFunction(() => document.querySelectorAll('#explorer-tree .server').length === 0);
    assert.equal(await page.textContent('#status-state'), 'Chưa kết nối');
    ok('removes a remembered database from the tree');
  } else {
    console.log('skip local FoxPro database (run `npm run fixtures`)');
  }

  // ---- Connect dialog ----------------------------------------------------------------------
  await page.click('#btn-connect');
  assert.equal(await page.isVisible('#connect-dialog'), true);
  // An unreachable server must surface an error instead of hanging the dialog.
  await page.fill('[name=server]', '127.0.0.1');
  await page.fill('[name=port]', '1');
  await page.fill('[name=database]', 'x');
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
