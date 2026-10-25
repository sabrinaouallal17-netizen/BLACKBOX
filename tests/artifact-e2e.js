// End-to-end test of the Artifact edition against tests/mock-claude.js.
// Usage: PW=<playwright> IDIOMORPH=<idiomorph.min.js> URL=<served built page> OUT=<screenshot dir> node tests/artifact-e2e.js
const { chromium } = require(process.env.PW);
const path = require('path');
const MOCK = path.join(__dirname, 'mock-claude.js');
const errors = [];
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else console.log('PASS:', m); };
const blobs = new Map();

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addInitScript({ path: MOCK });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/idiomorph@[\d.]+\/dist\/idiomorph\.min\.js/, (route) => route.fulfill({ body: require('fs').readFileSync(process.env.IDIOMORPH), contentType: 'application/javascript' }));
  await ctx.route('**/__mock_upload/*', async (route) => {
    const id = route.request().url().split('/').pop();
    blobs.set(id, { body: route.request().postDataBuffer(), type: route.request().headers()['content-type'] });
    await route.fulfill({ status: 200, body: 'ok' });
  });
  await ctx.route('**/_blob/*', (route) => {
    const b = blobs.get(route.request().url().split('/').pop());
    return b ? route.fulfill({ status: 200, body: b.body, contentType: b.type }) : route.fulfill({ status: 404, body: '' });
  });
  const open = async (u) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`[${u}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text()) && !(page.expectWriteError && /write not allowed/.test(m.text()))) errors.push(`[${u}] console: ${m.text()}`); });
    page.on('dialog', (d) => { errors.push(`[${u}] native dialog`); d.dismiss(); });
    await page.goto(`${process.env.URL}?u=${u}`);
    return page;
  };
  const png = async (page, color, w = 300, h = 360, label = '') => Buffer.from(await page.evaluate(([c, w, h, label]) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(h / 7)}px sans-serif`; g.fillText(label, w * 0.12, h * 0.55);
    return cv.toDataURL('image/png').split(',')[1];
  }, [color, w, h, label]), 'base64');
  const file = (name, buffer, mimeType = 'image/png') => ({ name, mimeType, buffer });
  const choose = async (page, selector, files) => {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
    await fc.setFiles(files);
  };
  const go = async (page, view, sel = '#view h1') => { await page.evaluate((h) => { location.hash = h; }, view); await page.waitForSelector(`#view.view-${view.split('.')[0]}`); await page.waitForSelector(sel); };
  const confirmAsk = async (p, ...vals) => { for (let i = 0; i < vals.length; i++) await p.fill(`#ask-f${i}`, vals[i]); await p.click('#ask-ok'); };
  const titles = (p) => p.locator('.card').first().locator('tbody tr .task-title').allTextContents();
  const newTask = async (p, title) => { await p.click('[data-action=new-task] >> nth=0'); await p.fill('#task-title', title); await p.click('#task-form button[type=submit]'); await p.waitForSelector(`text=${title}`); };
  const menu = async (p, title, item) => { await p.locator('tbody tr', { hasText: title }).locator('[data-task-menu]').click(); await p.locator('#popover button', { hasText: item }).click(); };
  const waitNotif = (page, type) => page.waitForFunction((t) => allNotifs().some((n) => n.type === t && !n.read), type);
  const pick = (p, label) => p.locator('#popover button', { hasText: label }).first().click();

  // Signed-out visitor
  const anon = await open('nobody');
  await anon.waitForSelector('#setup-screen:not([hidden])');
  ok((await anon.textContent('#setup-title')) === 'Sign in to use BLACKBOX', 'signed-out visitor sees sign-in message');

  // Owner
  const A = await open('alice');
  await A.waitForSelector('text=Create a project');
  ok(await A.locator('[data-action=sign-out]').count() === 0, 'no sign-out or password UI in the Artifact');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('#set-name');
  await A.fill('#set-desc', 'Roll dice, collect rare characters.');
  await A.click('label:has(#plat-roblox) span'); await A.click('label:has(#plat-pc) span');
  await A.fill('#tag-entry', 'RNG'); await A.press('#tag-entry', 'Enter');
  await A.click('[data-form=project] button.primary'); await A.waitForSelector('text=Project saved');
  await choose(A, '[data-pick=icon]', file('icon.png', await png(A, '#7c3aed', 256, 256, 'BD')));
  await A.waitForSelector('.icon-pick img');
  ok((await A.getAttribute('.icon-pick img', 'src')).startsWith('/_blob/'), 'icon stored in the artifact file storage');
  await go(A, 'overview');
  ok(JSON.stringify(await A.locator('.meta .plat-chip').allTextContents()) === '["Roblox","PC"]', 'platform chips');
  ok(await A.locator('#side-nav .count').count() === 0, 'no counters in the navigation');
  for (const t of ['T1', 'T2', 'T3']) await newTask(A, t);
  await menu(A, 'T3', 'Up');
  await A.waitForFunction(() => [...document.querySelectorAll('.card tbody tr .task-title')].map((e) => e.textContent).join() === 'T1,T3,T2');
  ok(true, 'menu Up reorders');
  await menu(A, 'T2', 'Delete'); await confirmAsk(A);
  await A.waitForSelector('tbody tr:has-text("T2")', { state: 'detached' });
  ok(JSON.stringify(await titles(A)) === '["T1","T3"]', 'menu Delete removes');

  // Collections with images
  await A.click('[data-action=new-collection]'); await confirmAsk(A, 'Characters');
  await A.waitForSelector('.coll-toolbar');
  await choose(A, '[data-pick=items]', [file('Baddie One.png', await png(A, '#db2777', 300, 360, 'B1')), file('Baddie Two.png', await png(A, '#059669', 300, 360, 'B2'))]);
  await A.waitForFunction(() => document.querySelectorAll('.item-card img').length === 2);
  await A.waitForFunction(() => [...document.querySelectorAll('.item-card img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10000 }).catch(() => {});
  ok(await A.evaluate(() => [...document.querySelectorAll('.item-card img')].every((i) => i.complete && i.naturalWidth > 0)), 'item images load from file storage');
  await A.click('[data-view-mode=list]'); await A.waitForSelector('.item-table');
  ok(await A.locator('.item-table tbody tr').count() === 2, 'list view');
  await A.click('[data-view-mode=grid]');

  // Assets
  await go(A, 'assets', '.assets-page');
  await choose(A, '.dropzone[data-pick=asset]', [file('hero.png', await png(A, '#9333ea', 640, 360, 'HERO'))]);
  await A.waitForSelector('.asset-card');
  ok((await A.textContent('.asset-card .asset-name')) === 'hero.png', 'asset uploaded');

  // Chat
  await go(A, 'chat', '#chat-text');
  await A.fill('#chat-text', 'Hello **team**'); await A.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg-text strong');
  ok((await A.textContent('.msg-head b')) === 'Alice', 'own name resolved from account');
  await choose(A, '[data-pick=chat]', [file('a.png', await png(A, '#0ea5e9', 400, 300, 'A')), file('b.png', await png(A, '#22c55e', 400, 300, 'B'))]);
  await A.click('.send-btn');
  await A.waitForSelector('.msg.outgoing', { state: 'detached' });
  await A.waitForFunction(() => document.querySelectorAll('.atts.multi button.att-img img').length === 2);
  ok(true, 'images sent in chat');
  await A.locator('.att-wrap').first().hover();
  await A.locator('.att-wrap').first().locator('.att-dl').click();
  await A.waitForFunction(() => window.__downloads.length === 1);
  ok(/\.png$/.test(await A.evaluate(() => window.__downloads[0].filename)), 'download button offers the image through the viewer');

  // Profile
  await go(A, 'profile', '#prof-name');
  await choose(A, '[data-pick=avatar]', file('me.png', await png(A, '#f97316', 300, 300, 'A')));
  await A.waitForSelector('#side-user .avatar.photo img');
  await A.fill('#prof-title', 'Lead developer'); await A.fill('#prof-email', 'alice@studio.test');
  await A.click('[data-form=profile] button.primary');
  await A.waitForSelector('#side-user >> text=Lead developer');
  ok(true, 'profile photo, role and contact email saved');

  // Editor joins
  const B = await open('bob');
  await B.waitForSelector('[data-join]');
  ok((await B.textContent('#invites')).includes('Baddie Dice'), 'editor sees the project and a Join button');
  await B.click('[data-join]');
  await B.waitForSelector('[data-join]', { state: 'detached' });
  await go(B, 'team', '.people li:nth-child(2)');
  const team = await B.textContent('.people');
  ok(team.includes('Alice') && team.includes('Bob') && team.includes('Lead developer') && team.includes('alice@studio.test'), "team shows names, Alice's role and contact email");
  ok(await B.locator('.people .avatar.photo').count() === 1, "Bob sees Alice's photo");
  ok((await B.textContent('#view')).includes('Share'), 'team page explains inviting through Share');
  await go(B, 'chat', '#chat-text');
  await B.waitForSelector('text=Hello team');
  await B.fill('#chat-text', 'Hi Alice!'); await B.press('#chat-text', 'Enter');
  await A.evaluate(() => { location.hash = 'chat'; });
  await A.waitForSelector('text=Hi Alice!');
  ok(true, 'chat syncs between viewers');

  // Channels + unread, mentions + notifications
  await A.evaluate(() => { location.hash = 'chat'; });
  await A.waitForSelector('[data-action=new-channel]');
  await A.click('[data-action=new-channel]'); await confirmAsk(A, 'art', 'Concept art');
  await A.waitForSelector('.chan-head:has-text("art")');
  await go(B, 'chat.general', '#chat-text');
  await A.fill('#chat-text', 'new art!'); await A.press('#chat-text', 'Enter');
  await B.waitForSelector('.chan-list a.unread[href="#chat.art"]');
  ok(true, 'unread dot on a channel with new messages');
  await B.fill('#chat-text', 'ping @Ali'); await B.waitForSelector('#mention-picker:not([hidden])'); await B.press('#chat-text', 'Enter');
  await B.type('#chat-text', 'look'); await B.press('#chat-text', 'Enter');
  await waitNotif(A, 'mention');
  await A.click('#bell');
  ok((await A.textContent('.notif-panel')).includes('mentioned you'), 'mention notification');
  await A.click('.np-item.unread');
  await A.waitForSelector('.msg.mentioned');
  ok(true, 'notification opens the mention');

  // Kanban drag
  await go(A, 'tasks', '[data-board-mode]');
  await A.click('[data-board-mode=board]'); await A.waitForSelector('.board .kcard:has-text("T3")');
  const cb = await A.locator('.kcard', { hasText: 'T3' }).boundingBox();
  const tb = await A.locator('.kcol[data-kcol=review] .kcol-body').boundingBox();
  await A.mouse.move(cb.x + 40, cb.y + 30); await A.mouse.down();
  await A.mouse.move(cb.x + 60, cb.y + 50, { steps: 4 }); await A.mouse.move(tb.x + tb.width / 2, tb.y + 30, { steps: 12 }); await A.mouse.up();
  await A.waitForFunction(() => tasks.find((t) => t.title === 'T3')?.status === 'review');
  ok(true, 'kanban drag to In review');
  await A.click('[data-board-mode=list]');

  // Patch notes
  await go(A, 'updates', '[data-action=new-update]');
  await A.click('.coll-toolbar [data-action=new-update]'); await A.waitForSelector('#doc-body h2');
  await A.fill('#doc-title', 'UPDATE 1');
  await A.evaluate(() => { const li = document.querySelector('#doc-body h2 + ul > li'); const r = document.createRange(); r.selectNodeContents(li); r.collapse(false); document.getElementById('doc-body').focus(); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await A.keyboard.type('Dice'); await A.keyboard.press('Enter'); await A.keyboard.type('Quests');
  await A.waitForSelector('#doc-save .doc-save.saved');
  await A.waitForFunction(() => updates.some((u) => u.title === 'UPDATE 1'));
  await A.click('.doc-topbar [data-action=preview-update][data-then=publish]');
  await A.click('.doc-preview-bar [data-action=publish-update]');
  await A.waitForSelector('.doc-read-actions');
  await waitNotif(B, 'update');
  ok(true, 'published update notifies the team');

  // Asset folders
  await go(A, 'assets', '[data-action=new-folder]');
  await A.click('[data-action=new-folder]'); await confirmAsk(A, 'Icons');
  await A.waitForSelector('.folder-tile');
  await A.locator('.asset-card', { hasText: 'hero.png' }).dragTo(A.locator('.folder-tile'));
  await A.waitForSelector('.folder-tile:has-text("1 file")');
  ok(true, 'asset dragged into a folder');

  // Roles: viewer gating in the interface
  await go(A, 'team', '.people');
  await A.click('#cs-role-u_bob'); await pick(A, 'Viewer');
  await B.waitForSelector('#invites:has-text("Viewer")');
  await go(B, 'tasks');
  ok(await B.locator('[data-action=new-task]').count() === 0, 'Viewer sees no New task button');
  await A.click('#cs-role-u_bob'); await pick(A, 'Member');
  await B.waitForFunction(() => roleOf(user.uid) === 'member');

  const stored = await A.evaluate(() => localStorage.getItem('mock:db'));
  ok(!/"name":"(Alice|Bob)"/.test(stored), 'account names are not copied into the database');

  // Activity
  await go(A, 'activity', '.act-list');
  ok(await A.locator('.act-row').count() >= 8 && await A.locator('.act-row .act-badge').count() === await A.locator('.act-row').count(), 'activity log with an icon on every entry');

  // View-only viewer
  const V = await open('vera');
  V.expectWriteError = true;
  await V.waitForSelector('#invites .invite');
  ok((await V.textContent('#invites')).includes('You can view this workspace'), 'view-only banner');
  await go(V, 'overview', 'text=T1');
  ok(await V.locator('[data-action=new-task]').count() === 0, 'view-only access has no New task button');
  const forced = await V.evaluate(async () => { try { await sub('tasks').add({ title: 'Sneaky', type: 'task', status: 'todo', priority: 'low' }); return 'allowed'; } catch (e) { return e.code; } });
  ok(forced === 'invalid_argument', 'a forced write from a view-only account is refused (' + forced + ')');
  ok(!(await A.evaluate(() => localStorage.getItem('mock:db'))).includes('Sneaky'), 'refused write left no data');

  // Mobile
  await A.setViewportSize({ width: 390, height: 844 });
  for (const v of ['overview', 'chat', 'team', 'assets', 'activity', 'updates', 'tasks']) {
    await go(A, v, v === 'chat' ? '#chat-text' : '#view h1'); await A.waitForTimeout(300);
    const w = await A.evaluate(() => document.documentElement.scrollWidth);
    ok(w <= 390, `mobile ${v} no horizontal scroll (${w})`);
  }
  await A.setViewportSize({ width: 1500, height: 950 });
  await go(A, 'overview'); await A.waitForTimeout(300);
  await A.screenshot({ path: process.env.OUT + '/art-overview.png' });

  // Owner deletes the project
  await go(A, 'project', '[data-action=delete-project]');
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'Baddie Dice');
  await A.waitForSelector('text=Create a project');
  await B.waitForSelector('text=Create a project');
  const left = JSON.parse(await A.evaluate(() => localStorage.getItem('mock:db')));
  ok(Object.keys(left).every((k) => k.startsWith('profiles/')), 'project and all its data deleted, profiles kept');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 6).join('\n')); process.exit(2); });
