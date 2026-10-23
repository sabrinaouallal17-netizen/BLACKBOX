// End-to-end test of the Artifact edition against tests/mock-claude.js.
// Usage: PW=<playwright> URL=<served built page> OUT=<screenshot dir> node tests/artifact-e2e.js
const { chromium } = require(process.env.PW);
const path = require('path');
const MOCK = path.join(__dirname, 'mock-claude.js');
const errors = [];
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else console.log('PASS:', m); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addInitScript({ path: MOCK });
  const open = async (u) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${u}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text()) && !(page.expectWriteError && /write not allowed/.test(m.text()))) errors.push(`[${u}] console: ${m.text()}`); });
    page.on('dialog', (d) => { errors.push(`[${u}] native dialog`); d.dismiss(); });
    await page.goto(`${process.env.URL}?u=${u}`);
    return page;
  };
  const confirmAsk = async (p, ...vals) => { for (let i = 0; i < vals.length; i++) await p.fill(`#ask-f${i}`, vals[i]); await p.click('#ask-ok'); };
  const titles = (p) => p.locator('.card').first().locator('tbody tr .task-title').allTextContents();
  const newTask = async (p, title) => { await p.click('[data-action=new-task] >> nth=0'); await p.fill('#task-title', title); await p.click('#task-form button[type=submit]'); await p.waitForSelector(`text=${title}`); };
  const menu = async (p, title, item) => { await p.locator('tbody tr', { hasText: title }).locator('[data-menu]').click(); await p.click(`#task-menu [data-mi=${item}]`); };

  // Signed-out visitor
  const anon = await open('nobody');
  await anon.waitForSelector('#setup-screen:not([hidden])');
  ok((await anon.textContent('#setup-title')) === 'Sign in to use BLACKBOX', 'signed-out visitor sees sign-in message');

  // Owner
  const A = await open('alice');
  await A.waitForSelector('text=Create a project');
  ok(await A.locator('[data-action=sign-out], [data-action=account]').count() === 0, 'no sign-out or password UI in the Artifact');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('#set-name');
  await A.fill('#set-desc', 'Roll dice, collect rare characters.'); await A.fill('#set-platforms', 'Roblox'); await A.fill('#set-tags', 'RNG, Collection');
  await A.click('[data-form=project] button'); await A.waitForSelector('text=Roll dice, collect rare characters.');
  ok((await A.textContent('.meta')) === 'Baddie Dice · Roblox · RNG · Collection', 'project settings saved');
  await A.click('a[data-view=overview]'); await A.waitForSelector('h1:text("Project overview")');
  for (const t of ['T1', 'T2', 'T3']) await newTask(A, t);
  await menu(A, 'T3', 'up');
  await A.waitForFunction(() => [...document.querySelectorAll('.card tbody tr .task-title')].map((e) => e.textContent).join() === 'T1,T3,T2');
  ok(true, 'menu Up reorders');
  await menu(A, 'T2', 'delete'); await confirmAsk(A);
  await A.waitForSelector('tbody tr:has-text("T2")', { state: 'detached' });
  ok(JSON.stringify(await titles(A)) === '["T1","T3"]', 'menu Delete removes');
  await A.click('a[data-view=chat]'); await A.waitForSelector('#chat-text');
  await A.fill('#chat-text', 'Hello team'); await A.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg-text:text("Hello team")');
  ok((await A.textContent('.msg .from')).startsWith('Alice'), 'own name resolved from account');

  // Editor joins
  const B = await open('bob');
  await B.waitForSelector('[data-join]');
  ok((await B.textContent('#invites')).includes('Baddie Dice'), 'editor sees the project and a Join button');
  await B.click('[data-join]');
  await B.waitForSelector('[data-join]', { state: 'detached' });
  await B.click('.side-label a[href="#team"]'); await B.waitForSelector('.people li:nth-child(2)');
  ok((await B.textContent('.people')).includes('Alice') && (await B.textContent('.people')).includes('Bob'), 'team lists both, names from accounts');
  ok((await B.textContent('#view')).includes('Share'), 'team page explains inviting through Share');
  ok(await B.locator('#invite-email').count() === 0, 'no email invite form in the Artifact');
  await B.click('a[data-view=chat]'); await B.waitForSelector('text=Hello team');
  await B.fill('#chat-text', 'Hi Alice!'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('text=Hi Alice!');
  ok(true, 'chat syncs between viewers');
  await A.click('.side-label a[href="#team"]'); await A.waitForSelector('.people li:nth-child(2)');
  ok((await A.textContent('.people')).includes('bob@example.com'), 'owner sees member email from account');

  const stored = await A.evaluate(() => localStorage.getItem('mock:db'));
  ok(!/"name":"(Alice|Bob)"/.test(stored), 'no names stored in the database, only ids');

  // View-only viewer
  const V = await open('vera');
  V.expectWriteError = true;
  await V.waitForSelector('#invites .invite');
  ok((await V.textContent('#invites')).includes('You can view this workspace'), 'view-only banner');
  await V.click('a[data-view=overview]'); await V.waitForSelector('text=T1');
  await V.click('[data-action=new-task] >> nth=0'); await V.fill('#task-title', 'Sneaky'); await V.click('#task-form button[type=submit]');
  await V.waitForSelector('.toast.error');
  ok((await V.textContent('.toast')).includes('share it with you as Editor'), 'view-only write refused with a clear message');
  ok(!(await A.evaluate(() => localStorage.getItem('mock:db'))).includes('Sneaky'), 'refused write left no data');

  // Mobile
  await A.setViewportSize({ width: 390, height: 844 });
  for (const v of ['overview', 'chat', 'team']) {
    await A.evaluate((h) => { location.hash = h; }, v); await A.waitForTimeout(300);
    const w = await A.evaluate(() => document.documentElement.scrollWidth);
    ok(w <= 390, `mobile ${v} no horizontal scroll (${w})`);
  }
  await A.setViewportSize({ width: 1500, height: 950 });
  await A.evaluate(() => { location.hash = 'overview'; }); await A.waitForTimeout(300);
  await A.screenshot({ path: process.env.OUT + '/art-overview.png' });
  await B.evaluate(() => { location.hash = 'team'; }); await B.waitForTimeout(300);
  await B.screenshot({ path: process.env.OUT + '/art-team.png' });

  // Owner deletes the project
  await A.evaluate(() => { location.hash = 'project'; }); await A.waitForSelector('[data-action=delete-project]');
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('text=Create a project');
  await B.waitForSelector('text=Create a project');
  ok((await A.evaluate(() => localStorage.getItem('mock:db'))) === '{}', 'project and all its data deleted, other viewer updated');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 6).join('\n')); process.exit(2); });
