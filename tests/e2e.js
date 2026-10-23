const { chromium } = require(process.env.PW);
const fs = require('fs');
const SDK = process.env.SDK; // local node_modules/firebase
const BASE = 'http://127.0.0.1:5173/index.html?emulator';
const OOB = 'http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes';
const errors = [];
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else console.log('PASS:', m); };
const run = Date.now();
const email = (n) => `${n}.${run}@test.com`;

async function newUser(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
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
    if (page.expectAuthFail && /auth\/user-not-found/.test(t)) { page.expectAuthFail = false; return; }
    if (page.expectDenied && /permission|Missing or insufficient/i.test(t)) return;
    errors.push(`[${label}] console: ${t}`);
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
const rows = (page) => page.locator('.card').first().locator('tbody tr .task-title').allTextContents();
async function newTask(page, title, type = 'task') {
  await page.click('[data-action=new-task] >> nth=0');
  await page.fill('#task-title', title);
  await page.selectOption('#task-type', type);
  await page.click('#task-form button[type=submit]');
  await page.waitForSelector(`text=${title}`);
}
async function menu(page, title, item) {
  await page.locator('tbody tr', { hasText: title }).locator('[data-menu]').click();
  await page.waitForSelector('#task-menu:not([hidden])');
  if (item) await page.click(`#task-menu [data-mi=${item}]`);
}

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  ok(await A.isVisible('#auth-screen'), 'auth screen shown when signed out');

  // wrong password message
  A.expectAuthFail = true;
  await A.fill('#auth-email', 'nobody@test.com'); await A.fill('#auth-password', 'wrongpass'); await A.click('#auth-submit');
  await A.waitForSelector('#auth-error:not([hidden])');
  ok((await A.textContent('#auth-error')).length > 5, 'sign-in error shown: ' + await A.textContent('#auth-error'));

  // instrument renders
  await signUp(A, 'Alice', email('alice'));
  ok(true, 'sign up -> verify screen');
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project'); ok(true, 'verified -> welcome screen');

  await A.click('.welcome [data-action=new-project]');
  await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('#set-name');
  ok(await A.inputValue('#set-name') === 'Baddie Dice', 'project created, settings open');
  await A.fill('#set-desc', 'Roll dice, collect rare characters.');
  await A.fill('#set-platforms', 'Roblox, Mobile');
  await A.fill('#set-tags', 'RNG, Collection, RNG');
  await A.click('[data-form=project] button');
  await A.waitForSelector('text=Roll dice, collect rare characters.');
  ok((await A.textContent('.meta')) === 'Baddie Dice · Roblox · Mobile · RNG · Collection' && await A.locator('.meta .proj').count() === 1, 'meta line: ' + await A.textContent('.meta'));

  await A.goto(BASE + '#overview'); await A.waitForSelector('h1:text("Project overview")');
  for (const t of ['T1 dice', 'T2 inventory', 'T3 quests']) await newTask(A, t);
  ok(JSON.stringify(await rows(A)) === '["T1 dice","T2 inventory","T3 quests"]', 'tasks in creation order');

  await menu(A, 'T1 dice');
  ok(await A.isDisabled('#task-menu [data-mi=up]') && !(await A.isDisabled('#task-menu [data-mi=down]')), 'Up disabled on first row');
  ok(JSON.stringify(await A.locator('#task-menu button').allTextContents()) === '["Edit","Up","Down","Delete"]', 'menu has Edit/Up/Down/Delete');
  await A.keyboard.press('Escape');
  ok(await A.isHidden('#task-menu'), 'Escape closes menu');

  await menu(A, 'T3 quests', 'up');
  await A.waitForFunction(() => [...document.querySelectorAll('.card tbody tr .task-title')].map((e) => e.textContent).join() === 'T1 dice,T3 quests,T2 inventory');
  ok(true, 'Up moves task');
  await menu(A, 'T1 dice', 'down');
  await A.waitForFunction(() => [...document.querySelectorAll('.card tbody tr .task-title')].map((e) => e.textContent).join() === 'T3 quests,T1 dice,T2 inventory');
  ok(true, 'Down moves task');
  await A.reload(); await A.waitForSelector('text=T3 quests');
  ok(JSON.stringify(await rows(A)) === '["T3 quests","T1 dice","T2 inventory"]', 'order persists after reload');

  await menu(A, 'T1 dice', 'edit');
  await A.fill('#task-title', 'T1 dice system'); await A.selectOption('#task-priority', 'critical');
  await A.click('#task-form button[type=submit]');
  await A.waitForSelector('text=T1 dice system');
  ok(await A.locator('tbody tr', { hasText: 'T1 dice system' }).locator('.p-critical').count() === 1, 'Edit from menu');

  await menu(A, 'T2 inventory', 'delete'); await A.click('#ask-cancel');
  ok(await A.locator('tbody tr', { hasText: 'T2 inventory' }).count() === 1, 'Delete cancel keeps task');
  await menu(A, 'T2 inventory', 'delete'); await confirmAsk(A);
  await A.waitForSelector('tbody tr:has-text("T2 inventory")', { state: 'detached' });
  ok(true, 'Delete removes task');

  await A.goto(BASE + '#bugs'); await A.waitForSelector('h1:text("Bugs")');
  await newTask(A, 'Auto-roll stops', 'bug');
  ok(await A.textContent('#bugs-count') === '1', 'bug counted');

  await A.goto(BASE + '#activity'); await A.waitForSelector('.feed li');
  ok(await A.locator('#chat-text').count() === 0, 'activity page has no chat');
  ok((await A.textContent('.feed')).includes('reported a new bug'), 'activity logged');
  await A.goto(BASE + '#chat'); await A.waitForSelector('#chat-text');
  ok(await A.locator('.feed').count() === 0, 'chat page has no activity feed');
  await A.fill('#chat-text', 'Hello team <b>x</b>'); await A.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg-text:text("Hello team <b>x</b>")');
  ok(true, 'chat message sent and escaped');

  await A.goto(BASE + '#team'); await A.waitForSelector('#invite-email');
  await A.fill('#invite-email', 'not-an-email'); await A.click('[data-form=invite] button');
  await A.fill('#invite-email', email('bob').toUpperCase()); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  ok(true, 'invite added (lowercased)');

  // Bob
  const B = await newUser(browser, 'Bob');
  await signUp(B, 'Bob', email('bob'));
  await verify(B, email('bob'));
  await B.waitForSelector('.invite');
  ok((await B.textContent('.invite')).includes('Alice invited you to Baddie Dice'), 'Bob sees invitation');
  await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');
  ok(await B.textContent('#team-count') === '2', 'Bob joined, team of 2');
  ok(await B.locator('.invite').count() === 0, 'invite banner gone');
  await A.waitForSelector('.people li:nth-child(2)');
  ok((await A.textContent('.people')).includes('Bob'), 'Alice sees Bob live');
  ok(!(await A.textContent('#view')).includes('Pending invitations'), 'pending invite cleared');

  await A.goto(BASE + '#chat'); await A.waitForSelector('#chat-text');
  await B.goto(BASE + '#chat'); await B.waitForSelector('text=Hello team');
  ok(true, 'Bob reads Alice message');
  await B.fill('#chat-text', 'Hi Alice!'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('text=Hi Alice!');
  ok(true, 'Alice gets Bob reply in real time');

  // Security rules
  const pid = await A.evaluate(() => currentId);
  B.expectDenied = true;
  const bRemove = await B.evaluate(async (ownerUid) => {
    try { await projectsCol().doc(currentId).update({ memberIds: firebase.firestore.FieldValue.arrayRemove(ownerUid) }); return 'allowed'; }
    catch (e) { return e.code; }
  }, await A.evaluate(() => user.uid));
  ok(bRemove === 'permission-denied', 'member cannot remove the owner (' + bRemove + ')');
  const bOwner = await B.evaluate(async () => {
    try { await projectsCol().doc(currentId).update({ ownerId: user.uid }); return 'allowed'; } catch (e) { return e.code; }
  });
  ok(bOwner === 'permission-denied', 'member cannot take ownership (' + bOwner + ')');
  const bDelete = await B.evaluate(async () => { try { await projectsCol().doc(currentId).delete(); return 'allowed'; } catch (e) { return e.code; } });
  ok(bDelete === 'permission-denied', 'member cannot delete project (' + bDelete + ')');

  const C = await newUser(browser, 'Intruder');
  C.expectDenied = true;
  await signUp(C, 'Eve', email('eve'));
  const unverified = await C.evaluate(async (id) => { try { await db.collection('projects').doc(id).get(); return 'allowed'; } catch (e) { return e.code; } }, pid);
  ok(unverified === 'permission-denied', 'unverified account cannot read (' + unverified + ')');
  await verify(C, email('eve'));
  const r = await C.evaluate(async (id) => {
    const out = {};
    try { await db.collection('projects').doc(id).get(); out.read = 'allowed'; } catch (e) { out.read = e.code; }
    try { await db.collection('projects').doc(id).collection('tasks').get(); out.tasks = 'allowed'; } catch (e) { out.tasks = e.code; }
    try { await db.collection('projects').doc(id).update({ memberIds: firebase.firestore.FieldValue.arrayUnion(user.uid) }); out.join = 'allowed'; } catch (e) { out.join = e.code; }
    return out;
  }, pid);
  ok(r.read === 'permission-denied' && r.tasks === 'permission-denied' && r.join === 'permission-denied', 'outsider blocked ' + JSON.stringify(r));

  // Owner removes Bob -> Bob loses access live
  await A.goto(BASE + '#team'); await A.waitForSelector('[data-remove-member]');
  await A.click('[data-remove-member]'); await confirmAsk(A);
  await B.waitForSelector('text=Create a project');
  ok(true, 'removed member loses access live');

  // Profile name change
  await A.click('[data-action=account]'); await confirmAsk(A, 'Alice M');
  await A.waitForSelector('#side-user >> text=Alice M');
  ok((await A.textContent('.people')).includes('Alice M'), 'display name updated in team');

  // Mobile layout
  await A.setViewportSize({ width: 390, height: 844 });
  for (const v of ['overview', 'chat', 'team', 'project']) {
    await A.goto(BASE + '#' + v); await A.waitForSelector('#view h1'); await A.waitForTimeout(300);
    const w = await A.evaluate(() => document.documentElement.scrollWidth);
    ok(w <= 390, `mobile ${v} no horizontal scroll (${w})`);
  }
  await A.goto(BASE + '#overview'); await A.waitForSelector('#view h1'); await A.waitForTimeout(300);
  await A.screenshot({ path: process.env.OUT + '/m-overview.png' });
  await A.setViewportSize({ width: 1500, height: 950 });
  await A.goto(BASE + '#overview'); await A.waitForSelector('text=T3 quests');
  await menu(A, 'T3 quests');
  await A.screenshot({ path: process.env.OUT + '/d-menu.png' });
  await A.keyboard.press('Escape');
  await A.goto(BASE + '#chat'); await A.waitForSelector('text=Hi Alice!');
  await A.screenshot({ path: process.env.OUT + '/d-chat.png' });
  await B.screenshot({ path: process.env.OUT + '/d-welcome.png' });

  // Delete project (owner)
  await A.goto(BASE + '#project'); await A.waitForSelector('[data-action=delete-project]');
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'wrong name');
  await A.waitForSelector('.toast.error');
  ok(await A.isVisible('#set-name'), 'wrong name keeps project');
  const delId = await A.evaluate(() => currentId);
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('text=Create a project');
  const left = await (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/projects/${delId}`, { headers: { Authorization: 'Bearer owner' } })).status;
  const subs = await (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/projects/${delId}:listCollectionIds`, { method: 'POST', headers: { Authorization: 'Bearer owner' } })).json();
  const counts = {};
  for (const c of subs.collectionIds || []) counts[c] = ((await (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/projects/${delId}/${c}`, { headers: { Authorization: 'Bearer owner' } })).json()).documents || []).length;
  ok(left === 404 && Object.values(counts).every((n) => n === 0), 'project and all its data deleted (doc ' + left + ', ' + JSON.stringify(counts) + ')');

  // Sign out
  await A.click('[data-action=sign-out]');
  await A.waitForSelector('#auth-screen:not([hidden])');
  ok(true, 'sign out');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 6).join('\n')); process.exit(2); });
