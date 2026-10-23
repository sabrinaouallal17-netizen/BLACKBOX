// End-to-end test of the Firebase edition against the Firebase emulators.
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e.js
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
const go = async (page, view, sel = '#view h1') => { await page.goto(BASE + '#' + view); await page.waitForSelector(sel); };
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
const pick = (page, label) => page.locator('#popover button', { hasText: label }).first().click();
const fsGet = async (path) => (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' } })).json();

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  ok(await A.isVisible('#auth-screen'), 'auth screen shown when signed out');

  A.expectAuthFail = true;
  await A.fill('#auth-email', 'nobody@test.com'); await A.fill('#auth-password', 'wrongpass'); await A.click('#auth-submit');
  await A.waitForSelector('#auth-error:not([hidden])');
  ok((await A.textContent('#auth-error')).length > 5, 'sign-in error shown');

  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project');
  ok(true, 'sign up, confirm email, welcome screen');
  ok(await A.textContent('#save-status') === 'All changes saved', 'save indicator shows saved');

  // Project + settings
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('#set-name');
  await A.fill('#set-desc', 'Roll dice, collect rare characters.');
  await A.check('#plat-roblox', { force: true }); await A.check('#plat-mobile', { force: true });
  for (const t of ['RNG', 'Collection', 'RNG']) { await A.fill('#tag-entry', t); await A.press('#tag-entry', 'Enter'); }
  ok(await A.locator('#tag-box .tag-chip').count() === 2, 'tag chips added (duplicates ignored)');
  await A.click('[data-form=project] button.primary');
  await A.waitForSelector('text=Project saved');
  await choose(A, '[data-pick=icon]', file('icon.png', await png(A, '#7c3aed', 300, 300, 'BD')));
  await A.waitForSelector('.icon-pick img');
  await choose(A, '[data-pick=thumbnail]', file('thumb.png', await png(A, '#2563eb', 1280, 720, 'BADDIE DICE')));
  await A.waitForSelector('.thumb-pick img');
  const pid = await A.evaluate(() => currentId);
  const pdoc = await fsGet(`projects/${pid}`);
  ok(pdoc.fields.icon.stringValue.startsWith('data:image/') && pdoc.fields.thumbnail.stringValue.startsWith('data:image/'), 'icon and thumbnail saved in the database');
  await go(A, 'overview');
  ok(await A.locator('.head .game-icon').getAttribute('src') !== null && await A.locator('.banner').count() === 1, 'overview shows icon and thumbnail banner');
  ok(JSON.stringify(await A.locator('.meta .plat-chip').allTextContents()) === '["Roblox","Mobile"]', 'platform chips with icons');
  ok(JSON.stringify(await A.locator('.meta .tag-chip').allTextContents()) === '["RNG","Collection"]', 'tag chips in header');
  ok(await A.locator('#side-nav .count').count() === 0, 'no counters in the navigation');

  // Tasks + menu
  for (const t of ['T1 dice', 'T2 inventory', 'T3 quests']) await newTask(A, t);
  ok(JSON.stringify(await rows(A)) === '["T1 dice","T2 inventory","T3 quests"]', 'tasks in creation order');
  await menu(A, 'T1 dice');
  ok(JSON.stringify((await A.locator('#popover button').allTextContents()).map((s) => s.trim())) === '["Edit","Up","Down","Delete"]', 'menu has Edit/Up/Down/Delete');
  ok(await A.locator('#popover button', { hasText: 'Up' }).isDisabled(), 'Up disabled on first row');
  await A.keyboard.press('Escape');
  ok(await A.isHidden('#popover'), 'Escape closes menu');
  await menu(A, 'T3 quests', 'Up'); await orderIs(A, 'T1 dice,T3 quests,T2 inventory');
  await menu(A, 'T1 dice', 'Down'); await orderIs(A, 'T3 quests,T1 dice,T2 inventory');
  ok(true, 'Up and Down reorder');
  await A.reload(); await A.waitForSelector('text=T3 quests');
  ok(JSON.stringify(await rows(A)) === '["T3 quests","T1 dice","T2 inventory"]', 'order saved after reload');

  // Styled select inside the task dialog
  await menu(A, 'T1 dice', 'Edit');
  await A.click('#cs-task-status'); await pick(A, 'Done');
  await A.click('#cs-task-priority'); await pick(A, 'Critical');
  ok((await A.textContent('#cs-task-status')).trim() === 'Done', 'styled select works inside the dialog');
  await A.click('#task-form button[type=submit]');
  await A.waitForSelector('tbody tr:has-text("T1 dice")', { state: 'detached' });
  ok(true, 'completed task leaves priority list');
  await menu(A, 'T2 inventory', 'Delete'); await A.click('#ask-cancel');
  ok(await A.locator('tbody tr', { hasText: 'T2 inventory' }).count() === 1, 'Delete cancel keeps task');
  await menu(A, 'T2 inventory', 'Delete'); await confirmAsk(A);
  await A.waitForSelector('tbody tr:has-text("T2 inventory")', { state: 'detached' });
  ok(true, 'Delete removes task');
  await go(A, 'bugs'); await newTask(A, 'Auto-roll stops', 'bug');

  // Collections
  await go(A, 'overview');
  await A.click('[data-action=new-collection]'); await confirmAsk(A, 'Characters', 'Playable characters and skins.');
  await A.waitForSelector('.coll-toolbar');
  await choose(A, '[data-pick=items]', [file('Baddie One.png', await png(A, '#db2777', 400, 500, 'B1')), file('Baddie Two.png', await png(A, '#059669', 400, 500, 'B2'))]);
  await A.waitForFunction(() => document.querySelectorAll('.item-card img').length === 2);
  ok(JSON.stringify(await A.locator('.item-card .item-name').allTextContents()) === '["Baddie One","Baddie Two"]', 'dropping images creates items named after files');
  await A.click('[data-action=new-item]');
  await A.setInputFiles('#item-file', file('x.png', await png(A, '#f59e0b', 400, 500, 'B3')));
  await A.fill('#item-name', 'Baddie Three'); await A.fill('#item-desc', 'Legendary rarity');
  await A.click('#item-save');
  await A.waitForSelector('.item-card:has-text("Baddie Three") img');
  ok((await A.textContent('.item-card:has-text("Baddie Three") .item-desc')) === 'Legendary rarity', 'item with image and info inside the card');
  await A.screenshot({ path: process.env.OUT + '/f-coll-grid.png' });
  await A.click('[data-view-mode=list]');
  await A.waitForSelector('.item-table');
  ok(await A.locator('.item-table tbody tr').count() === 3, 'list view');
  await A.click('[data-view-mode=grid]');
  await A.locator('.item-card', { hasText: 'Baddie Two' }).hover();
  await A.locator('.item-card', { hasText: 'Baddie Two' }).locator('[data-item-menu]').click();
  await pick(A, 'Delete'); await confirmAsk(A);
  await A.waitForFunction(() => document.querySelectorAll('.item-card').length === 2);
  ok(true, 'item deleted from its menu');
  await go(A, 'overview', '.coll');
  ok((await A.textContent('.coll .n')) === '2 items' && await A.locator('.coll-cover img').count() === 1, 'collection card shows cover and count on one line');

  // Assets
  await go(A, 'assets', '.assets-page');
  await choose(A, '.dropzone[data-pick=asset]', [file('hero.png', await png(A, '#9333ea', 800, 600, 'HERO')), file('dance.gif', GIF, 'image/gif')]);
  await A.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2);
  ok(true, 'assets uploaded');
  await A.click('[data-asset-kind=gif]');
  ok(await A.locator('.asset-card').count() === 1 && (await A.textContent('.asset-card .asset-name')) === 'dance.gif', 'GIF detected and filtered');
  await A.click('[data-asset-kind=all]');
  await A.locator('.asset-card', { hasText: 'hero.png' }).hover();
  await A.locator('.asset-card', { hasText: 'hero.png' }).locator('[data-asset-menu]').click();
  await pick(A, 'Use as thumbnail');
  await A.waitForSelector('text=Thumbnail updated');
  ok(true, 'asset used as thumbnail');

  // Chat
  await go(A, 'chat', '#chat-text');
  await A.fill('#chat-text', '**Bold** and *italic* and ~~gone~~ with `code` <b>x</b>');
  await A.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg-text strong');
  ok(await A.locator('.msg-text em').count() === 1 && await A.locator('.msg-text s').count() === 1 && await A.locator('.msg-text code').count() === 1, 'markdown formatting');
  ok((await A.textContent('.msg-text')).includes('<b>x</b>'), 'raw HTML is shown as text');
  await choose(A, '[data-pick=chat]', [file('shot1.png', await png(A, '#0ea5e9', 640, 360, 'S1')), file('shot2.png', await png(A, '#22c55e', 640, 360, 'S2'))]);
  ok(await A.locator('.pend').count() === 2, 'attachments queued before sending');
  await A.fill('#chat-text', 'Two screenshots');
  await A.click('.send-btn');
  await A.waitForFunction(() => document.querySelectorAll('.atts.multi .att-img').length === 2);
  await A.waitForSelector('.pend', { state: 'detached' });
  ok(await A.isEnabled('.send-btn'), 'multiple images sent in one message');
  // Real drag and drop onto the chat
  const dropped = await png(A, '#e11d48', 300, 300, 'DROP');
  await A.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const target = document.querySelector('#chat-log');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, dropped.toString('base64'));
  await A.waitForSelector('.pend');
  await A.click('.send-btn');
  await A.waitForSelector('.pend', { state: 'detached' });
  await A.waitForFunction(() => document.querySelectorAll('.att-img').length === 3);
  ok(true, 'drag and drop a file into the chat');
  await A.click('[data-action=toggle-gifs]');
  await A.waitForSelector('.gif-pick');
  await A.click('.gif-pick');
  await A.waitForFunction(() => [...document.querySelectorAll('.att-img img')].some((i) => i.src.startsWith('data:image/gif')));
  ok(true, 'GIF sent from the GIF library');
  await A.locator('.msg', { hasText: 'Two screenshots' }).hover();
  await A.locator('.msg', { hasText: 'Two screenshots' }).locator('[data-edit-msg]').click();
  await A.fill('#msg-edit-text', 'Two **new** screenshots'); await A.press('#msg-edit-text', 'Enter');
  await A.waitForSelector('.msg-text:has-text("Two new screenshots") .edited');
  ok(true, 'message edited, marked (edited)');
  await A.screenshot({ path: process.env.OUT + '/f-chat.png' });

  // Profile
  await go(A, 'profile', '#prof-name');
  await choose(A, '[data-pick=avatar]', file('me.png', await png(A, '#f97316', 400, 400, 'A')));
  await A.waitForSelector('#side-user .avatar.photo img');
  await A.fill('#prof-name', 'Alice M'); await A.fill('#prof-title', 'Lead developer'); await A.fill('#prof-email', 'alice.contact@test.com');
  await A.click('[data-form=profile] button.primary');
  await A.waitForSelector('#side-user >> text=Alice M');
  ok((await A.textContent('#side-user')).includes('Lead developer'), 'profile name, role and photo saved');
  await A.fill('#pw-current', 'secret123'); await A.fill('#pw-new', 'newsecret456');
  await A.click('[data-form=change-password] button');
  await A.waitForSelector('text=Password changed');
  await A.fill('#new-email', email('alice-new')); await A.fill('#email-pass', 'newsecret456');
  await A.click('[data-form=change-email] button');
  await A.waitForSelector(`text=Confirmation sent to ${email('alice-new')}`);
  const change = (await (await fetch(OOB)).json()).oobCodes.find((c) => c.requestType === 'VERIFY_AND_CHANGE_EMAIL' && c.newEmail === email('alice-new'));
  ok(!!change, 'email change sends a confirmation to the new address');

  // Invite Bob
  await go(A, 'team', '#invite-email');
  await A.fill('#invite-email', email('bob').toUpperCase()); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  const B = await newUser(browser, 'Bob');
  await signUp(B, 'Bob', email('bob'));
  await verify(B, email('bob'));
  await B.waitForSelector('.invite');
  ok((await B.textContent('.invite')).includes('invited you to Baddie Dice'), 'Bob sees invitation');
  await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');
  ok(await B.textContent('#team-count') === '2', 'Bob joined');
  ok(await B.locator('.head .avatar.photo').count() === 1, "Bob sees Alice's photo");
  await go(B, 'team', '.people li:nth-child(2)');
  ok((await B.textContent('.people')).includes('Lead developer') && (await B.textContent('.people')).includes('alice.contact@test.com'), "Bob sees Alice's role and contact email");
  await go(B, 'chat', '#chat-text');
  await B.waitForSelector('text=Two new screenshots');
  await B.locator('.msg', { hasText: 'Two new screenshots' }).hover();
  ok(await B.locator('.msg', { hasText: 'Two new screenshots' }).locator('[data-edit-msg]').count() === 0, "Bob can't edit Alice's message");
  await go(A, 'chat', '#chat-text');
  await B.fill('#chat-text', 'Hi Alice!'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('text=Hi Alice!');
  ok(true, 'chat in real time between accounts');

  // Typed text survives a teammate's change
  await go(A, 'project', '#set-desc');
  await A.fill('#set-desc', 'Unsaved new description');
  await go(B, 'tasks'); await newTask(B, 'Bob task');
  await A.waitForFunction(() => document.title.includes('Baddie'));
  await A.waitForTimeout(800);
  ok(await A.inputValue('#set-desc') === 'Unsaved new description', "typed text survives a teammate's live update");

  // Security rules
  B.expectDenied = true;
  const aliceUid = await A.evaluate(() => user.uid);
  const r = await B.evaluate(async (uid) => {
    const out = {};
    try { await db.collection('profiles').doc(uid).set({ name: 'hacked' }); out.profile = 'allowed'; } catch (e) { out.profile = e.code; }
    try { await projectsCol().doc(currentId).update({ memberIds: firebase.firestore.FieldValue.arrayRemove(uid) }); out.removeOwner = 'allowed'; } catch (e) { out.removeOwner = e.code; }
    const m = (await projectsCol().doc(currentId).collection('messages').where('uid', '==', uid).limit(1).get()).docs[0];
    try { await m.ref.update({ text: 'hacked' }); out.editOthers = 'allowed'; } catch (e) { out.editOthers = e.code; }
    return out;
  }, aliceUid);
  ok(Object.values(r).every((v) => v === 'permission-denied'), 'rules block editing others: ' + JSON.stringify(r));

  // Activity
  await go(A, 'activity', '.act-list');
  const types = await A.evaluate(() => [...new Set(activity.map(activityType))]);
  ok(['project.create', 'project.settings', 'project.branding', 'task.create', 'task.move', 'task.complete', 'task.delete', 'bug.report', 'collection.create', 'item.add', 'item.delete', 'asset.upload', 'member.invite', 'member.join'].every((t) => types.includes(t)), 'every kind of change is logged: ' + types.join(', '));
  ok(await A.locator('.act-row .act-badge svg').count() === await A.locator('.act-row').count(), 'each entry has an icon');
  ok(await A.locator('.changes li:has-text("Status")').count() >= 1 && (await A.textContent('.changes')).length > 0, 'changes are shown (Status: To do → Done)');
  await A.click('[data-act-filter=collections]');
  ok(await A.evaluate(() => [...document.querySelectorAll('.act-row')].length > 0), 'filter by type');
  await A.click('[data-act-filter=all]');
  await A.click('#cs-act-who'); await pick(A, 'Bob');
  ok(await A.evaluate(() => [...document.querySelectorAll('.act-row .txt b:first-child')].every((b) => b.textContent === 'Bob')), 'filter by member with the styled select');
  await A.click('#cs-act-who'); await pick(A, 'Everyone');
  await A.screenshot({ path: process.env.OUT + '/f-activity.png' });

  // Mobile
  await A.setViewportSize({ width: 390, height: 844 });
  for (const v of ['overview', 'chat', 'assets', 'activity', 'project', 'profile']) {
    await go(A, v); await A.waitForTimeout(300);
    const w = await A.evaluate(() => document.documentElement.scrollWidth);
    ok(w <= 390, `mobile ${v} no horizontal scroll (${w})`);
  }
  await A.setViewportSize({ width: 1500, height: 950 });
  await go(A, 'overview'); await A.waitForTimeout(400);
  await A.screenshot({ path: process.env.OUT + '/f-overview.png' });
  await go(A, 'project'); await A.screenshot({ path: process.env.OUT + '/f-settings.png' });
  await go(A, 'assets', '.asset-card'); await A.screenshot({ path: process.env.OUT + '/f-assets.png' });

  // Owner removes Bob; delete project
  await go(A, 'team', '[data-remove-member]');
  await A.click('[data-remove-member]'); await confirmAsk(A);
  await B.waitForSelector('text=Create a project');
  ok(true, 'removed member loses access live');
  await go(A, 'project', '[data-action=delete-project]');
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('text=Create a project');
  const left = await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/projects/${pid}`, { headers: { Authorization: 'Bearer owner' } });
  const subs = await (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/projects/${pid}:listCollectionIds`, { method: 'POST', headers: { Authorization: 'Bearer owner' } })).json();
  const counts = {};
  for (const c of subs.collectionIds || []) counts[c] = ((await fsGet(`projects/${pid}/${c}`)).documents || []).length;
  ok(left.status === 404 && Object.values(counts).every((n) => n === 0), 'project and all its data deleted ' + JSON.stringify(counts));

  // Sign in again with the new password
  await A.click('[data-action=sign-out]');
  await A.waitForSelector('#auth-screen:not([hidden])');
  await A.fill('#auth-email', email('alice')); await A.fill('#auth-password', 'newsecret456'); await A.click('#auth-submit');
  await A.waitForSelector('#app:not([hidden])');
  ok(true, 'sign in with the new password');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(2); });
