// The desktop program on the sandbox database, through the same steps as the web scenario, for the
// screen-by-screen comparison (docs/design/202610-kiem-tra-luong/proto/compare/desktop). Run `npm run build` first.
import { mkdirSync } from 'node:fs';
import { _electron as electron } from 'playwright-core';
const OUT = process.argv[2] || 'D:/SureHCS/docs/design/202610-kiem-tra-luong/proto/compare/desktop';
mkdirSync(OUT, { recursive: true });
const { ELECTRON_RUN_AS_NODE: _x, FQS_USER_DATA: _y, ...env } = process.env;
const app = await electron.launch({ args: ['.'], env: { ...env, FQS_USER_DATA: process.env.TEMP + '/fqs-compare-ud' } });
const page = await app.firstWindow();
await page.setViewportSize({ width: 1440, height: 800 });
const messages = () => page.textContent('#pane-messages');
const rows = () => page.$$eval('#pane-results .grid-row', (r) => r.length);
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: `${OUT}/${name}-1440x800.png` }); };
const answers = { '@UserID': 'tester', '@DowCode': '2026/09', 'Hệ số lương': '0.5', 'Công chế độ': '26' };
const answerAll = async () => {
  for (let i = 0; i < 4; i++) {
    const shown = await page.waitForSelector('#param-dialog[open]', { timeout: 2500 }).then(() => true).catch(() => false);
    if (!shown) return;
    const name = (await page.textContent('#param-name')).replace(/\s*\(.*$/, '').trim();
    await page.fill('#param-dialog input[name=value]', answers[name] ?? '1');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }
};
const clear = () => page.evaluate(() => { document.getElementById('pane-messages').textContent = ''; });
const finished = () => page.waitForFunction(() => /Thời gian|Lỗi/.test(document.getElementById('pane-messages').textContent), null, { timeout: 180000 });
await page.waitForSelector('.monaco-editor', { timeout: 60000 });
await page.waitForTimeout(1000);
await page.click('#btn-connect');
await page.waitForSelector('#connect-dialog[open]');
// The sandbox connection comes from the environment, never from the file: FQS_E2E_SERVER, FQS_E2E_DATABASE, FQS_E2E_USER, FQS_E2E_PASSWORD.
for (const name of ['FQS_E2E_SERVER', 'FQS_E2E_DATABASE', 'FQS_E2E_USER', 'FQS_E2E_PASSWORD']) if (!process.env[name]) throw new Error(`${name} is not set`);
await page.fill('#connect-form input[name=server]', process.env.FQS_E2E_SERVER);
await page.fill('#connect-form input[name=database]', process.env.FQS_E2E_DATABASE);
await page.fill('#connect-form input[name=user]', process.env.FQS_E2E_USER);
await page.fill('#connect-form input[name=password]', process.env.FQS_E2E_PASSWORD);
await page.check('#connect-form input[name=trust]');
await page.click('#connect-submit');
await page.waitForFunction(() => !document.querySelector('#explorer-tree .spinner') && document.querySelector('#explorer-tree .database.current .group'), null, { timeout: 240000 });
await page.waitForTimeout(800);
await shot('01-open');
await page.fill('#explorer-filter', 'sp_PayrollCheck');
await page.waitForTimeout(400);
await page.locator('#explorer-tree .procedure:has(> summary:has-text("xbase.sp_PayrollCheck")) > summary').first().click();
await answerAll();
await page.waitForFunction(() => document.getElementById('status-cursor').textContent.includes('Cursor:'), null, { timeout: 180000 });
await finished();
console.log('proc rows:', await rows());
await shot('02-procedure');
await page.fill('#explorer-filter', '');
await page.click('#editor');
await page.keyboard.press('Control+A');
await page.keyboard.insertText('SUM BasicSalary - BasicSalary * Hệ số lương');
await clear();
await page.keyboard.press('F5');
await answerAll();
await finished();
console.log('SUM:', (await messages()).replace(/\n/g, ' / ').slice(0, 200));
await shot('03-sum');
await page.click('#btn-bookmark');
await page.fill('#bookmark-form input[name=name]', 'e2e desktop ' + Date.now());
await page.click('#bookmark-form button[type=submit]');
await page.waitForTimeout(800);
await page.locator('#bookmark-list .journal-item:has-text("e2e desktop")').first().click({ button: 'right' });
await clear();
await page.locator('.context-menu button:has-text("Chạy")').first().click();
const asked = await page.waitForSelector('#param-dialog[open]', { timeout: 3000 }).then(() => true).catch(() => false);
if (asked) await answerAll();
try {
  await finished();
} catch (e) {
  console.log('bookmark run stuck; dialog open:', !!(await page.$('#param-dialog[open]')), '| tabs:', await page.$$eval('#tabs > *', (t) => t.length), '| messages:', (await messages()).slice(0, 200));
  await shot('04-bookmark-stuck');
}
console.log('bookmark run asked:', asked, '|', (await messages()).replace(/\n/g, ' / ').slice(0, 120));
await shot('04-bookmark-run');
await page.click('#btn-new');
await page.waitForTimeout(500);
await page.click('#editor');
await page.keyboard.insertText('SELECT COUNT(*) AS n FROM bl');
await clear();
await page.keyboard.press('F5');
await finished();
await shot('05-second-tab');
await app.close();
console.log('done');
