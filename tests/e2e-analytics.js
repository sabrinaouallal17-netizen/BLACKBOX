// End-to-end test of the Analytics page (Firebase edition, emulators).
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e-analytics.js
// Needs the app served at http://127.0.0.1:5173 and `firebase emulators:start --only auth,firestore`.
const { chromium } = require(process.env.PW);
const fs = require('fs');
const SDK = process.env.SDK;
const BASE = 'http://127.0.0.1:5173/index.html?emulator';
const OOB = 'http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes';
const errors = [];
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else console.log('PASS:', m); };
const run = Date.now();
const email = (n) => `${n}.${run}@test.com`;
const GIF = Buffer.from('R0lGODlhAgACAIABAP8A/////yH/C05FVFNDQVBFMi4wAwEAAAAh+QQJCgABACwAAAAAAgACAAACAoRRACH5BAkKAAEALAAAAAACAAIAAAIChFEAOw==', 'base64');

async function newUser(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/idiomorph@[\d.]+\/dist\/idiomorph\.min\.js/, (route) => route.fulfill({ body: fs.readFileSync(`${SDK}/../idiomorph/dist/idiomorph.min.js`), contentType: 'application/javascript' }));
  await ctx.route(/gstatic\.com\/firebasejs\/[\d.]+\/(.+)$/, (route) => {
    const f = route.request().url().match(/firebasejs\/[\d.]+\/(.+)$/)[1];
    route.fulfill({ body: fs.readFileSync(`${SDK}/${f}`), contentType: 'application/javascript' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/fonts\.g|Failed to load resource/.test(t)) return;
    if (page.expectAuthFail && /auth\/(user-not-found|wrong-password|invalid-credential)/.test(t)) return;
    if (page.expectDenied && /permission|Missing or insufficient/i.test(t)) return;
    errors.push(`[${label}] console: ${t.slice(0, 400)}`);
  });
  page.on('dialog', (d) => { errors.push(`[${label}] native dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(BASE);
  return page;
}
// A real, colored PNG made in the browser.
async function png(page, color, w = 320, h = 400, label = '') {
  const b64 = await page.evaluate(([c, w, h, label]) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h); grad.addColorStop(0, c); grad.addColorStop(1, '#111');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(h / 8)}px sans-serif`; g.fillText(label, w * 0.1, h * 0.55);
    return cv.toDataURL('image/png').split(',')[1];
  }, [color, w, h, label]);
  return Buffer.from(b64, 'base64');
}
const file = (name, buffer, mimeType = 'image/png') => ({ name, mimeType, buffer });
async function signUp(page, name, mail) {
  await page.waitForSelector('#auth-screen:not([hidden])');
  await page.click('[data-auth-mode=signup]');
  await page.fill('#auth-name', name);
  await page.fill('#auth-email', mail);
  await page.fill('#auth-password', 'secret123');
  await page.click('#auth-submit');
  await page.waitForSelector('#verify-screen:not([hidden])');
}
async function verify(page, mail) {
  await page.click('#verify-continue');
  await page.waitForSelector('#verify-error:not([hidden])');
  const codes = (await (await fetch(OOB)).json()).oobCodes.filter((c) => c.email === mail && c.requestType === 'VERIFY_EMAIL');
  await fetch(codes.at(-1).oobLink);
  await page.click('#verify-continue');
  await page.waitForSelector('#app:not([hidden])');
}
const confirmAsk = async (page, ...vals) => { for (let i = 0; i < vals.length; i++) await page.fill(`#ask-f${i}`, vals[i]); await page.click('#ask-ok'); };
// Waits for the requested page itself (page changes render after a short cross-fade).
const go = async (page, view, sel = '#view h1') => { await page.goto(BASE + '#' + view); await page.waitForSelector(`#view.view-${view.split('.')[0]}`); await page.waitForSelector(sel); };
const rows = (page) => page.locator('.card').first().locator('tbody tr .task-title').allTextContents();
const orderIs = (page, s) => page.waitForFunction((s) => [...document.querySelectorAll('.card tbody tr .task-title')].map((e) => e.textContent).join() === s, s);
async function newTask(page, title, type = 'task') {
  await page.click('[data-action=new-task] >> nth=0');
  await page.fill('#task-title', title);
  await page.selectOption('#task-type', type);
  await page.click('#task-form button[type=submit]');
  await page.waitForSelector(`text=${title}`);
}
async function menu(page, title, item) {
  await page.locator('tbody tr', { hasText: title }).locator('[data-task-menu]').click();
  await page.waitForSelector('#popover:not([hidden])');
  if (item) await page.locator('#popover button', { hasText: item }).click();
}
async function choose(page, selector, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await fc.setFiles(files);
}
// Waits until a notification of this type has arrived (the bell dot can also mean "what's new").
const waitNotif = (page, type) => page.waitForFunction((t) => allNotifs().some((n) => n.type === t && !n.read), type);
const pick = (page, label) => page.locator('#popover button', { hasText: label }).first().click();
const fsGet = async (path) => (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' } })).json();


const DAY = 864e5;
const d0 = new Date(); d0.setHours(0, 0, 0, 0);
const ymdN = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayAgo = (n) => { const d = new Date(d0); d.setDate(d.getDate() - n); return ymdN(d); };
const count = (page) => page.evaluate(() => analyticsEntries.length);
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const waitCount = async (page, n) => { await page.waitForFunction((n) => analyticsEntries.length === n, n); await settle(page); };
const statText = (page, id) => page.textContent(`#an-stat-${id} .an-stat-value`);
const statSub = (page, id) => page.textContent(`#an-stat-${id} .an-stat-sub`);
async function addCcu(page, date, time, value) {
  const n = await count(page);
  await page.fill('#an-add-ccu-date', date); await page.fill('#an-add-ccu-time', time); await page.fill('#an-add-ccu-value', String(value));
  await page.click('.an-add > button');
  await waitCount(page, n + 1);
}
async function tab(page, kind) { await page.click(`[data-an-tab=${kind}]`); await page.waitForSelector(`[data-an-form=add][data-kind=${kind}]`); }
async function addPeriod(page, kind, from, to, vals) {
  const n = await count(page);
  await page.fill(`#an-add-${kind}-from`, from); await page.fill(`#an-add-${kind}-to`, to);
  for (const [k, v] of Object.entries(vals)) await page.fill(`#an-add-${kind}-${k}`, String(v));
  await page.click('.an-add > button');
  await waitCount(page, n + 1);
}
const period = async (page, p) => { await page.click(`[data-an-period="${p}"]`); await page.waitForSelector(`[data-an-period="${p}"].on`); await settle(page); };

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Stats Game');
  await A.waitForSelector('#set-name');
  const pid = await A.evaluate(() => currentId);

  // Empty page
  await go(A, 'analytics', '.an-cards');
  ok(await A.isVisible('text=Add your first CCU entry'), 'empty state: Add your first CCU entry');
  ok(await A.locator('.an-empty').count() === 3, 'each chart has its own empty state');
  ok(await A.isVisible('a[data-view=analytics].active'), 'Analytics nav link active');

  // Validation
  await A.fill('#an-add-ccu-value', '-5'); await A.click('.an-add > button');
  await A.waitForSelector('#an-error-add');
  ok((await A.textContent('#an-error-add')).includes("can't be negative"), 'negative number shows a validation error');
  ok(await count(A) === 0, 'nothing saved on validation error');
  await A.fill('#an-add-ccu-value', ''); await A.click('.an-add > button');
  ok((await A.textContent('#an-error-add')).includes('Enter the number of players'), 'empty number shows a validation error');

  // CCU entries
  await addCcu(A, dayAgo(0), '10:00', 120);
  ok(!(await A.isVisible('#an-error-add')), 'error cleared after a valid entry');
  await addCcu(A, dayAgo(0), '14:30', 340);
  await addCcu(A, dayAgo(1), '20:00', 250);
  await addCcu(A, dayAgo(10), '12:00', 500);
  await addCcu(A, dayAgo(60), '18:00', 900);
  ok(true, 'added 5 CCU entries');
  ok(await statText(A, 'latest') === '340', 'latest CCU = 340');
  ok(await statText(A, 'peak') === '500', 'peak CCU in 30 days = 500');
  ok(await statText(A, 'avg') === '303', 'average CCU in 30 days = 303 (302.5)');
  ok(await A.locator('.an-line').count() === 1 && await A.locator('.an-area').count() === 1 && await A.locator('.an-pt').count() === 4, 'CCU line/area chart with 4 points');
  ok((await A.getAttribute('[data-an-plot=ccu] svg', 'aria-label')).includes('peak 500'), 'CCU chart has an accessible label');
  ok(await A.locator('.an-table tbody tr').count() === 5 && (await A.textContent('.an-table tbody')).includes('Alice'), 'table lists CCU rows with who added them');

  // Tooltip
  const pt = A.locator('.an-pt .an-hit').first();
  await pt.hover();
  await A.waitForSelector('.an-tip:not([hidden])');
  ok(/players/.test(await A.textContent('.an-tip')), 'hover tooltip shows value + date: ' + (await A.textContent('.an-tip')).replace(/\s+/g, ' '));

  // Sort
  const first = () => A.locator('.an-table tbody tr td:first-child').first().textContent();
  const newest = await first();
  await A.click('[data-an-sort]');
  ok(await first() !== newest, 'sort by date toggles order');
  await A.click('[data-an-sort]');

  // Revenue
  await tab(A, 'revenue');
  ok(await A.isVisible('text=Add your first revenue entry'), 'revenue chart empty state');
  await A.fill('#an-add-revenue-from', dayAgo(3)); await A.fill('#an-add-revenue-to', dayAgo(5)); await A.fill('#an-add-revenue-value', '10');
  await A.click('.an-add > button'); await A.waitForSelector('#an-error-add');
  ok((await A.textContent('#an-error-add')).includes('on or before'), 'from > to shows a validation error');
  ok(await count(A) === 5, 'invalid period not saved');
  await addPeriod(A, 'revenue', dayAgo(5), dayAgo(0), { value: 1500 });
  await addPeriod(A, 'revenue', dayAgo(20), dayAgo(6), { value: 2500.25 });
  await addPeriod(A, 'revenue', dayAgo(45), dayAgo(31), { value: 2000 });
  ok(await statText(A, 'revenue') === '4,000', 'revenue 30 days (Robux default) = 4,000: ' + await statText(A, 'revenue'));
  ok(await A.locator('#an-stat-revenue .an-robux svg').count() === 1, 'Robux icon shown');
  ok((await statSub(A, 'revenue')).includes('+100%'), 'revenue change vs previous period +100%: ' + await statSub(A, 'revenue'));
  ok(await A.locator('.an-bar-fill').count() === 2, 'revenue bars rendered (2 in 30 days)');

  // Sources
  await tab(A, 'sources');
  await addPeriod(A, 'sources', dayAgo(3), dayAgo(0), { others: 50, search: 120, friends: 30 });
  ok(await statText(A, 'users') === '200', 'new users = 200');
  ok((await statSub(A, 'users')).includes('Search') && (await statSub(A, 'users')).includes('60%'), 'top source Search 60%');
  ok(await A.locator('.an-arc').count() === 3 && (await A.textContent('.an-legend')).includes('60.0%'), 'sources donut with legend and percentages');

  // Period filter
  await period(A, '7d');
  ok(await statText(A, 'peak') === '340' && await statText(A, 'avg') === '237', '7 days: peak 340, average 237');
  ok(await statText(A, 'revenue') === '1,500', '7 days: revenue 1,500');
  ok((await statSub(A, 'revenue')).includes('No data for the previous period'), '7 days: no previous revenue');
  ok(await A.locator('.an-bar-fill').count() === 1, '7 days: 1 revenue bar');
  await period(A, 'all');
  ok(await statText(A, 'peak') === '900' && await statText(A, 'revenue') === '6,000', 'All: peak 900, revenue 6,000');
  await period(A, 'custom');
  await A.fill('#an-from', dayAgo(61)); await A.dispatchEvent('#an-from', 'change');
  await A.fill('#an-to', dayAgo(59)); await A.dispatchEvent('#an-to', 'change');
  await A.waitForFunction(() => document.querySelector('#an-stat-peak .an-stat-value')?.textContent === '900' && document.querySelector('#an-stat-avg .an-stat-value')?.textContent === '900');
  ok(true, 'custom period shows only the entry 60 days ago');
  ok(await A.isVisible('text=No revenue entries in this period'), 'empty period state for revenue');
  await period(A, '30d');

  // Edit + delete (CCU)
  await tab(A, 'ccu');
  const row120 = A.locator('.an-table tbody tr', { hasText: '120' }).first();
  await row120.locator('[data-an-edit]').click();
  await A.waitForSelector('#an-edit-value');
  ok(await A.inputValue('#an-edit-value') === '120', 'edit row prefilled');
  await A.fill('#an-edit-value', '-1'); await A.click('[data-an-form=edit] button.primary');
  await A.waitForSelector('#an-error-edit');
  ok(true, 'edit validation error shown');
  await A.fill('#an-edit-value', '150'); await A.click('[data-an-form=edit] button.primary');
  await A.waitForFunction(() => analyticsEntries.some((e) => e.value === 150));
  await A.waitForFunction(() => !document.querySelector('#an-edit-value')); await settle(A);
  ok(await statText(A, 'avg') === '310', 'edited value updates average (150+340+250+500)/4 = 310');
  const row340 = A.locator('.an-table tbody tr', { hasText: '340' }).first();
  await row340.locator('[data-an-delete]').click(); await confirmAsk(A);
  await waitCount(A, 8);
  ok(await statText(A, 'latest') === '150', 'deleted row: latest CCU becomes 150');

  // Activity
  await A.waitForFunction(() => ['analytics.add', 'analytics.update', 'analytics.delete'].every((t) => activity.some((a) => a.type === t)));
  ok(await A.evaluate(() => activity.filter((a) => a.type?.startsWith('analytics.')).every((a) => /^analytics:/.test(a.ref))), 'activity log: analytics.add/update/delete with ref');

  // Revenue settings
  await go(A, 'project', '.an-rev-card');
  ok(await A.isChecked('#an-rev-robux'), 'Revenue card: Robux by default');
  await A.click('label:has(#an-rev-money) span');
  await A.waitForSelector('#cs-an-rev-preset');
  await A.click('#cs-an-rev-preset'); await pick(A, 'EUR');
  await A.waitForFunction(() => document.querySelector('#an-rev-preview')?.textContent.startsWith('€'));
  ok((await A.textContent('#an-rev-preview')) === '€1,234,567.50', 'preview €1,234,567.50');
  await A.locator('.an-rev-card').screenshot({ path: process.env.OUT + '/an-revenue-card.png' });
  await A.click('.an-rev-card button.primary');
  await A.waitForFunction(() => project().revenue?.currency === 'EUR');
  ok(JSON.stringify(await A.evaluate(() => project().revenue)) === '{"mode":"money","currency":"EUR","symbol":"€"}', 'saved revenue {money, EUR, €}');
  await go(A, 'analytics', '.an-cards');
  ok(await statText(A, 'revenue') === '€4,000.25', 'MONEY EUR: revenue €4,000.25');
  ok(await A.evaluate(() => revenueFormat(1234.5)) === '€1,234.50', 'revenueFormat money');
  await A.screenshot({ path: process.env.OUT + '/an-desktop.png', fullPage: true });

  await go(A, 'project', '.an-rev-card');
  await A.click('#cs-an-rev-preset'); await pick(A, 'Custom');
  await A.fill('#an-rev-code', 'chf'); await A.fill('#an-rev-symbol', 'Fr ');
  await A.click('.an-rev-card button.primary');
  await A.waitForFunction(() => project().revenue?.currency === 'CHF');
  ok(await A.evaluate(() => revenueFormat(10)) === 'Fr10.00', 'custom currency CHF / Fr');
  await A.click('label:has(#an-rev-robux) span');
  await A.click('.an-rev-card button.primary');
  await A.waitForFunction(() => project().revenue?.mode === 'robux');
  await go(A, 'analytics', '.an-cards');
  ok(await statText(A, 'revenue') === '4,000' && await A.evaluate(() => revenueFormat(12345.6)) === 'R$ 12,346', 'ROBUX: 4,000 with icon; revenueFormat R$ 12,346');

  // Viewer: read-only
  await go(A, 'team', '#invite-email');
  await A.fill('#invite-email', email('bob')); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  const B = await newUser(browser, 'Bob');
  await signUp(B, 'Bob', email('bob')); await verify(B, email('bob'));
  await B.waitForSelector('.invite'); await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');
  await go(B, 'analytics', '.an-cards');
  await B.waitForSelector('.an-add');
  ok(await B.locator('[data-an-edit]').count() > 0 && await B.locator('[data-an-delete]').count() === 0, "member can edit but not delete others' rows");
  await go(A, 'team', '.people');
  const bobUid = await B.evaluate(() => user.uid);
  await A.click(`#cs-role-${bobUid}`); await pick(A, 'Viewer');
  await B.waitForFunction(() => !can('edit'));
  await go(B, 'analytics', '.an-cards');
  ok(await B.locator('.an-add').count() === 0 && await B.locator('[data-an-edit]').count() === 0 && await B.isVisible('.an-data .notice'), 'viewer: read-only table');
  ok(await B.textContent('#an-stat-latest .an-stat-value') === '150', 'viewer sees the numbers');
  B.expectDenied = true;
  const denied = await B.evaluate(async () => { try { await sub('analytics').add({ kind: 'ccu', at: Date.now(), value: 1, createdBy: user.uid }); return 'allowed'; } catch (e) { return e.code; } });
  ok(denied === 'permission-denied', 'rules refuse viewer writes');
  await go(B, 'project', '.an-rev-card');
  ok(await B.getAttribute('.an-rev-card', 'inert') !== null && await B.locator('.an-rev-card button.primary').count() === 0, 'viewer: Revenue settings read-only');

  // Mobile
  await A.setViewportSize({ width: 390, height: 844 });
  await go(A, 'analytics', '.an-cards'); await A.waitForTimeout(400);
  const cols = await A.evaluate(() => getComputedStyle(document.querySelector('.an-cards')).gridTemplateColumns.split(' ').length);
  ok(cols === 2, 'mobile: cards in 2 columns');
  const w = await A.evaluate(() => document.documentElement.scrollWidth);
  ok(w <= 390, `mobile: no horizontal page scroll (${w})`);
  const tw = await A.evaluate(() => { const t = document.querySelector('.an-table-wrap'); return [t.scrollWidth, t.clientWidth]; });
  ok(tw[0] > tw[1], 'mobile: table scrolls horizontally inside its card');
  const svgW = await A.evaluate(() => [document.querySelector('[data-an-plot=ccu] svg').getBoundingClientRect().width, document.querySelector('.an-wide').getBoundingClientRect().width]);
  ok(svgW[0] > svgW[1] - 40, 'mobile: chart full width');
  await A.screenshot({ path: process.env.OUT + '/an-mobile.png', fullPage: true });
  await A.setViewportSize({ width: 1500, height: 950 });

  // Project deletion removes analytics
  await go(A, 'project', '[data-action=delete-project]');
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'Stats Game');
  await A.waitForSelector('text=Create a project');
  ok(((await fsGet(`projects/${pid}/analytics`)).documents || []).length === 0, 'project deletion removes analytics');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(2); });
