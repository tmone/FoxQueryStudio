// Drives the built Electron app against a real SQL Server over TCP, the way a user would:
// connect dialog, object explorer, FoxPro in the editor, F5, result grid.
// Every result is checked against the same question asked directly with sqlcmd.
//
//   $env:FQS_E2E_SERVER='host'; $env:FQS_E2E_PORT='1433'; $env:FQS_E2E_DATABASE='db'
//   $env:FQS_E2E_USER='login'; $env:FQS_E2E_PASSWORD='...'
//   npm run build; node test/e2e/real-server.mjs
//
// It only reads: SELECT statements plus #temp tables in tempdb.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright-core';

const { FQS_E2E_SERVER: SERVER, FQS_E2E_PORT: PORT = '1433', FQS_E2E_DATABASE: DATABASE, FQS_E2E_USER: USER, FQS_E2E_PASSWORD: PASSWORD } = process.env;
if (!SERVER || !DATABASE || !USER || !PASSWORD) {
  console.error('Set FQS_E2E_SERVER, FQS_E2E_DATABASE, FQS_E2E_USER and FQS_E2E_PASSWORD.');
  process.exit(2);
}

const OUT_DIR = 'test-results';
const ROW_LIMIT = 5000;
mkdirSync(OUT_DIR, { recursive: true });

/** Asks SQL Server directly; rows come back as arrays of strings. */
function sqlcmd(query) {
  const out = execFileSync(
    'sqlcmd',
    ['-S', `${SERVER},${PORT}`, '-d', DATABASE, '-U', USER, '-P', PASSWORD, '-C', '-b', '-I', '-l', '20', '-h', '-1', '-W', '-s', '|', '-f', '65001', '-Q', `SET NOCOUNT ON; ${query}`],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return out.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split('|').map((cell) => cell.trim()));
}

const steps = [];
const step = (name, detail) => {
  steps.push(name);
  console.log(`ok  ${name}${detail ? `  (${detail})` : ''}`);
};

// Shells spawned by an Electron host (VS Code) set this and make electron.exe run as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
const app = await electron.launch({ args: ['.'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 });

  const messages = () => page.textContent('#pane-messages');
  const tsql = () => page.textContent('#pane-tsql');

  /** Replaces the editor content and runs it with F5; resolves when the run has finished. */
  async function run(source) {
    await page.click('.monaco-editor');
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(source);
    await page.evaluate(() => (document.getElementById('pane-messages').textContent = ''));
    await page.keyboard.press('F5');
    await page.waitForFunction(() => document.getElementById('pane-messages').textContent !== '', null, { timeout: 120_000 });
    return messages();
  }

  /** Rows currently drawn in the result grid (the grid is virtualized). */
  const visibleRows = () =>
    page.$$eval('#pane-results .grid-row', (rows) => rows.map((row) => [...row.querySelectorAll('.grid-cell:not(.rownum)')].map((cell) => cell.textContent)));
  const columns = () => page.$$eval('#pane-results .grid-header .grid-cell:not(.rownum)', (cells) => cells.map((cell) => cell.textContent));
  const rowCount = (text, table = 1) => Number(new RegExp(`Bảng ${table}: (\\d+) dòng`).exec(text)?.[1]);

  // ---- Connect -------------------------------------------------------------------------
  await page.click('#btn-connect');
  await page.fill('[name=server]', SERVER);
  await page.fill('[name=port]', PORT);
  await page.fill('[name=database]', DATABASE);
  await page.fill('[name=user]', USER);
  await page.fill('[name=password]', PASSWORD);
  await page.check('[name=trust]');
  const connectStarted = Date.now();
  await page.click('#connect-submit');
  await page.waitForFunction(() => !document.getElementById('connect-dialog').open || !document.getElementById('connect-error').hidden, null, { timeout: 120_000 });
  assert.equal(await page.isVisible('#connect-error'), false, `connect failed: ${await page.textContent('#connect-error')}`);
  const connectSeconds = ((Date.now() - connectStarted) / 1000).toFixed(1);
  assert.match(await page.textContent('#connection-status'), new RegExp(DATABASE));
  assert.equal(await page.isDisabled('#btn-run'), false);
  step('connects over TCP and loads the schema', `${connectSeconds} s`);

  // ---- Object explorer -----------------------------------------------------------------
  const [[tableCount, viewCount]] = sqlcmd(
    "SELECT SUM(CASE WHEN TABLE_TYPE = 'BASE TABLE' THEN 1 ELSE 0 END), SUM(CASE WHEN TABLE_TYPE = 'VIEW' THEN 1 ELSE 0 END) FROM INFORMATION_SCHEMA.TABLES",
  );
  const groups = await page.$$eval('#explorer-tree .group > summary', (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(groups, [`Bảng (${tableCount})`, `View (${viewCount})`]);
  // Nodes are nested like the SSMS object explorer: server, database, then folders.
  assert.equal(await page.textContent('#explorer-tree > .server > summary'), `${SERVER} (${USER})`);
  assert.equal(await page.textContent('#explorer-tree > .server > .database > summary'), DATABASE);
  assert.equal(await page.locator('#explorer-tree > .server > .database > .group').count(), 2);
  assert.equal(await page.textContent('#explorer-tree .database > .cursors > summary'), 'Cursor của tab (0)');
  assert.equal(await page.textContent('#status-state'), 'Đã kết nối');
  assert.equal(await page.isEnabled('#btn-disconnect'), true);

  await page.fill('#explorer-filter', 'HCSEM_Employees');
  await page.locator('#explorer-tree .table > summary', { hasText: /^dbo\.HCSEM_Employees$/ }).click();
  // Columns are added when the node's toggle event fires, shortly after the click.
  await page.waitForSelector('#explorer-tree .table[open] li');
  const shownColumns = await page.locator('#explorer-tree .table[open] li').count();
  const [[columnCount]] = sqlcmd("SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'HCSEM_Employees'");
  assert.equal(shownColumns, Number(columnCount));
  await page.fill('#explorer-filter', '');
  step('lists every table and view, and the columns of a table', `${tableCount} tables, ${viewCount} views, ${columnCount} columns`);
  await page.screenshot({ path: `${OUT_DIR}/real-explorer.png` });

  // ---- Vietnamese prefix comparison, logical field, string and date functions -----------
  let text = await run(
    [
      '* nhân viên họ Nguyễn đang làm việc',
      'SELECT EmployeeCode, ALLTRIM(LastName) + " " + ALLTRIM(FirstName) AS hoten, DTOC(JoinDate) AS ngayvao, YEAR(JoinDate) AS nam ;',
      '  FROM HCSEM_Employees ;',
      '  WHERE LastName = "Nguyễn" AND Active AND !ISNULL(JoinDate) ;   && so khớp tiền tố',
      '  ORDER BY EmployeeCode',
    ].join('\n'),
  );
  let expected = sqlcmd(
    "SELECT EmployeeCode, LTRIM(RTRIM(LastName)) + ' ' + LTRIM(RTRIM(FirstName)), CONVERT(varchar(10), JoinDate, 103), YEAR(JoinDate) FROM HCSEM_Employees WHERE LastName LIKE N'Nguyễn%' AND Active = 1 AND JoinDate IS NOT NULL ORDER BY EmployeeCode",
  );
  assert.ok(expected.length > 5, 'the reference query should return rows');
  assert.equal(rowCount(text), expected.length);
  assert.deepEqual(await columns(), ['EmployeeCode', 'hoten', 'ngayvao', 'nam']);
  assert.deepEqual((await visibleRows()).slice(0, 8), expected.slice(0, 8));
  assert.match(await tsql(), /LastName LIKE N'Nguyễn%' AND Active = 1/);
  assert.equal(await page.textContent('#status-rows'), `${expected.length} dòng`);
  assert.match(await page.textContent('#run-status'), /^\d+\.\d\d giây$/);
  step('filters Vietnamese text by prefix with a bare logical field', `${expected.length} rows, first: ${expected[0].join(' | ')}`);
  await page.screenshot({ path: `${OUT_DIR}/real-query.png` });

  // ---- GROUP BY position, HAVING alias --------------------------------------------------
  text = await run('SELECT DepartmentCode, COUNT(*) AS n FROM HCSEM_Employees WHERE !EMPTY(DepartmentCode) GROUP BY 1 HAVING n >= 20 ORDER BY n DESC, 1');
  expected = sqlcmd("SELECT DepartmentCode, COUNT(*) FROM HCSEM_Employees WHERE DepartmentCode IS NOT NULL AND DepartmentCode <> '' GROUP BY DepartmentCode HAVING COUNT(*) >= 20 ORDER BY COUNT(*) DESC, DepartmentCode");
  assert.equal(rowCount(text), expected.length);
  assert.deepEqual((await visibleRows()).slice(0, 5), expected.slice(0, 5));
  step('groups by column position and filters on a column alias', `${expected.length} departments`);

  // ---- Date arithmetic on a datetime column, typed from this table ----------------------
  text = await run('SELECT TOP 5 EmployeeCode, DATE(2026, 10, 6) - TTOD(JoinDate) AS songay, GOMONTH(TTOD(JoinDate), 12) AS namsau FROM HCSEM_Employees WHERE !ISNULL(JoinDate) ORDER BY EmployeeCode');
  expected = sqlcmd("SELECT TOP 5 EmployeeCode, DATEDIFF(day, CAST(JoinDate AS date), '20261006'), CONVERT(varchar(10), DATEADD(month, 12, CAST(JoinDate AS date)), 23) FROM HCSEM_Employees WHERE JoinDate IS NOT NULL ORDER BY EmployeeCode");
  assert.deepEqual(await visibleRows(), expected);
  step('computes day differences and month shifts on real dates', expected[0].join(' | '));

  // ---- Cursor built in one run, read in the next ----------------------------------------
  text = await run('SELECT EmployeeCode, MAX(RealSalary) AS luong, COUNT(*) FROM HCSEM_EmpBasicSalaryTracking GROUP BY EmployeeCode INTO CURSOR curLuong');
  assert.match(text, /không trả về bảng kết quả/);
  text = await run('SELECT e.EmployeeCode, c.luong, c.cnt FROM curLuong c JOIN HCSEM_Employees e ON e.EmployeeCode = c.EmployeeCode WHERE c.luong > 20000000 ORDER BY c.luong DESC, e.EmployeeCode');
  expected = sqlcmd(
    'SELECT e.EmployeeCode, CAST(c.luong AS float), c.cnt FROM (SELECT EmployeeCode, MAX(RealSalary) AS luong, COUNT(*) AS cnt FROM HCSEM_EmpBasicSalaryTracking GROUP BY EmployeeCode) c JOIN HCSEM_Employees e ON e.EmployeeCode = c.EmployeeCode WHERE c.luong > 20000000 ORDER BY c.luong DESC, e.EmployeeCode',
  );
  assert.equal(rowCount(text), expected.length);
  assert.deepEqual((await visibleRows()).slice(0, 5).map((r) => [r[0], Number(r[1]), Number(r[2])]), expected.slice(0, 5).map((r) => [r[0], Number(r[1]), Number(r[2])]));
  text = await run('BROWSE FOR cnt > 15');
  const [[manyChanges]] = sqlcmd('SELECT COUNT(*) FROM (SELECT EmployeeCode FROM HCSEM_EmpBasicSalaryTracking GROUP BY EmployeeCode HAVING COUNT(*) > 15) x');
  assert.equal(rowCount(text), Number(manyChanges));
  assert.equal(await page.textContent('#explorer-tree .cursors > summary'), 'Cursor của tab (1)');
  assert.match(await page.textContent('#explorer-tree .cursors li'), /^curluong/);
  assert.equal(await page.textContent('#status-cursor'), 'Cursor: curluong');
  step('keeps a cursor between runs of the same tab and reads it with BROWSE', `${expected.length} joined rows, ${manyChanges} browsed`);

  // ---- Row limit: more rows than the grid keeps ----------------------------------------
  const [[trackingRows]] = sqlcmd('SELECT COUNT(*) FROM HCSEM_EmpBasicSalaryTracking');
  assert.ok(Number(trackingRows) > ROW_LIMIT, 'the table must exceed the row limit for this check');
  text = await run('SELECT EmployeeCode, EffectDate, RealSalary FROM HCSEM_EmpBasicSalaryTracking');
  assert.equal(rowCount(text), ROW_LIMIT);
  assert.match(text, /Kết quả bị cắt ở 5000 dòng/);
  await page.$eval('#pane-results .grid', (grid) => (grid.scrollTop = grid.scrollHeight));
  await page.waitForFunction(() => [...document.querySelectorAll('#pane-results .grid-cell.rownum')].some((c) => c.textContent === '5000'));
  step('stops at the row limit and scrolls the virtual grid to the last row', `${trackingRows} rows on the server, ${ROW_LIMIT} kept`);

  // The session must still work after the cancelled request, cursor included.
  text = await run('SELECT COUNT(*) AS n FROM curLuong');
  const [[employeesWithSalary]] = sqlcmd('SELECT COUNT(DISTINCT EmployeeCode) FROM HCSEM_EmpBasicSalaryTracking');
  assert.deepEqual(await visibleRows(), [[employeesWithSalary]]);
  step('keeps the session and its cursor after the row limit cancelled a request');

  // ---- Server error, then recovery in the same tab --------------------------------------
  text = await run('SELECT KhongCoCotNay FROM HCSEM_Employees');
  assert.match(text, /Lỗi từ máy chủ: .*KhongCoCotNay/);
  assert.doesNotMatch(text, /Phiên làm việc đã được mở lại/);
  text = await run('SELECT COUNT(*) AS n FROM curLuong');
  assert.deepEqual(await visibleRows(), [[employeesWithSalary]]);
  step('shows a server error and keeps the session and its cursor afterwards');

  // ---- Conversion error: nothing is sent ------------------------------------------------
  text = await run('SELECT 1 AS a\nREPLACE RealSalary WITH 0');
  assert.match(text, /Lỗi dòng 2: Lệnh REPLACE chưa được hỗ trợ/);
  step('refuses a write command with the line number');

  // ---- A second tab has its own session -------------------------------------------------
  await page.click('#btn-new');
  assert.equal(await page.locator('.tab').count(), 2);
  text = await run('BROWSE');
  assert.match(text, /Chưa có cursor nào/);
  text = await run('SELECT TOP 3 EmployeeCode FROM HCSEM_Employees ORDER BY EmployeeCode');
  expected = sqlcmd('SELECT TOP 3 EmployeeCode FROM HCSEM_Employees ORDER BY EmployeeCode');
  assert.deepEqual(await visibleRows(), expected);
  await page.locator('.tab').first().click();
  text = await run('SELECT COUNT(*) AS n FROM curLuong');
  assert.deepEqual(await visibleRows(), [[employeesWithSalary]]);
  step('gives a second tab its own session without disturbing the first');

  // ---- Context menu of a table node: preview its first rows in a new tab ------------------
  await page.fill('#explorer-filter', 'HCSSYS_Departments');
  await page.evaluate(() => (document.getElementById('pane-messages').textContent = ''));
  await page.locator('#explorer-tree .table > summary', { hasText: /^dbo\.HCSSYS_Departments$/ }).click({ button: 'right' });
  await page.locator('.context-menu button', { hasText: 'Xem 100 dòng đầu' }).click();
  await page.waitForFunction(() => document.getElementById('pane-messages').textContent !== '', null, { timeout: 60_000 });
  assert.equal(await page.locator('.tab').count(), 3);
  assert.equal(rowCount(await messages()), 100);
  assert.equal(await page.isHidden('.context-menu'), true);
  // The cursor list belongs to the active tab, and this new tab has none.
  assert.equal(await page.textContent('#explorer-tree .cursors > summary'), 'Cursor của tab (0)');
  await page.fill('#explorer-filter', '');
  await page.locator('.tab').first().click();
  assert.equal(await page.textContent('#explorer-tree .cursors > summary'), 'Cursor của tab (1)');
  step('previews a table from the context menu of its node');
  await page.screenshot({ path: `${OUT_DIR}/real-tree.png` });

  // ---- Output panes ---------------------------------------------------------------------
  await page.click('.output-tabs > button[data-pane=tsql]');
  assert.equal(await page.isVisible('#pane-tsql'), true);
  assert.match(await tsql(), /#curluong/);
  await page.click('.output-tabs > button[data-pane=results]');
  await page.screenshot({ path: `${OUT_DIR}/real-final.png` });

  // ---- Refresh and disconnect ------------------------------------------------------------
  await page.keyboard.press('Control+Shift+R');
  await page.waitForFunction((label) => document.querySelector('#explorer-tree .group > summary')?.textContent === label, `Bảng (${tableCount})`, { timeout: 60_000 });
  await page.click('#btn-disconnect');
  await page.waitForFunction(() => document.getElementById('status-state').textContent === 'Chưa kết nối');
  assert.equal(await page.isDisabled('#btn-run'), true);
  assert.match(await page.textContent('#explorer-tree'), /Kết nối để xem/);
  assert.equal(await page.textContent('#status-cursor'), '');
  step('reloads the object list and disconnects');

  assert.deepEqual(errors, [], 'no renderer errors');
  console.log(`\n${steps.length} checks passed against ${SERVER},${PORT} / ${DATABASE}`);
} finally {
  await app.close();
}
