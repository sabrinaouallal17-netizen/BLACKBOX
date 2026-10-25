// End-to-end test of the chat features (v1.7): presence, typing indicator, reactions, pins, videos, voice messages.
// Usage: PW=<playwright> SDK=<node_modules/firebase> OUT=<screenshot dir> node tests/e2e-chat.js
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


// A short real WebM video recorded from a canvas in the browser.
async function webm(page) {
  const b64 = await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90;
    const g = cv.getContext('2d');
    const rec = new MediaRecorder(cv.captureStream(15), { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    for (let i = 0; i < 12; i++) { g.fillStyle = `hsl(${i * 30} 80% 50%)`; g.fillRect(0, 0, 160, 90); await new Promise((r) => setTimeout(r, 70)); }
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}
const msg = (page, text) => page.locator('.msg', { hasText: text }).first();

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const A = await newUser(browser, 'Alice');
  await signUp(A, 'Alice', email('alice'));
  await verify(A, email('alice'));
  await A.click('.welcome [data-action=new-project]'); await confirmAsk(A, 'Chat Lab');
  await A.waitForSelector('#set-name');
  await go(A, 'team', '#invite-email');
  await A.fill('#invite-email', email('bob')); await A.click('[data-form=invite] button');
  await A.waitForSelector(`text=${email('bob')}`);
  const B = await newUser(browser, 'Bob');
  await signUp(B, 'Bob', email('bob'));
  await verify(B, email('bob'));
  await B.waitForSelector('.invite');
  await B.click('[data-accept]');
  await B.waitForSelector('h1:text("Project overview")');

  // Presence
  await go(A, 'team', '.people');
  await A.waitForFunction(() => document.querySelectorAll('.people .pres-online').length === 2, null, { timeout: 20000 });
  ok(true, 'team page shows both members online');
  await go(A, 'chat', '#chat-text'); await go(B, 'chat', '#chat-text');
  await A.waitForSelector('.chat-members .pres-label:has-text("Online — 2")');
  ok(true, 'chat member list groups people by status');
  await B.evaluate(() => { lastInput = Date.now() - 6 * 60000; sendPresence(true); });
  await A.waitForSelector('.chat-members .pres-label:has-text("Away — 1")', { timeout: 20000 });
  ok(true, 'idle member shows as away');
  await B.evaluate(() => { lastInput = Date.now(); sendPresence(true); });
  await B.evaluate(() => db.collection('profiles').doc(user.uid).set({ lastSeen: Date.now() - 10 * 60000, away: false }, { merge: true }));
  await A.waitForSelector('.chat-members .pres-label:has-text("Offline — 1")', { timeout: 20000 });
  ok(true, 'member not seen for minutes shows as offline');
  await B.evaluate(() => sendPresence(true));
  await A.waitForSelector('.chat-members .pres-label:has-text("Online — 2")', { timeout: 20000 });

  // Typing indicator
  await B.click('#chat-text'); await B.type('#chat-text', 'Hello Ali', { delay: 30 });
  await A.waitForSelector('.typing-line.on:has-text("Bob is typing")', { timeout: 10000 });
  ok(true, 'typing indicator: "Bob is typing…"');
  await A.click('#chat-text'); await A.type('#chat-text', 'hey', { delay: 30 });
  ok(!(await A.isVisible('.typing-line.on:has-text("Alice")')), 'you never see yourself typing');
  await B.type('#chat-text', 'ce!'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg-text:has-text("Hello Alice!")');
  await A.waitForSelector('.typing-line:not(.on)', { timeout: 10000 });
  ok(true, 'indicator disappears when the message is sent');
  const C = await A.evaluate(() => {
    const fakes = ['fakeA', 'fakeB', 'fakeC', 'fakeD'];
    fakes.forEach((f) => { typingDocs[f] = { channel: channelId, at: Date.now(), name: f }; project().memberIds.push(f); });
    render();
    const t = document.querySelector('.typing-line').textContent;
    project().memberIds.splice(-4); fakes.forEach((f) => delete typingDocs[f]); render();
    return t;
  });
  ok(/Several people are typing/.test(C), 'several typers summarised: ' + C);
  await A.fill('#chat-text', '');
  await A.press('#chat-text', 'Escape');

  // Reactions
  await msg(A, 'Hello Alice!').hover();
  await msg(A, 'Hello Alice!').locator('.msg-actions [data-react-pick]').click();
  await A.waitForSelector('#react-picker:not([hidden])');
  await A.click('#react-picker [data-react-choose=fire]');
  await A.waitForSelector('.react-chip.mine[data-key=fire] .n:text("1")');
  await B.waitForSelector('.react-chip[data-key=fire] .n:text("1")');
  ok(!(await B.isVisible('.react-chip.mine[data-key=fire]')), 'reaction shows for everyone, marked as mine only for me');
  await B.click('.react-chip[data-key=fire]');
  await A.waitForSelector('.react-chip[data-key=fire] .n:text("2")');
  ok(true, 'second person adds the same reaction: counter 2');
  const who = await A.getAttribute('.react-chip[data-key=fire]', 'aria-label');
  ok(/You and Bob|Bob and You/.test(who), 'who reacted is listed: ' + who);
  await A.hover('.react-chip[data-key=fire]');
  ok(await A.isVisible('.react-chip[data-key=fire] .react-who'), 'hover card with the names');
  await A.click('.react-chip[data-key=fire]');
  await B.waitForSelector('.react-chip[data-key=fire] .n:text("1")');
  ok(true, 'removing my reaction');
  await B.click('.react-chip[data-key=fire]');
  await B.waitForFunction(() => !document.querySelector('.react-chip[data-key=fire]'));
  ok(true, 'reaction disappears when nobody has it');

  // Pins
  await B.fill('#chat-text', 'Server restart at 9pm'); await B.press('#chat-text', 'Enter');
  await A.waitForSelector('.msg-text:has-text("Server restart at 9pm")');
  await msg(A, 'Server restart at 9pm').hover();
  await msg(A, 'Server restart at 9pm').locator('[data-pin-msg]').click();
  await A.waitForSelector('text=Message pinned');
  await B.waitForSelector('.msg.pinned .pinned-mark:has-text("Pinned by Alice")');
  ok(true, 'pinned message marked for everyone');
  await B.waitForSelector('.pins-count:text("1")');
  await B.click('.pins-btn');
  await B.waitForSelector('.pins-panel .pin-item:has-text("Server restart at 9pm")');
  ok(true, 'pins panel lists pinned messages');
  ok(await B.locator('.pins-panel [data-pin-msg]').count() === 1, 'members can unpin from the panel too');
  await B.click('.pins-panel [data-jump-msg]');
  await B.waitForSelector('.msg.flash');
  ok(!(await B.isVisible('.pins-panel')), 'jump closes the panel and highlights the message');
  await A.click('.pins-btn'); await A.click('.pins-panel [data-pin-msg]');
  await A.waitForSelector('.pins-empty');
  ok(true, 'unpin from the panel, empty state shown');
  await A.click('.pins-head [data-action=toggle-pins]');

  // Video
  const vid = await webm(A);
  await choose(A, '[data-pick=chat]', file('clip.webm', vid, 'video/webm'));
  await A.waitForSelector('.pend video');
  await A.click('.send-btn');
  await B.waitForSelector('.att-video video[src^="blob:"]', { timeout: 20000 });
  ok(true, 'video sent in chunks and plays inline for the other member');
  const vinfo = await B.evaluate(() => { const v = document.querySelector('.att-video video'); return new Promise((r) => { if (v.readyState >= 1) r(v.duration); else v.onloadedmetadata = () => r(v.duration); setTimeout(() => r(-1), 5000); }); });
  ok(vinfo !== -1, 'video metadata loads: ' + vinfo);
  const files = await A.evaluate(async () => (await sub('files').get()).docs.map((d) => d.data()));
  ok(files.length === 1 && files[0].type === 'video/webm' && files[0].chunks >= 1, 'stored file metadata ' + JSON.stringify(files.map((f) => [f.type, f.size, f.chunks])));

  // Voice message
  await A.context().grantPermissions(['microphone']);
  await A.click('[data-action=voice-start]');
  await A.waitForSelector('.voice-rec.recording');
  await A.waitForTimeout(1600);
  ok((await A.locator('#voice-live i').count()) > 5, 'live waveform while recording');
  ok(/0:0[1-2]/.test(await A.textContent('#voice-timer')), 'recording timer runs');
  await A.click('[data-action=voice-stop]');
  await A.waitForSelector('.voice-rec.preview .voice audio', { state: 'attached' });
  ok(true, 'preview before sending');
  await A.click('.voice-rec.preview [data-voice-play]');
  await A.waitForSelector('.voice-rec.preview .voice.playing', { timeout: 5000 });
  ok(true, 'preview plays');
  await A.click('.voice-rec.preview [data-voice-play]');
  await A.click('[data-action=voice-send]');
  await A.waitForSelector('.composer-row #chat-text');
  await B.waitForSelector('.msg .voice audio', { state: 'attached', timeout: 20000 });
  const dur = await B.textContent('.msg .voice .voice-time');
  ok(/^0:0[1-2]$/.test(dur), 'voice message shows its duration: ' + dur);
  await B.click('.msg .voice [data-voice-play]');
  await B.waitForSelector('.msg .voice.playing', { timeout: 5000 });
  await B.waitForFunction(() => document.querySelectorAll('.msg .voice .voice-wave i.on').length > 0, null, { timeout: 5000 });
  ok(true, 'voice message plays with waveform progress');
  await B.evaluate(() => render()); // a re-render must not interrupt playback
  ok(await B.evaluate(() => !document.querySelector('.msg .voice audio').paused || document.querySelector('.msg .voice audio').ended), 'playback survives re-renders');
  // Cancel a recording
  await A.click('[data-action=voice-start]'); await A.waitForSelector('.voice-rec.recording');
  await A.click('[data-action=voice-cancel]'); await A.waitForSelector('.composer-row #chat-text');
  ok(true, 'recording can be cancelled');
  await A.screenshot({ path: `${process.env.OUT}/chat-v17.png` });

  // Rules: reactions by others can't change the text; pins need member role
  B.expectDenied = true;
  const res = await B.evaluate(async () => {
    const out = {};
    const m = messages.find((x) => x.uid !== user.uid);
    try { await msgCol().doc(m.id).update({ text: 'hacked' }); out.edit = 'allowed'; } catch (e) { out.edit = e.code; }
    try { await msgCol().doc(m.id).update({ 'reactions.like': firebase.firestore.FieldValue.arrayUnion(user.uid) }); out.react = 'allowed'; } catch (e) { out.react = e.code; }
    try { await msgCol().doc(m.id).update({ 'reactions.like': firebase.firestore.FieldValue.arrayUnion(user.uid), text: 'x' }); out.mixed = 'allowed'; } catch (e) { out.mixed = e.code; }
    try { await sub('typing').doc('someone-else').set({ channel: 'general', at: Date.now() }); out.typingOther = 'allowed'; } catch (e) { out.typingOther = e.code; }
    return out;
  });
  ok(res.edit === 'permission-denied' && res.react === 'allowed' && res.mixed === 'permission-denied' && res.typingOther === 'permission-denied', 'rules: ' + JSON.stringify(res));

  await browser.close();
  console.log(errors.length ? `\n${errors.join('\n')}` : '\nALL OK');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); console.log(errors.join('\n')); process.exit(1); });
