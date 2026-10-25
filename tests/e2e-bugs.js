// End-to-end test of bug reports: form, detail page, statuses, comments, links, history, kanban labels.
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e-bugs.js
// Needs the app served at http://127.0.0.1:5173 and the Firebase emulators (auth 9099, firestore 8080).
const { chromium } = require(process.env.PW);
const fs = require('fs');
const SDK = process.env.SDK;
const OUT = process.env.OUT || '.';
const BASE = 'http://127.0.0.1:5173/index.html?emulator';
const OOB = 'http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes';
const errors = [];
let passed = 0;
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else { passed++; console.log('PASS:', m); } };
const run = Date.now();
const email = (n) => `${n}.bugs.${run}@test.com`;

async function newUser(browser, label, viewport = { width: 1500, height: 950 }) {
  const ctx = await browser.newContext({ viewport });
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
async function png(page, color, w = 640, h = 360, label = '') {
  const b64 = await page.evaluate(([c, w, h, label]) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = c; g.fillRect(0, 0, w, h);
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
const go = async (page, view, sel = '#view h1') => { await page.goto(BASE + '#' + view); await page.waitForSelector(`#view.view-${view.split('.')[0]}`); await page.waitForSelector(sel); };
const pick = (page, label) => page.locator('#popover button', { hasText: label }).first().click();
async function choose(page, selector, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await fc.setFiles(files);
}
const fsGet = async (path) => (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' } })).json();
const bug = (page, id) => page.evaluate((id) => { const t = tasks.find((x) => x.id === id); return t && JSON.parse(JSON.stringify(t)); }, id);

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Bug Hunt');
  await A.waitForSelector('#set-name');
  await A.click('label:has(#plat-roblox) span'); await A.click('label:has(#plat-mobile) span');
  await A.click('[data-form=project] button.primary');
  await A.waitForSelector('text=Project saved');
  const pid = await A.evaluate(() => currentId);

  // Bob joins
  await go(A, 'team', '#invite-email');
  await A.fill('#invite-email', email('bob')); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  const B = await newUser(browser, 'Bob');
  await signUp(B, 'Bob', email('bob'));
  await verify(B, email('bob'));
  await B.waitForSelector('.invite');
  await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');
  await A.waitForFunction(() => project().memberIds.length === 2);
  ok(true, 'project with two members');

  // A task to link to later
  await go(A, 'tasks');
  await A.click('[data-action=new-task] >> nth=0');
  ok(await A.locator('#task-dialog .bug-only').first().isHidden(), 'task dialog hides bug fields');
  ok((await A.textContent('#task-owner-label')) === 'Owner', 'task owner label');
  await A.fill('#task-title', 'Rework shop UI');
  await A.click('#task-form button[type=submit]');
  await A.waitForSelector('tbody tr:has-text("Rework shop UI")');
  ok(JSON.stringify(await A.locator('.filters').first().locator('.chip').allTextContents()) === '["All","To do","In progress","In review","Done"]', 'tasks keep task status labels');

  // Report a full bug
  await go(A, 'bugs');
  await A.click('[data-action=new-task] >> nth=0');
  await A.waitForSelector('#task-dialog[open]');
  ok((await A.textContent('#task-dialog-title')) === 'Report a bug', 'dialog title "Report a bug"');
  ok(await A.locator('#task-dialog .bug-only').first().isVisible() && await A.evaluate(() => taskDialog.classList.contains('bug-dialog')), 'bug fields shown in a wider dialog');
  ok((await A.textContent('#task-owner-label')) === 'Responsible for the fix', 'assignee labelled "Responsible for the fix"');
  ok(JSON.stringify(await A.evaluate(() => [...document.querySelectorAll('#task-status option')].map((o) => o.textContent))) === '["Open","In progress","To test","Resolved"]', 'bug status options');
  await A.fill('#task-title', 'Dice freeze after rolling');
  await A.fill('#task-desc', 'The dice stop **spinning** and the game freezes.');
  await A.fill('#bug-steps', '1. Open the shop\n2. Buy the starter pack\n- Roll the dice 3 times');
  await A.fill('#bug-expected', 'Dice roll normally');
  await A.fill('#bug-actual', 'Game freezes for 10 seconds');
  await A.click('#cs-bug-severity'); await pick(A, 'Blocker');
  await A.click('#cs-task-priority'); await pick(A, 'High');
  await A.click('#cs-bug-frequency'); await pick(A, 'Always');
  ok(JSON.stringify(await A.evaluate(() => [...document.querySelectorAll('#bug-platforms option')].map((o) => o.value))) === '["Roblox","Mobile"]', 'platform suggestions from the project');
  await A.fill('#bug-platform', 'Roblox');
  await A.fill('#bug-device', 'iPhone 13');
  await A.fill('#bug-version', '1.4.2');
  await A.click('#cs-bug-reporter'); await pick(A, 'Bob');
  await choose(A, '.bug-drop', [file('freeze.png', await png(A, '#dc2626', 640, 360, 'FREEZE')), file('log.txt', Buffer.from('error log line'), 'text/plain')]);
  await A.waitForFunction(() => document.querySelectorAll('#bug-atts .bug-att.pending').length === 2);
  ok((await A.textContent('#bug-atts')).includes('uploads when you save'), 'pending uploads listed');
  await A.locator('#bug-atts .bug-att', { hasText: 'log.txt' }).locator('[data-bug-att-remove]').click();
  ok(await A.locator('#bug-atts .bug-att').count() === 1, 'pending attachment removed');
  await A.screenshot({ path: OUT + '/bug-form.png' });
  await A.click('#task-form button[type=submit]');
  await A.waitForSelector('#task-dialog[open]', { state: 'detached' });
  await A.waitForSelector('tbody tr:has-text("Dice freeze after rolling")');
  const id = await A.evaluate(() => tasks.find((t) => t.title === 'Dice freeze after rolling').id);
  const bobUid = await B.evaluate(() => user.uid);
  const aliceUid = await A.evaluate(() => user.uid);
  let d = await bug(A, id);
  ok(d.type === 'bug' && d.severity === 'blocker' && d.priority === 'high' && d.frequency === 'always' && d.platform === 'Roblox' && d.device === 'iPhone 13' && d.gameVersion === '1.4.2'
    && d.reporter === bobUid && d.owner === aliceUid && d.steps.includes('Buy the starter pack') && d.expected && d.actual && Array.isArray(d.links), 'bug saved with every field');
  ok(d.attachments.length === 1 && d.attachments[0].url.startsWith('data:image/') && d.attachments[0].name === 'freeze.png', 'screenshot attachment stored');
  const row = A.locator('tbody tr', { hasText: 'Dice freeze after rolling' });
  ok((await row.locator('.sev').textContent()).includes('Blocker') && (await row.locator('.bug-env-hint').textContent()).includes('Roblox · iPhone 13 · v1.4.2'), 'bug row shows severity and environment');
  ok((await row.locator('.pill.s-todo').textContent()).trim() === 'Open', 'bug row status "Open"');
  ok(JSON.stringify(await A.locator('.filters').first().locator('.chip').allTextContents()) === '["All","Open","In progress","To test","Resolved"]', 'bug filter chips use bug labels');
  const logs = (await fsGet(`projects/${pid}/activity`)).documents.map((x) => x.fields);
  ok(logs.some((f) => f.type?.stringValue === 'bug.report' && f.ref?.stringValue === `task:${id}`), 'report logged with ref');

  // Detail page
  await row.locator('.task-title').click();
  await A.waitForSelector('.bug-page');
  ok(await A.evaluate(() => location.hash) === `#bugs.${id}`, 'clicking a bug row opens #bugs.<id>');
  ok((await A.textContent('#view h1')) === 'Dice freeze after rolling', 'detail header title');
  ok(JSON.stringify(await A.locator('.bug-steps li').allTextContents()) === '["Open the shop","Buy the starter pack","Roll the dice 3 times"]', 'steps shown as a numbered list');
  ok((await A.textContent('.ea.expected')).includes('Dice roll normally') && (await A.textContent('.ea.actual')).includes('Game freezes'), 'expected vs actual side by side');
  ok((await A.textContent('.bug-env')).includes('Roblox') && (await A.textContent('.bug-env')).includes('iPhone 13') && (await A.textContent('.bug-env')).includes('1.4.2'), 'environment block');
  ok((await A.textContent('.bug-people')).includes('Bob') && (await A.textContent('.bug-people')).includes('Alice'), 'reporter and assignee');
  ok(await A.locator('.bug-hero .sev-blocker').count() === 1 && await A.locator('.bug-hero .freq').count() === 1 && await A.locator('.bug-hero .p-high').count() === 1, 'severity / priority / frequency badges');
  ok(await A.locator('.bug-files-card .att-img img').count() === 1, 'attachment shown');
  ok((await A.locator('.bug-text strong').first().textContent()) === 'spinning', 'description formatted');
  ok((await A.textContent('.bug-stepper li.current')).includes('Open'), 'stepper at Open');

  // Status workflow
  for (const [k, label] of [['progress', 'In progress'], ['review', 'To test'], ['done', 'Resolved']]) {
    await A.click(`[data-bug-status=${k}]`);
    await A.waitForSelector(`.bug-stepper li.current.st-${k}`);
    ok((await A.textContent('.bug-badges .pill')).includes(label), `moved to ${label}`);
  }
  d = await bug(A, id);
  ok(d.status === 'done' && d.resolvedAt > 0, 'resolvedAt set when resolved');
  await A.waitForSelector('[data-action=bug-reopen]');
  await A.click('[data-action=bug-reopen]');
  await A.waitForSelector('.bug-stepper li.current.st-todo');
  d = await bug(A, id);
  ok(d.status === 'todo' && d.reopenedAt > 0, 'reopen sets status Open and reopenedAt');
  await A.waitForFunction(() => document.querySelector('.bug-history')?.textContent.includes('reopened'));
  ok((await A.textContent('.bug-history')).includes('Resolved') && (await A.textContent('.bug-history')).includes('To test'), 'history lists status changes');
  ok(await A.locator('[data-action=bug-reopen]').count() === 0, 'Reopen hidden once open');

  // Edit through the dialog: history shows field changes
  await A.click('[data-action=bug-edit]');
  await A.waitForSelector('#task-dialog[open]');
  ok((await A.textContent('#task-dialog-title')) === 'Edit bug' && await A.inputValue('#bug-device') === 'iPhone 13' && await A.locator('#bug-atts .bug-att').count() === 1, 'edit dialog filled with bug fields and attachment');
  await A.click('#cs-bug-severity'); await pick(A, 'Major');
  await A.fill('#bug-version', '1.4.3');
  await A.click('#task-form button[type=submit]');
  await A.waitForFunction(() => document.querySelector('.bug-history')?.textContent.includes('Severity'));
  const hist = await A.textContent('.bug-history');
  ok(hist.includes('Blocker') && hist.includes('Major') && hist.includes('1.4.3'), 'history shows severity and version changes');

  // Comments
  const ta = '.bug-comments .cm-composer textarea';
  await A.fill(ta, 'Repro on **Android** too, @Bob can you check?');
  await A.press(ta, 'Enter');
  await A.waitForSelector('.cm:has-text("Repro on")');
  ok((await A.locator('.cm .cm-text strong').first().textContent()) === 'Android' && await A.locator('.cm .mention').count() === 1, 'comment formatted with a mention');
  ok(await A.inputValue(ta) === '', 'composer cleared after sending');
  await A.fill(ta, 'line one');
  await A.press(ta, 'Shift+Enter');
  await A.type(ta, 'line two');
  ok((await A.inputValue(ta)) === 'line one\nline two', 'Shift+Enter adds a new line');
  await choose(A, '.bug-comments [data-pick=comment-files]', [file('proof.png', await png(A, '#2563eb', 320, 200, 'PROOF'))]);
  await A.waitForSelector('.cm-pending .bug-att');
  await A.press(ta, 'Enter');
  await A.waitForSelector('.cm:has-text("line two") .att-img img');
  ok(true, 'comment with an attachment');

  await go(B, `bugs.${id}`, '.bug-page');
  await B.waitForSelector('.cm:has-text("Repro on")');
  ok(await B.locator('.cm', { hasText: 'Repro on' }).locator('[data-cm-edit-start]').count() === 0, "Bob can't edit Alice's comment");
  await B.fill(ta, 'On it, looks like a server lag');
  await B.press(ta, 'Enter');
  await A.waitForSelector('.cm:has-text("On it")');
  ok(true, 'second member comments, live for the author');
  const notifs = (await fsGet(`projects/${pid}/notifications`)).documents || [];
  ok(notifs.some((n) => n.fields.type.stringValue === 'mention' && n.fields.to.stringValue === bobUid && n.fields.link.stringValue === `#bugs.${id}`), 'mention in a comment notifies Bob');

  const mine = A.locator('.cm', { hasText: 'Repro on' });
  await mine.hover();
  await mine.locator('[data-cm-edit-start]').click();
  await A.waitForSelector('#cm-edit-text');
  await A.fill('#cm-edit-text', 'Repro on Android and iOS');
  await A.press('#cm-edit-text', 'Enter');
  await A.waitForSelector('.cm:has-text("Repro on Android and iOS") .edited');
  ok(true, 'author edits a comment');
  const second = A.locator('.cm', { hasText: 'line two' });
  await second.hover();
  await second.locator('[data-cm-delete]').click();
  await confirmAsk(A);
  await A.waitForSelector('.cm:has-text("line two")', { state: 'detached' });
  ok(await A.locator('.cm').count() === 2, 'author deletes a comment');
  await B.waitForSelector('.cm:has-text("Repro on Android and iOS")');
  ok(await B.locator('.cm').count() === 2, 'edits and deletes are live for others');
  ok((await A.textContent('.bug-history')).includes('commented on'), 'comments appear in history');

  // Links
  await A.click('[data-action=bug-link-open]');
  await A.waitForSelector('.link-picker');
  await A.fill('#bug-link-q', 'shop');
  await A.waitForFunction(() => document.querySelectorAll('.lp-results button').length === 1);
  await A.click('.lp-results button');
  await A.waitForSelector('.blinks .blink:has-text("Rework shop UI")');
  ok((await bug(A, id)).links.some((l) => l.kind === 'task'), 'bug linked to a task');
  await A.click('.blink-open:has-text("Rework shop UI")');
  await A.waitForSelector('#task-dialog[open]');
  ok((await A.inputValue('#task-title')) === 'Rework shop UI', 'opening a linked task');
  await A.click('#cancel-task-btn');

  // createTaskFrom (used by feedback) + backlinks
  const fromId = await A.evaluate((id) => createTaskFrom({ type: 'bug', title: 'Crash on launch', desc: 'From a player', priority: 'critical', feedbackId: 'fb-demo', steps: 'Launch', actual: 'Crash', links: [{ kind: 'bug', id }] }), id);
  ok(typeof fromId === 'string', 'createTaskFrom returns the new id');
  await A.waitForSelector('.bug-links .side-label:has-text("Linked from")');
  ok((await A.textContent('.bug-links')).includes('Crash on launch'), 'backlink from the other bug');
  const created = await bug(A, fromId);
  ok(created.type === 'bug' && created.status === 'todo' && created.feedbackId === 'fb-demo' && created.links.some((l) => l.kind === 'feedback' && l.id === 'fb-demo') && created.createdBy === aliceUid && created.priority === 'critical', 'created bug has feedback link, status and creator');
  await go(A, `bugs.${fromId}`, '.bug-page');
  ok(await A.locator('.blinks .blink').count() === 2, 'feedback link and bug link listed (feedback shown even when missing)');
  await A.locator('.blink', { hasText: 'Dice freeze' }).locator('[data-unlink]').click();
  await A.waitForFunction(() => document.querySelectorAll('.blinks .blink').length === 1);
  ok(true, 'remove a link');

  // Kanban labels
  await go(A, 'bugs');
  await A.click('[data-board-mode=board]');
  await A.waitForSelector('.board');
  ok(JSON.stringify((await A.locator('.kcol-head .pill').allTextContents()).map((s) => s.trim())) === '["Open","In progress","To test","Resolved"]', 'bug board columns use bug labels');
  ok(await A.locator('.kcard .sev').count() >= 1, 'bug cards show severity');
  await A.screenshot({ path: OUT + '/bug-board.png' });
  await A.locator('.kcard', { hasText: 'Dice freeze' }).locator('.kcard-title').click();
  await A.waitForSelector('.bug-page');
  ok(true, 'clicking a bug card opens the detail page');
  await go(A, 'bugs');
  await A.click('[data-board-mode=list]');
  await go(A, 'tasks');
  await A.click('[data-board-mode=board]');
  await A.waitForSelector('.board');
  ok(JSON.stringify((await A.locator('.kcol-head .pill').allTextContents()).map((s) => s.trim())) === '["To do","In progress","In review","Done"]', 'task board keeps task labels');
  await A.click('[data-board-mode=list]');

  // Screens: desktop and phone
  await go(A, `bugs.${id}`, '.bug-page');
  await A.waitForTimeout(300);
  await A.screenshot({ path: OUT + '/bug-detail.png', fullPage: true });
  const M = await newUser(browser, 'Bob-mobile', { width: 390, height: 844 });
  await M.waitForSelector('#auth-screen:not([hidden])');
  await M.fill('#auth-email', email('bob')); await M.fill('#auth-password', 'secret123'); await M.click('#auth-submit');
  await M.waitForSelector('#app:not([hidden])');
  await go(M, `bugs.${id}`, '.bug-page');
  await M.waitForTimeout(300);
  ok(await M.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), 'detail page has no horizontal scroll on a phone');
  await M.screenshot({ path: OUT + '/bug-detail-mobile.png', fullPage: true });

  // Delete from the detail page
  await go(A, `bugs.${fromId}`, '.bug-page');
  await A.click('[data-action=bug-delete]');
  await confirmAsk(A);
  await A.waitForFunction(() => location.hash === '#bugs');
  await A.waitForSelector('tbody tr:has-text("Crash on launch")', { state: 'detached' });
  ok(true, 'delete a bug from its page');
  await go(A, 'bugs.nope', '.bug-missing');
  ok((await A.textContent('.bug-missing')).includes("doesn't exist"), 'unknown bug id shows a friendly page');

  await browser.close();
  console.log(`\n${passed} passed`);
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(2); });
