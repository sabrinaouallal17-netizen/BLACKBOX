// End-to-end test of the Updates changelog editor (Firebase edition, emulators).
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e-updates.js
const { chromium } = require(process.env.PW);
const fs = require('fs');
const SDK = process.env.SDK;
const BASE = 'http://127.0.0.1:5173/index.html?emulator';
const OOB = 'http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes';
const errors = [];
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else console.log('PASS:', m); };
const run = Date.now();
const email = (n) => `${n}.${run}@test.com`;

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
    if (page.expectDenied && /permission|Missing or insufficient/i.test(t)) return;
    errors.push(`[${label}] console: ${t.slice(0, 400)}`);
  });
  page.on('dialog', (d) => { errors.push(`[${label}] native dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(BASE);
  return page;
}
async function png(page, color, w = 480, h = 270, label = '') {
  const b64 = await page.evaluate(([c, w, h, label]) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const grad = g.createLinearGradient(0, 0, w, h); grad.addColorStop(0, c); grad.addColorStop(1, '#111');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(h / 6)}px sans-serif`; g.fillText(label, w * 0.1, h * 0.55);
    return cv.toDataURL('image/png').split(',')[1];
  }, [color, w, h, label]);
  return Buffer.from(b64, 'base64');
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
const go = async (page, view, sel = '#view h1') => { await page.goto(BASE + '#' + view); await page.waitForSelector(`#view.view-${view.split('.')[0]}`); await page.waitForSelector(sel); };
async function choose(page, selector, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await fc.setFiles(files);
}
const pick = (page, label) => page.locator('#popover button', { hasText: label }).first().click();
const waitNotif = (page, type) => page.waitForFunction((t) => allNotifs().some((n) => n.type === t && !n.read), type);
const fsList = async (path) => ((await (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' } })).json()).documents || []);
// Puts the caret inside an element of the editor (end by default).
const caret = (page, sel, atStart = false) => page.evaluate(([sel, atStart]) => {
  const el = document.querySelector(sel);
  document.getElementById('doc-body').focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(atStart);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}, [sel, atStart]);
const saved = (page) => page.waitForSelector('#doc-save .doc-save.saved', { timeout: 15000 });
const body = (page) => page.evaluate(() => document.getElementById('doc-body').innerHTML);

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Docs Game');
  await A.waitForSelector('#set-name');
  await A.waitForFunction(() => !!project());

  // Completed work for "Fill from completed work"
  await A.evaluate(async () => {
    const t = Date.now();
    await sub('tasks').add({ title: 'Dice shop', type: 'task', status: 'done', priority: 'low', order: 0, createdBy: user.uid, createdAt: t, updatedAt: t });
    await sub('tasks').add({ title: 'Improve loading speed', type: 'task', status: 'done', priority: 'low', order: 1, createdBy: user.uid, createdAt: t, updatedAt: t });
    await sub('tasks').add({ title: 'Crash on reroll', type: 'bug', status: 'done', priority: 'high', order: 2, createdBy: user.uid, createdAt: t, updatedAt: t, resolvedAt: t });
    await sub('tasks').add({ title: 'Not finished yet', type: 'task', status: 'progress', priority: 'low', order: 3, createdBy: user.uid, createdAt: t, updatedAt: t });
  });

  // Invite Bob (member)
  await go(A, 'team', '#invite-email');
  await A.fill('#invite-email', email('bob')); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  const B = await newUser(browser, 'Bob');
  await signUp(B, 'Bob', email('bob'));
  await verify(B, email('bob'));
  await B.waitForSelector('.invite');
  await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');
  ok(true, 'Bob invited and joined as a member');

  // History: empty state
  await go(A, 'updates', '.updates-page');
  ok((await A.textContent('.updates-page')).includes('No updates yet'), 'history empty state');

  // New update → editor with the starter structure
  await A.click('.coll-toolbar [data-action=new-update]');
  await A.waitForSelector('#doc-body h2');
  const heads = await A.locator('#doc-body h2').allTextContents();
  ok(heads.join('|') === 'New features|Improvements|Bug fixes|Known issues', 'starter structure: ' + heads.join(', '));
  ok(await A.locator('#doc-body h2 + ul > li').count() === 4, 'each starter section has an empty bulleted list');
  const updId = await A.evaluate(() => location.hash.split('.')[1]);
  ok(/\.edit$/.test(await A.evaluate(() => location.hash)), 'editor has its own route');

  // Metadata
  await A.fill('#doc-title', 'UPDATE 2: Docs');
  await A.fill('#doc-version', 'v2.0');
  await A.fill('#doc-summary', 'Rich changelogs with pages.');
  await A.waitForFunction((id) => updates.find((u) => u.id === id)?.title === 'UPDATE 2: Docs' && updates.find((u) => u.id === id)?.summary === 'Rich changelogs with pages.', updId);
  ok((await A.textContent('#view h1')) === 'UPDATE 2: Docs', 'title, version and summary saved from the details panel');

  // Rich text: bold
  await caret(A, '#doc-body h2:nth-of-type(1) + ul > li');
  await A.keyboard.type('Double rolls ');
  await A.keyboard.press('Control+b');
  await A.keyboard.type('twice as fast');
  await A.keyboard.press('Control+b');
  ok(await A.locator('#doc-body li b, #doc-body li strong').count() === 1 && (await A.textContent('#doc-body li b, #doc-body li strong')).includes('twice as fast'), 'bold with Ctrl+B');
  // Toolbar italic
  await A.keyboard.type(' and ');
  await A.click('[data-doc-cmd=italic]');
  await A.keyboard.type('shiny');
  await A.click('[data-doc-cmd=italic]');
  ok(await A.locator('#doc-body li i, #doc-body li em').count() === 1, 'italic from the toolbar');
  // Heading at the end (Enter on the empty last item leaves the list)
  await caret(A, '#doc-body h2:nth-of-type(4) + ul > li');
  await A.keyboard.press('Enter');
  await A.click('[data-doc-cmd=blockmenu]'); await pick(A, 'Heading 1');
  await A.keyboard.type('Big news');
  ok(await A.locator('#doc-body h1').textContent() === 'Big news', 'heading from the text style menu');
  ok(await A.locator('[data-keep="doc-block-label"]').textContent() === 'Heading 1', 'toolbar shows the current text style');
  // Autoformat checklist
  await A.keyboard.press('Enter');
  await A.click('[data-doc-cmd=blockmenu]'); await pick(A, 'Paragraph');
  await A.keyboard.type('[] ');
  await A.keyboard.type('Ship the docs');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Celebrate');
  ok(await A.locator('#doc-body ul[data-checklist] > li').count() === 2, 'checklist by typing [ ] at the start of a line');
  const li = A.locator('#doc-body ul[data-checklist] > li').first();
  const box = await li.boundingBox();
  await A.mouse.click(box.x + 8, box.y + box.height / 2);
  ok(await li.getAttribute('data-checked') === 'true' && await A.locator('#doc-body ul[data-checklist] > li').nth(1).getAttribute('data-checked') === 'false', 'clicking a checkbox checks the item');
  // Link
  await A.keyboard.press('Enter'); await A.keyboard.press('Enter');
  await A.keyboard.type('Read more: ');
  await A.keyboard.press('Control+k');
  await A.waitForSelector('#ask-dialog[open]');
  await confirmAsk(A, 'example.com/notes', 'the notes');
  await A.waitForFunction(() => document.querySelector('#doc-body a')?.getAttribute('href') === 'https://example.com/notes');
  ok(true, 'link inserted with Ctrl+K (https added)');
  await A.waitForSelector('#doc-save .doc-save.saving, #doc-save .doc-save.pending, #doc-save .doc-save.saved');
  await saved(A);
  ok(true, 'autosave indicator reaches "All changes saved"');

  // Fill from completed work
  await A.click('[data-action=fill-update]');
  await A.waitForSelector('text=Added 3 completed items');
  const listText = async (h) => A.evaluate((h) => [...document.querySelectorAll('#doc-body h2')].find((x) => x.textContent === h).nextElementSibling.textContent, h);
  ok((await listText('New features')).includes('Dice shop') && (await listText('Improvements')).includes('Improve loading speed') && (await listText('Bug fixes')).includes('Crash on reroll') && !(await body(A)).includes('Not finished'), 'fill from completed work sorts tasks and bugs into sections');

  // Table
  await caret(A, '#doc-body h1');
  await A.click('[data-doc-cmd=table]');
  await A.waitForSelector('#doc-tablepick');
  await A.hover('[data-tp-r="3"][data-tp-c="2"]');
  ok((await A.textContent('.tp-label')) === '3 × 2', 'table size picker');
  await A.click('[data-tp-r="3"][data-tp-c="2"]');
  await A.waitForSelector('#doc-body table');
  ok(await A.locator('#doc-body table tr').count() === 3 && await A.locator('#doc-body table tr:first-child td').count() === 2, 'table 3×2 inserted');
  await caret(A, '#doc-body table td');
  await A.keyboard.type('Mode');
  await A.keyboard.press('Tab'); await A.keyboard.type('Odds');
  await A.waitForSelector('#doc-toolbar.in-table');
  await A.click('[data-doc-cmd=rowBelow]');
  await A.click('[data-doc-cmd=colRight]');
  ok(await A.locator('#doc-body table tr').count() === 4 && await A.locator('#doc-body table tr:first-child td').count() === 3, 'add row and column');
  await A.click('[data-doc-cmd=delCol]');
  ok(await A.locator('#doc-body table tr:first-child td').count() === 2 && (await A.textContent('#doc-body table')).includes('Odds'), 'remove column, cells keep their text');

  // Image (stored as a separate file, referenced by data-src)
  await caret(A, '#doc-body h1');
  await choose(A, '[data-pick=doc-image]', { name: 'shot.png', mimeType: 'image/png', buffer: await png(A, '#7c3aed', 480, 270, 'DOCS') });
  await A.waitForSelector('#doc-body img[data-src^="bbfile:"][src^="blob:"]');
  ok(true, 'image uploaded as a stored file and shown in the page');
  await saved(A);
  const sheetDocs = await fsList(`projects/${await A.evaluate(() => currentId)}/updates/${updId}/sheets`);
  const html0 = sheetDocs[0]?.fields?.html?.stringValue || '';
  ok(html0.includes('data-src="bbfile:') && !html0.includes('src="blob:') && !html0.includes('data:image') && html0.length < 20000, `saved HTML stays small and references the file (${html0.length} chars)`);

  // Second page, rename, reorder
  await A.click('.doc-panel-head [data-action=doc-add-sheet]');
  await A.waitForFunction(() => document.querySelectorAll('.sheet-tab').length === 2 && document.querySelector('.sheet-tab.on')?.textContent.includes('Page 2'));
  await A.waitForSelector('#doc-body');
  await A.click('#doc-body');
  await A.keyboard.type('Roadmap for next month');
  await A.locator('.sheet-tab', { hasText: 'Page 2' }).locator('[data-sheet-menu]').click();
  await pick(A, 'Rename'); await confirmAsk(A, 'Roadmap');
  await A.waitForSelector('.sheet-tab.on:has-text("Roadmap")');
  await A.locator('.sheet-tab', { hasText: 'Roadmap' }).locator('[data-sheet-menu]').click();
  await pick(A, 'Move up');
  await A.waitForFunction(() => [...document.querySelectorAll('.sheet-tab .sheet-name')].map((e) => e.textContent.trim()).join() === 'Roadmap,Patch notes');
  ok(true, 'second page added, renamed and moved up');
  await saved(A);
  // Switch pages keeps each page's text
  await A.click('.sheet-tab:has-text("Patch notes") .sheet-name');
  await A.waitForSelector('#doc-body h2');
  ok((await body(A)).includes('Double rolls') && !(await body(A)).includes('Roadmap for next month'), 'switching pages shows each page');

  // Persists after reload
  await A.reload();
  await A.waitForSelector('#doc-body');
  await A.click('.sheet-tab:has-text("Patch notes") .sheet-name');
  await A.waitForSelector('#doc-body h2');
  const after = await body(A);
  ok(after.includes('<b>twice as fast</b>') && after.includes('<h1>') && after.includes('data-checked="true"') && after.includes('<table>') && after.includes('Odds') && after.includes('href="https://example.com/notes"'), 'rich content persists after reload');
  await A.waitForSelector('#doc-body img[src^="blob:"]');
  ok(true, 'stored image loads again after reload');
  await A.click('.sheet-tab:has-text("Roadmap") .sheet-name');
  await A.waitForFunction(() => document.getElementById('doc-body')?.textContent.includes('Roadmap for next month'));
  ok(true, 'second page persists after reload');
  // A live re-render does not clobber the editor
  await A.click('#doc-body'); await A.keyboard.press('End'); await A.keyboard.type(' and more');
  const node = await A.evaluateHandle(() => document.getElementById('doc-body'));
  await A.evaluate(() => sub('updates').doc(location.hash.split('.')[1]).update({ summary: 'Changed elsewhere' }));
  await A.waitForFunction(() => document.getElementById('doc-summary')?.value === 'Changed elsewhere');
  ok(await node.evaluate((el) => el.isConnected && el.textContent.includes('and more')), 'live updates never redraw the page being typed in');
  await saved(A);
  await A.screenshot({ path: process.env.OUT + '/u-editor.png' });

  // Preview, then publish
  await A.click('.doc-topbar [data-action=preview-update][data-then=publish]');
  await A.waitForSelector('.doc-preview-bar');
  await A.waitForSelector('.doc-read .doc-sheet img[src^="blob:"]');
  const prev = await A.textContent('.doc-read');
  ok(await A.locator('.doc-read .doc-sheet').count() === 2 && await A.locator('.doc-jump .chip').count() === 2, 'preview shows every page with a page navigation');
  ok(prev.includes('Double rolls') && !prev.includes('Known issues') && await A.locator('.doc-read [contenteditable]').count() === 0, 'preview is read-only and hides empty sections');
  await A.screenshot({ path: process.env.OUT + '/u-preview.png', fullPage: true });
  await A.click('.doc-preview-bar [data-action=publish-update]');
  await A.waitForSelector('text=Update published');
  await A.waitForFunction(() => !location.hash.includes('.preview'));

  // Member reads it
  await waitNotif(B, 'update');
  ok(true, 'members are notified when an update is published');
  await go(B, 'updates', '.timeline');
  ok((await B.textContent('.timeline')).includes('UPDATE 2: Docs') && await B.locator('[data-action=new-update]').count() === 0, 'member sees the published update in the history');
  await B.click('.tl-card h3 a');
  await B.waitForSelector('.doc-read .doc-prose b');
  ok((await B.textContent('.doc-read')).includes('Roadmap for next month') && await B.locator('[contenteditable]').count() === 0 && await B.locator('.doc-read-actions').count() === 0, 'member reads every page, read-only');
  await B.waitForSelector('.doc-read img[src^="blob:"]');
  ok(true, 'member sees the stored image');
  await go(B, `updates.${updId}.edit`, '.doc-read');
  ok(await B.locator('#doc-body').count() === 0, 'members cannot open the editor');

  // Drafts stay hidden
  await go(A, 'updates', '.timeline');
  await A.click('.coll-toolbar [data-action=new-update]');
  await A.waitForSelector('#doc-body h2');
  const draftId = await A.evaluate(() => location.hash.split('.')[1]);
  await A.fill('#doc-title', 'Secret draft');
  await A.waitForFunction((id) => updates.find((u) => u.id === id)?.title === 'Secret draft', draftId);
  B.expectDenied = true;
  const denied = await B.evaluate(async (id) => {
    const out = {};
    try { await sub('updates').doc(id).collection('sheets').get(); out.sheets = 'allowed'; } catch (e) { out.sheets = e.code; }
    try { await sub('updates').doc(id).get(); out.doc = 'allowed'; } catch (e) { out.doc = e.code; }
    try { await sub('updates').doc(id).update({ title: 'hacked' }); out.write = 'allowed'; } catch (e) { out.write = e.code; }
    return out;
  }, draftId);
  B.expectDenied = false;
  ok(Object.values(denied).every((v) => v === 'permission-denied'), 'rules hide draft pages from members ' + JSON.stringify(denied));
  await go(B, 'updates', '.timeline');
  ok(!(await B.textContent('.timeline')).includes('Secret draft') && !(await B.evaluate((id) => updates.some((u) => u.id === id), draftId)), 'drafts are not listed for members');
  await go(B, `updates.${draftId}`, '.big-empty');
  ok((await B.textContent('.big-empty')).includes('Update not found'), 'opening a draft link shows "not found" to members');

  // Sanitizer
  const san = await A.evaluate(() => sanitizeHtml('<p onclick="alert(1)" style="color:red">hi<script>window.__xss=1</script><img src=x onerror="window.__xss=1"><a href="javascript:alert(1)">bad</a><a href="https://ok.test/x">good</a><img data-src="bbfile:abc/def"><iframe src="https://evil.test"></iframe><svg onload="alert(1)"></svg><video src="javascript:alert(1)"></video><ul data-checklist="x"><li data-checked="true" onmouseover="x">done</li></ul><td colspan="3"></td></p>'));
  ok(!/script|onerror|onclick|onload|onmouseover|javascript:|style=|iframe|svg|src="x"/i.test(san) && san.includes('href="https://ok.test/x"') && san.includes('rel="noopener noreferrer"') && san.includes('data-src="bbfile:abc/def"') && san.includes('<ul data-checklist=""><li data-checked="true">done</li></ul>'), 'sanitizer keeps the allow-list only: ' + san);
  // Malicious stored HTML is neutralised when members read it
  await A.evaluate((id) => sub('updates').doc(id).collection('sheets').add({ name: 'Evil', html: '<p>evil page</p><img src="x" onerror="window.__xss=1"><script>window.__xss=2</script><a href="javascript:window.__xss=3" id="jl">click</a>', order: 9, updatedAt: Date.now() }), updId);
  await go(B, `updates.${updId}`, '.doc-read');
  await B.waitForSelector('.doc-read :text("evil page")');
  await B.waitForTimeout(500);
  const xss = await B.evaluate(() => ({ flag: window.__xss, scripts: document.querySelectorAll('.doc-read script').length, handlers: document.querySelectorAll('.doc-read [onerror], .doc-read [onclick]').length, js: [...document.querySelectorAll('.doc-read a')].some((a) => /javascript/i.test(a.getAttribute('href') || '')) }));
  ok(xss.flag === undefined && !xss.scripts && !xss.handlers && !xss.js, 'stored <script>/onerror/javascript: are stripped at render ' + JSON.stringify(xss));

  // Legacy update with sections still displays, and converts to a page in the editor
  const legacyId = await A.evaluate(async () => (await sub('updates').add({ title: 'UPDATE 1: Legacy', version: 'v1.0', status: 'published', sections: { new: ['Old feature **bold**'], fixed: ['Old fix'] }, createdBy: user.uid, createdAt: Date.now() - 864e5 * 30, publishedAt: Date.now() - 864e5 * 30 })).id);
  await go(B, `updates.${legacyId}`, '.doc-read');
  await B.waitForSelector('.doc-read h2');
  ok((await B.textContent('.doc-read')).includes('Old feature') && (await B.textContent('.doc-read')).includes('Bug fixes') && await B.locator('.doc-read strong').count() === 1, 'legacy patch notes still display');
  await go(A, `updates.${legacyId}.edit`, '#doc-body h2');
  ok((await body(A)).includes('Old feature') && (await body(A)).includes('Old fix'), 'legacy sections convert to a page in the editor');
  await A.waitForFunction(() => document.querySelectorAll('.sheet-tab').length === 1);
  ok(true, 'conversion creates exactly one page');

  // History: timeline, search, filter, duplicate, delete
  await go(A, 'updates', '.timeline');
  ok(await A.locator('.tl-item').count() === 3 && await A.locator('.tl-item .doc-status.draft').count() === 1, 'history lists every version with its status');
  await A.fill('#upd-search', 'legacy');
  await A.waitForFunction(() => document.querySelectorAll('.tl-item').length === 1);
  ok((await A.textContent('.timeline')).includes('UPDATE 1: Legacy'), 'search the history');
  await A.fill('#upd-search', '');
  await A.click('[data-upd-filter=draft]');
  await A.waitForFunction(() => document.querySelectorAll('.tl-item').length === 1);
  ok((await A.textContent('.timeline')).includes('Secret draft'), 'filter drafts');
  await A.click('[data-upd-filter=all]');
  await A.waitForFunction(() => document.querySelectorAll('.tl-item').length === 3);
  await A.screenshot({ path: process.env.OUT + '/u-history.png' });
  await A.locator('.tl-item', { hasText: 'UPDATE 2: Docs' }).locator('[data-upd-menu]').click();
  await pick(A, 'Duplicate');
  await A.waitForSelector('text=Duplicated as a new draft');
  await A.waitForSelector('#doc-body');
  const copyId = await A.evaluate(() => location.hash.split('.')[1]);
  await A.waitForFunction(() => document.querySelectorAll('.sheet-tab').length === 3);
  ok((await A.inputValue('#doc-title')) === 'UPDATE 2: Docs (copy)' && await A.locator('.doc-topbar .doc-status.draft').count() === 1, 'duplicate as a new draft with all pages');
  const pid = await A.evaluate(() => currentId);
  ok((await fsList(`projects/${pid}/updates/${copyId}/sheets`)).length === 3, 'duplicated pages stored');
  await A.locator('[data-upd-menu]').first().click();
  await pick(A, 'Delete');
  await confirmAsk(A);
  await A.waitForSelector('text=Update deleted');
  await A.waitForSelector('.timeline');
  ok((await fsList(`projects/${pid}/updates/${copyId}/sheets`)).length === 0 && !(await A.evaluate((id) => updates.some((u) => u.id === id), copyId)), 'deleting an update deletes its pages');

  // Unpublish hides it again from members
  await go(A, `updates.${legacyId}`, '.doc-read-actions');
  await A.click('.doc-read-actions [data-action=unpublish-update]');
  await A.waitForSelector('text=Moved back to drafts');
  await B.waitForFunction((id) => !updates.some((u) => u.id === id), legacyId);
  ok(true, 'unpublish hides the update from members');

  // Mobile
  await A.setViewportSize({ width: 390, height: 844 });
  await go(A, `updates.${updId}.edit`, '#doc-body');
  await A.waitForTimeout(300);
  const w = await A.evaluate(() => document.documentElement.scrollWidth);
  const tbScroll = await A.evaluate(() => { const t = document.getElementById('doc-toolbar'); return getComputedStyle(t).overflowX; });
  ok(w <= 390 && tbScroll === 'auto', `mobile editor: no horizontal page scroll (${w}), toolbar scrolls`);
  await A.screenshot({ path: process.env.OUT + '/u-mobile-editor.png' });
  await go(A, 'updates', '.timeline'); await A.waitForTimeout(300);
  ok(await A.evaluate(() => document.documentElement.scrollWidth) <= 390, 'mobile history: no horizontal scroll');
  await go(A, `updates.${updId}`, '.doc-read'); await A.waitForTimeout(300);
  ok(await A.evaluate(() => document.documentElement.scrollWidth) <= 390, 'mobile reading view: no horizontal scroll');
  await A.screenshot({ path: process.env.OUT + '/u-mobile-read.png' });

  // Project deletion removes the pages of every update
  await A.setViewportSize({ width: 1500, height: 950 });
  await go(A, 'project', '[data-action=delete-project]');
  await A.click('[data-action=delete-project]'); await confirmAsk(A, 'Docs Game');
  await A.waitForSelector('text=Create a project');
  ok((await fsList(`projects/${pid}/updates/${updId}/sheets`)).length === 0 && (await fsList(`projects/${pid}/updates`)).length === 0, 'deleting the project deletes updates and their pages');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(2); });
