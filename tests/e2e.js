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
  await A.waitForSelector('.msg.outgoing', { state: 'detached' });
  await A.waitForFunction(() => document.querySelectorAll('.atts.multi button.att-img').length === 2);
  ok(await A.locator('.pend').count() === 0, 'multiple images sent in one message');
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
  await A.waitForSelector('.msg.outgoing', { state: 'detached' });
  await A.waitForFunction(() => document.querySelectorAll('button.att-img').length === 3);
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
  const r2 = await B.evaluate(async (uid) => {
    const out = {};
    const act = (await projectsCol().doc(currentId).collection('activity').limit(1).get()).docs[0];
    try { await act.ref.delete(); out.deleteLog = 'allowed'; } catch (e) { out.deleteLog = e.code; }
    try { await projectsCol().doc(currentId).update({ [`members.${uid}.name`]: 'Mallory' }); out.renameOther = 'allowed'; } catch (e) { out.renameOther = e.code; }
    try { await projectsCol().doc(currentId).update({ memberIds: firebase.firestore.FieldValue.arrayUnion('someone-else') }); out.addMember = 'allowed'; } catch (e) { out.addMember = e.code; }
    return out;
  }, aliceUid);
  ok(Object.values(r2).every((v) => v === 'permission-denied'), 'rules block erasing the log, renaming others, adding members: ' + JSON.stringify(r2));
  // Hostile data written straight to the database is never rendered as a link, script or CSS
  B.expectDenied = false;
  await B.evaluate(async () => {
    await projectsCol().doc(currentId).collection('messages').add({ uid: user.uid, name: 'Bob', text: 'see file', at: Date.now(), attachments: [
      { url: "javascript:window.__pwned=1", type: 'text/plain', name: 'evil.pdf', size: 1 },
      { url: "javascript:window.__pwned=2", type: 'image/png', name: 'evil.png', size: 1 }] });
  });
  await A.evaluate(() => projectsCol().doc(currentId).update({ thumbnail: "x');position:fixed;inset:0;background:url('https://evil.test/a.png" }));
  await go(A, 'chat', '#chat-text'); await A.waitForSelector('text=evil.pdf');
  ok(await A.evaluate(() => !document.querySelector('[href^="javascript"], [src^="javascript"], [data-lightbox^="javascript"]')), 'javascript: URLs are never rendered');
  await A.click('.att-file'); await A.waitForTimeout(300);
  ok(await A.evaluate(() => !window.__pwned), 'clicking a hostile attachment runs nothing');
  await go(A, 'overview');
  ok(await A.locator('.banner').count() === 0 || !(await A.getAttribute('.banner', 'style')).includes('position'), 'hostile thumbnail value is not injected into CSS');
  await A.evaluate(async () => projectsCol().doc(currentId).update({ thumbnail: '' }));

  // ---------- v1.5 ----------
  // Smooth updates: a live change patches the page, existing images stay the same elements
  await go(A, 'chat', '#chat-text');
  await A.waitForSelector('button.att-img img');
  const imgHandle = await A.$('button.att-img img');
  await go(B, 'chat', '#chat-text');
  await B.fill('#chat-text', 'patch check'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('text=patch check');
  ok(await imgHandle.evaluate((el) => el.isConnected), 'a live update keeps existing images in place (no re-render flicker)');

  // Download button on chat images
  await A.locator('.att-wrap').first().hover();
  const [dl] = await Promise.all([A.waitForEvent('download'), A.locator('.att-wrap').first().locator('.att-dl').click()]);
  ok(/\.(png|jpe?g|webp|gif)$/.test(dl.suggestedFilename()), 'image download button (' + dl.suggestedFilename() + ')');

  // Channels and unread dots
  await A.click('[data-action=new-channel]'); await confirmAsk(A, 'Art Team', 'Concept art and icons');
  await A.waitForSelector('.chan-head:has-text("art-team")');
  ok((await A.textContent('.chan-topic')) === 'Concept art and icons', 'channel created with topic');
  await go(B, 'chat.general', '#chat-text');
  await A.fill('#chat-text', 'First art drop'); await A.press('#chat-text', 'Enter');
  await B.waitForSelector('.chan-list a.unread[href="#chat.art-team"]');
  ok(await B.locator('#side-nav a[data-view="chat"].has-dot').count() === 1, 'unread dot on the channel and on Chat');
  await B.click('.chan-list a[href="#chat.art-team"]');
  await B.waitForSelector('.msg-text:has-text("First art drop")');
  ok(await B.locator('.chan-list a.unread').count() === 0, 'opening the channel clears the dot');
  ok(!(await B.textContent('#chat-log')).includes('patch check'), 'channels keep their own messages');

  // Mentions and notifications
  await B.fill('#chat-text', 'great job @Ali');
  await B.waitForSelector('#mention-picker:not([hidden])');
  await B.press('#chat-text', 'Enter'); // picks the highlighted person
  ok((await B.inputValue('#chat-text')).startsWith('great job @Alice M '), 'mention picker completes the name');
  await B.type('#chat-text', 'love it'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg.mentioned .mention.me');
  ok(true, 'mention shown and highlighted for the person mentioned');
  await A.waitForSelector('#bell.has-dot');
  await A.click('#bell');
  await A.waitForSelector('.np-item.unread');
  ok((await A.textContent('.np-item.unread')).includes('mentioned you'), 'notification for the mention');
  await go(A, 'overview');
  await A.click('#bell'); await A.click('.np-item.unread');
  await A.waitForSelector('.chan-head:has-text("art-team")');
  ok(!(await A.isVisible('#bell.has-dot')), 'opening the notification goes to the message and marks it read');

  // Assigning a task notifies the assignee
  await go(A, 'tasks');
  await menu(A, 'T3 quests', 'Edit');
  await A.click('#cs-task-owner'); await pick(A, 'Bob');
  await A.click('#task-form button[type=submit]');
  await B.waitForSelector('#bell.has-dot');
  await B.click('#bell');
  ok((await B.textContent('.notif-panel')).includes('assigned you T3 quests'), 'assignment notification');
  await B.click('#bell');

  // Kanban: drag a card to another column
  await A.click('[data-board-mode=board]');
  await A.waitForSelector('.board .kcard:has-text("T3 quests")');
  const card = A.locator('.kcard', { hasText: 'T3 quests' });
  const cb = await card.boundingBox();
  const tb = await A.locator('.kcol[data-kcol=progress] .kcol-body').boundingBox();
  await A.mouse.move(cb.x + 40, cb.y + 30); await A.mouse.down();
  await A.mouse.move(cb.x + 60, cb.y + 50, { steps: 4 });
  await A.mouse.move(tb.x + tb.width / 2, tb.y + 30, { steps: 12 });
  await A.mouse.up();
  await A.waitForSelector('.kcol[data-kcol=progress] .kcard:has-text("T3 quests")');
  await A.waitForFunction(() => tasks.find((t) => t.title === 'T3 quests')?.status === 'progress');
  ok(true, 'drag a card from To do to In progress');
  await A.reload(); await A.waitForSelector('.board');
  ok(await A.locator('.kcol[data-kcol=progress] .kcard:has-text("T3 quests")').count() === 1, 'board column and mode saved after reload');
  await A.screenshot({ path: process.env.OUT + '/f-board.png' });
  await A.click('[data-board-mode=list]');

  // Roles: Viewer can read and chat, not change; rules agree
  await go(A, 'team', '.people');
  const bobUid = await B.evaluate(() => user.uid);
  await A.click(`#cs-role-${bobUid}`); await pick(A, 'Viewer');
  await B.waitForSelector('#invites:has-text("Viewer")');
  ok(true, 'Bob sees he is a Viewer');
  await go(B, 'tasks');
  ok(await B.locator('[data-action=new-task]').count() === 0, 'Viewer has no New task button');
  B.expectDenied = true;
  const vr = await B.evaluate(async () => {
    const out = {};
    try { await projectsCol().doc(currentId).collection('tasks').add({ title: 'x', type: 'task', status: 'todo', priority: 'low', order: 99 }); out.task = 'allowed'; } catch (e) { out.task = e.code; }
    try { await projectsCol().doc(currentId).update({ name: 'Hacked' }); out.settings = 'allowed'; } catch (e) { out.settings = e.code; }
    try { await projectsCol().doc(currentId).collection('messages').add({ uid: user.uid, name: 'Bob', text: 'viewer can chat', at: Date.now() }); out.chat = 'allowed'; } catch (e) { out.chat = e.code; }
    return out;
  });
  ok(vr.task === 'permission-denied' && vr.settings === 'permission-denied' && vr.chat === 'allowed', 'rules: Viewer can chat but not create tasks or change settings ' + JSON.stringify(vr));
  const mr = await B.evaluate(async () => { try { await projectsCol().doc(currentId).update({ roles: { [user.uid]: 'admin' } }); return 'allowed'; } catch (e) { return e.code; } });
  ok(mr === 'permission-denied', 'rules: a non-admin cannot promote themselves');
  B.expectDenied = false;
  await A.click(`#cs-role-${bobUid}`); await pick(A, 'Member');
  await B.waitForFunction(() => roleOf(user.uid) === 'member');

  // Patch notes
  await go(A, 'updates', '.updates-page');
  await A.click('[data-action=new-update]');
  await A.waitForSelector('#upd-title');
  await A.fill('#upd-title', 'UPDATE 1: Dice'); await A.fill('#upd-version', 'v1.0'); await A.fill('#upd-summary', 'The first big update.');
  await A.click('[data-action=fill-update]');
  ok((await A.inputValue('#upd-new')).split('\n').includes('T1 dice'), 'fill from completed work');
  await A.fill('#upd-balance', 'Rare odds **2x** higher');
  await A.click('button[name=intent][value=publish]');
  await A.waitForSelector('.patch');
  ok((await A.textContent('.patch-sections')).includes('T1 dice') && await A.locator('.patch-sec strong').count() === 1, 'published patch notes with sections and formatting');
  await B.waitForSelector('#bell.has-dot');
  await B.click('#bell');
  ok((await B.textContent('.notif-panel')).includes('published UPDATE 1: Dice'), 'team notified of the update');
  await B.click('.np-item.unread');
  await B.waitForSelector('.patch');
  ok((await B.textContent('#view h1')) === 'UPDATE 1: Dice', 'the notification opens the patch notes');
  ok(await B.locator('[data-action=edit-update]').count() === 0, 'members read patch notes, only admins edit');

  // Asset folders
  await go(A, 'assets', '.assets-page');
  await A.click('[data-action=new-folder]'); await confirmAsk(A, 'Characters art');
  await A.waitForSelector('.folder-tile:has-text("Characters art")');
  await A.click('.folder-tile:has-text("Characters art")');
  await A.waitForSelector('.asset-crumbs:has-text("Characters art")');
  await choose(A, '.dropzone[data-pick=asset]', [file('c1.png', await png(A, '#be185d', 400, 400, 'C1')), file('c2.png', await png(A, '#0891b2', 400, 400, 'C2'))]);
  await A.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2);
  ok(true, 'parallel upload into a folder');
  await A.click('.asset-crumbs a');
  await A.waitForSelector('.folder-tile:has-text("2 files")');
  await A.locator('.asset-card', { hasText: 'hero.png' }).hover();
  await A.locator('.asset-card', { hasText: 'hero.png' }).locator('[data-asset-menu]').click();
  await pick(A, 'Move to…'); await pick(A, 'Characters art');
  await A.waitForSelector('.folder-tile:has-text("3 files")');
  ok(true, 'move an asset into a folder from its menu');
  await A.locator('.asset-card', { hasText: 'dance.gif' }).dragTo(A.locator('.folder-tile:has-text("Characters art")'));
  await A.waitForSelector('.folder-tile:has-text("4 files")');
  ok(true, 'drag an asset onto a folder');
  await A.screenshot({ path: process.env.OUT + '/f-folders.png' });
  await A.locator('.folder-tile').hover(); await A.click('[data-folder-menu]'); await pick(A, 'Delete folder'); await confirmAsk(A);
  await A.waitForSelector('.folder-tile', { state: 'detached' });
  ok(await A.locator('.asset-card').count() === 4, 'deleting a folder keeps its files');

  // What's new
  await A.click('#whats-new-btn');
  await A.waitForSelector('#whats-new-dialog[open]');
  ok((await A.textContent('#whats-new-list')).includes('v1.5'), "What's new lists this update");
  await A.click('#whats-new-dialog button.primary');

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
  for (const v of ['overview', 'chat', 'assets', 'updates', 'tasks', 'activity', 'project', 'profile']) {
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
