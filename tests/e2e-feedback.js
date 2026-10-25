// End-to-end test of the Feedback page (Firebase edition, emulators).
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e-feedback.js
const { chromium } = require(process.env.PW);
const fs = require('fs');
const SDK = process.env.SDK;
const OUT = process.env.OUT || '.';
const BASE = 'http://127.0.0.1:5173/index.html?emulator';
const OOB = 'http://127.0.0.1:9099/emulator/v1/projects/demo-blackbox/oobCodes';
const errors = [];
const ok = (c, m) => { if (!c) errors.push('FAIL: ' + m); else console.log('PASS:', m); };
const run = Date.now();
const email = (n) => `${n}.fb.${run}@test.com`;

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
    if (page.expectDenied && /permission|Missing or insufficient/i.test(t)) return;
    errors.push(`[${label}] console: ${t.slice(0, 400)}`);
  });
  page.on('dialog', (d) => { errors.push(`[${label}] native dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(BASE);
  return page;
}
async function png(page, color, w = 320, h = 240, label = '') {
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
// A real (tiny) WebM video recorded from a canvas in the browser.
async function webm(page) {
  const b64 = await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 120;
    const g = cv.getContext('2d');
    g.fillRect(0, 0, 160, 120);
    const rec = new MediaRecorder(cv.captureStream(15), { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    let i = 0;
    const t = setInterval(() => { g.fillStyle = `hsl(${(i++ * 37) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 120); }, 50);
    await new Promise((r) => setTimeout(r, 900));
    rec.stop(); clearInterval(t);
    await stopped;
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });
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
async function choose(page, selector, files) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await fc.setFiles(files);
}
const pick = (page, label) => page.locator('#popover button', { hasText: label }).first().click();
const selectStyled = async (page, id, label) => { await page.click(`#cs-${id}`); await pick(page, label); };
const fsGet = async (path) => (await fetch(`http://127.0.0.1:8080/v1/projects/demo-blackbox/databases/(default)/documents/${path}`, { headers: { Authorization: 'Bearer owner' } })).json();
const fsList = async (path) => ((await fsGet(path)).documents || []).map((d) => ({ id: d.name.split('/').pop(), f: d.fields }));
const cards = (page) => page.locator('.fb-card .fb-title').allTextContents();
const waitCards = (page, n) => page.waitForFunction((n) => document.querySelectorAll('.fb-card').length === n, n);

(async () => {
  const browser = await chromium.launch();
  const A = await newUser(browser, 'Alice');
  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.waitForSelector('text=Create a project');
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Feedback Game');
  await A.waitForSelector('#set-name');
  const pid = await A.evaluate(() => currentId);
  ok(await A.evaluate(() => typeof openFeedback === 'function' && Array.isArray(feedbackItems) && !!FEEDBACK_STATUS.new && !!FEEDBACK_CATEGORY.ui && !!FEEDBACK_SOURCES.twitter), 'globals exported');
  ok(await A.evaluate(() => PROJECT_SUBCOLLECTIONS.includes('feedback')), 'feedback deleted with the project');

  // Empty state
  await go(A, 'feedback', '.fb-empty');
  ok((await A.textContent('.fb-empty')).includes('No feedback yet'), 'empty state shown');
  ok(await A.locator('.fb-empty [data-action=fb-new]').count() === 1, 'empty state has a call to action');
  await A.screenshot({ path: OUT + '/fb-empty.png' });

  // Create with an image and a video
  await A.click('.fb-empty [data-action=fb-new]');
  await A.waitForSelector('.fb-form #fb-in-title');
  ok((await A.textContent('#view h1')).includes('New feedback'), 'form opens');
  await A.fill('#fb-in-title', 'Let us trade duplicate dice');
  await A.fill('#fb-in-desc', 'I have 20 duplicates.\n1. Open inventory\n2. Try to trade\nThere is no trade button.');
  await A.fill('#fb-in-author', 'xXRollerXx');
  await selectStyled(A, 'fb-in-source', 'Roblox');
  await selectStyled(A, 'fb-in-category', 'Suggestion');
  await selectStyled(A, 'fb-in-priority', 'High');
  await A.fill('#fb-in-date', '2026-10-20');
  await A.fill('#fb-in-tags', 'trading, inventory');
  await choose(A, '.fb-form [data-pick=feedback-files]', [file('shot.png', await png(A, '#7c3aed', 320, 240, 'BUG'))]);
  await A.waitForSelector('.fb-att-edit');
  ok(await A.locator('.fb-att-edit img').count() === 1, 'image attached with preview in the form');
  const video = await webm(A);
  ok(video.length > 500, `tiny webm recorded in the browser (${video.length} bytes)`);
  await choose(A, '.fb-form [data-pick=feedback-files]', [file('clip.webm', video, 'video/webm')]);
  await A.waitForSelector('.fb-pend.uploading, .fb-att-edit:nth-child(2)');
  await A.waitForFunction(() => document.querySelectorAll('.fb-att-edit').length === 2 && !document.querySelector('.fb-pend'));
  ok(true, 'video uploaded (pending state then attached)');
  ok((await A.inputValue('#fb-in-title')) === 'Let us trade duplicate dice', 'typed text survives re-renders during upload');
  await A.click('#fb-save');
  await A.waitForSelector('.fb-detail');
  await A.waitForFunction(() => document.querySelector('#view h1')?.textContent === 'Let us trade duplicate dice');
  const fid = await A.evaluate(() => route().arg);
  let doc = (await fsGet(`projects/${pid}/feedback/${fid}`)).fields;
  ok(doc.title.stringValue === 'Let us trade duplicate dice' && doc.author.stringValue === 'xXRollerXx' && doc.source.stringValue === 'roblox'
    && doc.category.stringValue === 'suggestion' && doc.priority.stringValue === 'high' && doc.status.stringValue === 'new', 'feedback saved with all fields');
  ok(new Date(+doc.receivedAt.integerValue).getDate() === 20, 'received date saved');
  ok(JSON.stringify(doc.tags.arrayValue.values.map((v) => v.stringValue)) === '["trading","inventory"]', 'tags saved');
  const atts = doc.attachments.arrayValue.values.map((v) => v.mapValue.fields);
  ok(atts.length === 2 && atts[0].url.stringValue.startsWith('data:image/') && atts[1].url.stringValue.startsWith('bbfile:') && atts[1].type.stringValue === 'video/webm', 'image inline, video stored in chunks');
  ok(doc.createdBy.stringValue === await A.evaluate(() => user.uid), 'createdBy is the creator');
  await A.waitForSelector('.fb-atts .att-img img');
  await A.waitForSelector('.fb-atts .att-video video');
  ok(true, 'detail shows image and playable video');
  ok((await A.textContent('.fb-dl')).includes('xXRollerXx') && (await A.textContent('.fb-dl')).includes('Roblox'), 'detail shows player and source');
  await A.screenshot({ path: OUT + '/fb-detail.png', fullPage: true });

  // Attach from the detail page
  await choose(A, '.fb-atts [data-pick=feedback-files]', [file('second.png', await png(A, '#16a34a', 200, 150, '2'))]);
  await A.waitForFunction(() => document.querySelectorAll('.fb-atts .att-img').length === 2);
  for (let i = 0; i < 20 && (doc = (await fsGet(`projects/${pid}/feedback/${fid}`)).fields).attachments.arrayValue.values.length !== 3; i++) await A.waitForTimeout(200);
  ok(doc.attachments.arrayValue.values.length === 3, 'attachment added from the detail page');

  // Quick status change
  await A.click('[data-action=fb-set-status][data-status=analyzing]');
  await A.waitForSelector('[data-action=fb-set-status][data-status=analyzing].on');
  await A.waitForTimeout(300);
  doc = (await fsGet(`projects/${pid}/feedback/${fid}`)).fields;
  ok(doc.status.stringValue === 'analyzing', 'quick status change saved');

  // Edit
  await A.click('[data-action=fb-edit]');
  await A.waitForSelector('.fb-form');
  ok((await A.inputValue('#fb-in-title')) === 'Let us trade duplicate dice' && (await A.textContent('#cs-fb-in-source')).trim() === 'Roblox', 'edit form prefilled');
  await A.fill('#fb-in-title', 'Trading duplicate dice');
  await A.click('#fb-save');
  await A.waitForFunction(() => document.querySelector('#view h1')?.textContent === 'Trading duplicate dice' && document.querySelector('.fb-detail'));
  doc = (await fsGet(`projects/${pid}/feedback/${fid}`)).fields;
  ok(doc.title.stringValue === 'Trading duplicate dice' && doc.attachments.arrayValue.values.length === 3 && doc.status.stringValue === 'analyzing', 'edit saved, other fields kept');
  // Cancel edit leaves things unchanged
  await A.click('[data-action=fb-edit]'); await A.waitForSelector('.fb-form');
  await A.fill('#fb-in-title', 'Should not save');
  await A.click('[data-action=fb-cancel]');
  await A.waitForSelector('.fb-detail');
  ok((await A.textContent('#view h1')) === 'Trading duplicate dice', 'cancel discards edits');

  // Second and third feedback
  await go(A, 'feedback', '.fb-card');
  for (const [title, cat, src, prio, author] of [['Shop button hidden on phone', 'Interface', 'Discord', 'Low', 'Mia'], ['Game crashes when rolling 10x', 'Bug', 'YouTube', 'Critical', 'Zed']]) {
    await A.click('.fb-toolbar [data-action=fb-new]');
    await A.waitForSelector('.fb-form #fb-in-title');
    await A.fill('#fb-in-title', title);
    await A.fill('#fb-in-desc', `${title}. Reported by ${author}.`);
    await A.fill('#fb-in-author', author);
    await selectStyled(A, 'fb-in-category', cat);
    await selectStyled(A, 'fb-in-source', src);
    await selectStyled(A, 'fb-in-priority', prio);
    await A.click('#fb-save');
    await A.waitForFunction((t) => document.querySelector('#view h1')?.textContent === t && document.querySelector('.fb-detail'), title);
    await go(A, 'feedback', '.fb-card');
  }
  await waitCards(A, 3);
  ok(true, 'three feedback cards listed');
  ok((await A.textContent('.fb-stats')).includes('3'), 'summary counters');
  await A.screenshot({ path: OUT + '/fb-list.png', fullPage: true });

  // Search
  await A.fill('#fb-search', 'zed');
  await waitCards(A, 1);
  ok(JSON.stringify(await cards(A)) === '["Game crashes when rolling 10x"]', 'search by player name');
  await A.fill('#fb-search', 'inventory');
  await waitCards(A, 1);
  ok(JSON.stringify(await cards(A)) === '["Trading duplicate dice"]', 'search by tag');
  await A.fill('#fb-search', 'nothing like this');
  await A.waitForSelector('.fb-empty:has-text("No feedback matches")');
  ok(true, 'no-results state');
  await A.click('.fb-empty [data-action=fb-clear]');
  await waitCards(A, 3);
  ok((await A.inputValue('#fb-search')) === '', 'clear filters empties the search');

  // Filters
  await selectStyled(A, 'fb-f-category', 'Bug');
  await waitCards(A, 1);
  ok(JSON.stringify(await cards(A)) === '["Game crashes when rolling 10x"]', 'filter by category');
  await A.click('.fb-filters [data-action=fb-clear]');
  await waitCards(A, 3);
  await selectStyled(A, 'fb-f-source', 'Discord');
  await waitCards(A, 1);
  ok(JSON.stringify(await cards(A)) === '["Shop button hidden on phone"]', 'filter by source');
  await selectStyled(A, 'fb-f-source', 'All sources');
  await A.click('.fb-stat[data-status=analyzing]');
  await waitCards(A, 1);
  ok(JSON.stringify(await cards(A)) === '["Trading duplicate dice"]', 'filter by status counter');
  await A.click('.fb-stat[data-status=all]');
  await selectStyled(A, 'fb-f-priority', 'Low');
  await waitCards(A, 1);
  await selectStyled(A, 'fb-f-priority', 'All priorities');
  await waitCards(A, 3);
  await selectStyled(A, 'fb-f-sort', 'Sort: Priority');
  await A.waitForFunction(() => document.querySelector('.fb-card .fb-title')?.textContent === 'Game crashes when rolling 10x');
  ok(JSON.stringify(await cards(A)) === '["Game crashes when rolling 10x","Trading duplicate dice","Shop button hidden on phone"]', 'sort by priority');
  await selectStyled(A, 'fb-f-sort', 'Sort: Oldest first');
  await A.waitForFunction(() => document.querySelector('.fb-card .fb-title')?.textContent === 'Trading duplicate dice');
  ok(true, 'sort oldest first (received date)');

  // Convert to bug
  await A.click('.fb-card:has-text("Trading duplicate dice")');
  await A.waitForSelector('.fb-detail [data-action=fb-convert][data-type=bug]');
  await A.click('[data-action=fb-convert][data-type=bug]');
  await confirmAsk(A);
  await A.waitForSelector('.fb-link-card');
  doc = (await fsGet(`projects/${pid}/feedback/${fid}`)).fields;
  const taskId = doc.taskId?.stringValue;
  ok(!!taskId && doc.status.stringValue === 'planned', 'feedback gets taskId and becomes Planned');
  const task = (await fsGet(`projects/${pid}/tasks/${taskId}`)).fields;
  ok(task && task.feedbackId.stringValue === fid && task.type.stringValue === 'bug' && task.status.stringValue === 'todo' && task.priority.stringValue === 'high', 'bug task created with feedbackId');
  ok(task.links.arrayValue.values[0].mapValue.fields.kind.stringValue === 'feedback' && (task.actual?.stringValue || '').includes('no trade button') && (task.attachments?.arrayValue.values || []).length === 3, 'bug has link, actual result and attachments');
  ok((task.steps?.stringValue || '').startsWith('1. Open inventory'), 'steps prefilled from the numbered lines');
  ok((await A.textContent('.fb-link-card')).includes('Linked bug') && (await A.getAttribute('.fb-link-card a.link', 'href')) === `#bugs.${taskId}`, 'link to the bug shown');
  ok(await A.locator('[data-action=fb-convert]').count() === 0, 'no second conversion offered');
  // Convert another one to a task
  await go(A, 'feedback', '.fb-card');
  await A.click('.fb-card:has-text("Shop button hidden on phone")');
  await A.waitForSelector('[data-action=fb-convert][data-type=task]');
  // Without bugs.js (createTaskFrom missing) feedback.js creates the task itself.
  const hadHelper = await A.evaluate(() => { const had = typeof createTaskFrom === 'function'; window.__ctf = had ? createTaskFrom : null; if (had) createTaskFrom = undefined; return had; });
  await A.click('[data-action=fb-convert][data-type=task]'); await confirmAsk(A);
  await A.waitForSelector('.fb-link-card:has-text("Linked task")');
  await A.evaluate(() => { if (window.__ctf) createTaskFrom = window.__ctf; });
  const fid2 = await A.evaluate(() => route().arg);
  const tid2 = (await fsGet(`projects/${pid}/feedback/${fid2}`)).fields.taskId.stringValue;
  const t2 = (await fsGet(`projects/${pid}/tasks/${tid2}`)).fields;
  ok(t2.type.stringValue === 'task' && t2.feedbackId.stringValue === fid2 && t2.owner.stringValue === '' && +t2.order.integerValue >= 1, `fallback conversion creates the task (helper present: ${hadHelper})`);
  ok((await A.getAttribute('.fb-link-card a.link', 'href')) === '#tasks', 'task conversion links to tasks');
  await go(A, 'feedback', '.fb-card .fb-linked');
  ok(await A.locator('.fb-card .fb-linked').count() === 2, 'list shows linked badge');

  // Delete
  await A.click('.fb-card:has-text("Game crashes")');
  await A.waitForSelector('[data-action=fb-delete]');
  await A.click('[data-action=fb-delete]'); await A.click('#ask-cancel');
  ok(await A.locator('.fb-detail').count() === 1, 'delete can be cancelled');
  await A.click('[data-action=fb-delete]'); await confirmAsk(A);
  await A.waitForSelector('.fb-list');
  await waitCards(A, 2);
  ok((await fsList(`projects/${pid}/feedback`)).length === 2, 'feedback deleted');

  // Activity log
  await A.waitForTimeout(500);
  const acts = (await fsList(`projects/${pid}/activity`)).map((a) => ({ type: a.f.type?.stringValue, ref: a.f.ref?.stringValue }));
  const types = new Set(acts.map((a) => a.type));
  ok(['feedback.create', 'feedback.update', 'feedback.convert', 'feedback.delete'].every((t) => types.has(t)), 'activity logged: ' + [...types].join(', '));
  ok(acts.filter((a) => a.type?.startsWith('feedback.')).every((a) => a.ref?.startsWith('feedback:')), 'activity entries carry feedback refs');
  await go(A, 'activity', '.act-row');
  ok((await A.textContent('.act-filters')).includes('Feedback'), 'activity has a Feedback filter');

  // Viewer: read-only
  await go(A, 'team', '#invite-email');
  await A.fill('#invite-email', email('bob')); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  const B = await newUser(browser, 'Bob', { width: 390, height: 844 });
  await signUp(B, 'Bob', email('bob'));
  await verify(B, email('bob'));
  await B.waitForSelector('.invite');
  await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');
  const bobUid = await B.evaluate(() => user.uid);
  await A.click(`#cs-role-${bobUid}`); await pick(A, 'Viewer');
  await B.waitForFunction(() => roleOf(user.uid) === 'viewer');
  await go(B, 'feedback', '.fb-card');
  ok(await B.locator('[data-action=fb-new]').count() === 0, 'viewer has no New feedback button');
  await B.screenshot({ path: OUT + '/fb-mobile-list.png', fullPage: true });
  const overflow = await B.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  ok(!overflow, 'no horizontal page scroll on a phone');
  await B.click('.fb-card:has-text("Trading")');
  await B.waitForSelector('.fb-detail');
  ok(await B.locator('[data-action=fb-edit], [data-action=fb-delete], [data-action=fb-convert], .fb-atts [data-pick]').count() === 0, 'viewer sees no edit/delete/convert/upload');
  ok(await B.locator('[data-action=fb-set-status]:not([disabled])').count() === 0, 'viewer status buttons disabled');
  await B.screenshot({ path: OUT + '/fb-mobile-detail.png', fullPage: true });
  B.expectDenied = true;
  const vr = await B.evaluate(async () => { try { await sub('feedback').add({ title: 'x', createdBy: user.uid, createdAt: Date.now() }); return 'allowed'; } catch (e) { return e.code; } });
  ok(vr === 'permission-denied', 'rules: viewer cannot add feedback');
  B.expectDenied = false;

  // Member (not creator) cannot delete Alice's feedback in the UI
  await A.click(`#cs-role-${bobUid}`); await pick(A, 'Member');
  await B.waitForFunction(() => roleOf(user.uid) === 'member');
  await B.waitForSelector('[data-action=fb-edit]');
  ok(await B.locator('[data-action=fb-delete]').count() === 0, 'member sees Edit but not Delete on others\' feedback');

  await browser.close();
  console.log(errors.length ? '\n' + errors.join('\n') : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.log(errors.join('\n')); console.error('CRASH:', e.message.split('\n').slice(0, 8).join('\n')); process.exit(2); });
