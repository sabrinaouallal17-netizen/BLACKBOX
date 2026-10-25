// End-to-end test of global search (command palette) against the Firebase emulators.
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e-search.js
const { chromium } = require(process.env.PW);
const fs = require('fs');
const SDK = process.env.SDK;
const OUT = process.env.OUT || '.';
const BASE = 'http://127.0.0.1:5173/index.html?emulator';
const OOB = 'http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes';
const errors = [];
let passes = 0;
const ok = (c, m) => { if (!c) { errors.push('FAIL: ' + m); console.log('FAIL:', m); } else { passes++; console.log('PASS:', m); } };
const run = Date.now();
const email = (n) => `${n}.${run}@test.com`;

async function newUser(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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
    errors.push(`[${label}] console: ${t.slice(0, 400)}`);
  });
  page.on('dialog', (d) => { errors.push(`[${label}] native dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(BASE);
  return page;
}
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
const go = async (page, view) => { await page.goto(BASE + '#' + view); await page.waitForSelector(`#view.view-${view.split('.')[0]}`); };
async function newTask(page, title, type = 'task') {
  await page.click('[data-action=new-task] >> nth=0');
  await page.fill('#task-title', title);
  await page.selectOption('#task-type', type);
  await page.click('#task-form button[type=submit]');
  await page.waitForFunction((t) => tasks.some((x) => x.title === t), title);
}
async function send(page, text) {
  await page.fill('#chat-text', text);
  await page.press('#chat-text', 'Enter');
  await page.waitForFunction((t) => messages.some((m) => m.text === t), text);
}
const isOpen = (page) => page.evaluate(() => !!document.querySelector('#search-dialog[open]'));
const type = async (page, q) => { await page.fill('#sp-input', q); };
const groups = (page) => page.$$eval('#sp-list .sp-group-head > span:first-child', (els) => els.map((e) => e.textContent));
const selectedText = (page) => page.$eval('#sp-list .sp-row.on', (e) => e.textContent.replace(/\s+/g, ' ').trim());

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Search Game');
  await A.waitForFunction(() => !!project()); await A.waitForSelector('#set-name');
  ok(await A.textContent('#search-kbd') === 'Ctrl K', 'sidebar shows the Ctrl K shortcut hint');
  ok(await A.evaluate(() => getComputedStyle(document.querySelector('#search-btn')).borderTopStyle === 'solid'), 'sidebar search button is styled');

  // Data: tasks, bugs, messages in two channels.
  await go(A, 'tasks');
  for (const t of ['Dragon boss fight', 'Inventory UI polish', 'Café menu']) await newTask(A, t);
  for (let i = 1; i <= 7; i++) await newTask(A, `Quest line ${i}`);
  await go(A, 'bugs');
  await newTask(A, 'Crash on dragon spawn', 'bug');
  await go(A, 'chat');
  await send(A, "Let's discuss the dragon balance tonight");
  await send(A, 'Unrelated hello');
  await A.click('[data-action=new-channel]'); await confirmAsk(A, 'lore', 'World building');
  await A.waitForFunction(() => channelsOf().some((c) => c.id === 'lore'));
  await go(A, 'chat.lore');
  await A.waitForFunction(() => channelId === 'lore');
  await send(A, 'The ancient dragon lore document');
  await go(A, 'tasks');

  // Ctrl+K opens, search groups and highlight.
  await A.keyboard.press('Control+k');
  await A.waitForSelector('#search-dialog[open]');
  ok(await A.evaluate(() => document.activeElement.id === 'sp-input'), 'Ctrl+K opens the palette with focus in the input');
  ok(await A.locator('#sp-list').textContent().then((t) => /Quick actions/.test(t)), 'empty query shows quick actions');
  await type(A, 'dragon');
  await A.waitForFunction(() => !sp.msgLoading);
  await A.waitForFunction(() => document.querySelectorAll('#sp-list .sp-chan').length >= 2);
  const g = await groups(A);
  ok(['Tasks', 'Bugs', 'Messages'].every((x) => g.includes(x)), `results grouped by type (${g.join(', ')})`);
  const chans = await A.$$eval('#sp-list .sp-chan', (els) => els.map((e) => e.textContent));
  ok(chans.includes('#lore') && chans.includes('#general'), 'messages from every channel are searched (fetched once on open)');
  ok(await A.$eval('#sp-list .sp-group', (e) => e.querySelector('.sp-count').textContent) !== '', 'group headers show counts');
  const marks = await A.$$eval('#sp-list mark', (els) => els.map((e) => e.textContent.toLowerCase()));
  ok(marks.length >= 3 && marks.every((m) => m === 'dragon'), 'matched text is highlighted with <mark>');
  ok(await A.locator('#sp-list .sp-row', { hasText: 'Crash on dragon spawn' }).count() === 1, 'bugs are found');

  // Filter chips + Tab cycling + typed prefix.
  await A.click('.sp-filters [data-sp-filter=bugs]');
  ok(JSON.stringify(await groups(A)) === '["Bugs"]', 'Bugs chip shows only bugs');
  ok(await A.evaluate(() => document.activeElement.id === 'sp-input'), 'focus returns to the input after a chip click');
  await A.keyboard.press('Tab');
  ok(await A.$eval('.sp-filters .chip.on', (e) => e.dataset.spFilter) === 'feedback', 'Tab cycles to the next filter');
  ok(await A.evaluate(() => document.activeElement.id === 'sp-input'), 'focus stays trapped in the palette');
  await A.keyboard.press('Shift+Tab');
  await A.keyboard.press('Shift+Tab');
  ok(await A.$eval('.sp-filters .chip.on', (e) => e.dataset.spFilter) === 'tasks', 'Shift+Tab cycles backwards');
  await A.click('.sp-filters [data-sp-filter=all]');
  await type(A, 'bug: crash');
  ok(JSON.stringify(await groups(A)) === '["Bugs"]' && await A.$eval('.sp-filters .chip.on', (e) => e.dataset.spFilter) === 'bugs', 'typed prefix "bug:" filters to bugs');

  // Accent- and case-insensitive.
  await type(A, 'CAFE');
  ok(await A.$eval('#sp-list mark', (e) => e.textContent) === 'Café', 'accent/case-insensitive match highlights the original text');

  // Show all.
  await type(A, 'quest');
  ok(await A.locator('#sp-list .sp-row:not(.sp-more)').count() === 6 && await A.locator('#sp-list .sp-more').textContent().then((t) => /Show all 7 tasks/.test(t)), 'groups are capped at 6 with "Show all 7"');
  await A.click('#sp-list .sp-more');
  ok(await A.locator('#sp-list .sp-row:not(.sp-more)').count() === 7, '"Show all" expands the group');

  // Arrow navigation wraps; hover selects.
  await type(A, 'dragon');
  const total = await A.locator('#sp-list .sp-row').count();
  await A.keyboard.press('ArrowUp');
  ok(await A.$eval('#sp-list .sp-row.on', (e) => +e.dataset.spI) === total - 1, 'ArrowUp from the first row wraps to the last');
  await A.keyboard.press('ArrowDown');
  ok(await A.$eval('#sp-list .sp-row.on', (e) => +e.dataset.spI) === 0, 'ArrowDown wraps back to the first');
  await A.hover('#sp-list .sp-row >> nth=1');
  ok(await A.$eval('#sp-list .sp-row.on', (e) => +e.dataset.spI) === 1, 'mouse hover selects a row');
  await A.waitForTimeout(250);
  await A.screenshot({ path: `${OUT}/search-results.png` });

  // Enter opens the task dialog.
  await type(A, 'dragon boss');
  ok(/Dragon boss fight/.test(await selectedText(A)), 'best match (prefix) is selected first');
  await A.keyboard.press('Enter');
  await A.waitForSelector('#task-dialog[open]');
  ok(!(await isOpen(A)) && await A.inputValue('#task-title') === 'Dragon boss fight', 'Enter opens the right task in the task dialog');
  await A.click('#cancel-task-btn');

  // Escape closes and returns focus.
  await A.focus('#search-btn');
  await A.keyboard.press('Control+k');
  await A.waitForSelector('#search-dialog[open]');
  await A.keyboard.press('Escape');
  ok(!(await isOpen(A)), 'Escape closes the palette');
  ok(await A.evaluate(() => document.activeElement.id === 'search-btn'), 'focus returns to where it was');

  // Sidebar button + recent searches / opened items.
  await A.click('#search-btn');
  await A.waitForSelector('#search-dialog[open]');
  const empty = await A.locator('#sp-list').textContent();
  ok(/Recent searches/.test(empty) && /dragon boss/.test(empty), 'recent searches shown when the query is empty');
  ok(/Recently opened/.test(empty) && await A.locator('#sp-list .sp-group', { hasText: 'Recently opened' }).locator('.sp-row', { hasText: 'Dragon boss fight' }).count() === 1, 'recently opened items shown');
  await A.locator('#sp-list .sp-group', { hasText: 'Recent searches' }).locator('.sp-row', { hasText: 'dragon boss' }).first().click();
  ok(await A.inputValue('#sp-input') === 'dragon boss', 'clicking a recent search fills the input');

  // Message jump.
  await type(A, 'msg: ancient');
  await A.keyboard.press('Enter');
  await A.waitForFunction(() => location.hash === '#chat.lore');
  await A.waitForSelector('#chat-log .search-flash[data-msg-id]');
  ok(/ancient dragon lore/.test(await A.textContent('#chat-log .search-flash')), 'opening a message jumps to its channel and highlights it');

  // No results + suggestion.
  await A.keyboard.press('Control+k');
  await type(A, 'zzqxw');
  ok(/No results for/.test(await A.textContent('#sp-list .sp-state')), 'no-results state');
  await A.click('.sp-filters [data-sp-filter=bugs]');
  await type(A, 'dragon');
  await A.click('.sp-filters [data-sp-filter=feedback]');
  ok(await A.locator('#sp-list .sp-state button[data-sp-filter=all]').count() === 1, 'empty filter suggests searching all types');
  await A.click('#sp-list .sp-state button[data-sp-filter=all]');
  ok(await A.$eval('.sp-filters .chip.on', (e) => e.dataset.spFilter) === 'all', 'suggestion switches back to All');

  // Navigation commands.
  await type(A, 'settings');
  ok(/Settings|Project settings/.test(await selectedText(A)), 'commands match ("settings")');
  await A.keyboard.press('Enter');
  await A.waitForFunction(() => location.hash === '#project');
  ok(true, 'command navigates to project settings');

  // Click outside closes.
  await A.keyboard.press('Control+k');
  await A.waitForSelector('#search-dialog[open]');
  await A.mouse.click(15, 15);
  ok(!(await isOpen(A)), 'click outside closes the palette');

  // Documents: an image asset opens in the lightbox on the Assets page.
  await A.evaluate(() => { assets = [{ id: 'a1', name: 'Logo final.png', kind: 'image', type: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', size: 70, at: Date.now(), uid: user.uid }]; });
  await A.keyboard.press('Control+k');
  console.log('DBG', await A.evaluate(() => JSON.stringify({ open: sp.open, dlg: [...document.querySelectorAll('dialog[open]')].map((d) => d.id), ae: document.activeElement?.id || document.activeElement?.tagName, app: !$('#app').hidden, disp: getComputedStyle(sp.el).display, r: JSON.stringify(sp.el.getBoundingClientRect()), vis: getComputedStyle(sp.el).visibility, op: getComputedStyle(sp.el).opacity, ir: JSON.stringify(sp.input.getBoundingClientRect()) })));
  await A.screenshot({ path: `${OUT}/dbg.png` });
  await type(A, 'doc: logo');
  ok(JSON.stringify(await groups(A)) === '["Documents"]', 'assets are searched as documents');
  await A.keyboard.press('Enter');
  await A.waitForSelector('#lightbox:not([hidden])');
  ok(await A.evaluate(() => location.hash) === '#assets', 'opening an image asset goes to Assets and opens the lightbox');
  await A.keyboard.press('Escape');

  // Message fetch failure: error notice in the palette + toast.
  await A.evaluate(() => { sp.msgCache = null; window.__get = firebase.firestore.Query.prototype.get; firebase.firestore.Query.prototype.get = () => Promise.reject(Object.assign(new Error('offline test'), { code: 'unavailable' })); });
  await A.keyboard.press('Control+k');
  await A.waitForSelector('#sp-list .sp-notice');
  ok(/Couldn't search all chat messages/.test(await A.textContent('#sp-list .sp-notice')) && await A.isVisible('#toast.error'), 'message fetch error shows a notice and an error toast');
  await A.evaluate(() => { firebase.firestore.Query.prototype.get = window.__get; });
  await A.click('#sp-list [data-sp-retry]');
  await A.waitForFunction(() => !sp.msgLoading && !document.querySelector('#sp-list .sp-notice'));
  ok(true, 'Retry reloads messages and clears the notice');
  await A.keyboard.press('Escape');

  // Mobile: top bar button opens a full-screen sheet.
  await A.setViewportSize({ width: 390, height: 800 });
  await A.click('.mobile-top [data-action=open-search]');
  await A.waitForSelector('#search-dialog[open]');
  const box = await A.locator('#search-dialog').boundingBox();
  ok(box && box.width >= 389 && box.height >= 790, 'mobile: full-screen sheet');
  await type(A, 'dragon');
  await A.waitForTimeout(350);
  await A.screenshot({ path: `${OUT}/search-mobile.png` });
  ok(await A.evaluate(() => document.documentElement.scrollWidth <= 390), 'mobile: no horizontal scroll');
  await A.click('.sp-cancel');
  ok(!(await isOpen(A)), 'mobile: Cancel closes');

  await browser.close();
  console.log(`\n${passes} passed, ${errors.length} problems`);
  if (errors.length) { console.log(errors.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); console.log(errors.join('\n')); process.exit(1); });
