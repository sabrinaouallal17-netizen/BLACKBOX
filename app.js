"use strict";

/* ---------- Firebase setup ---------- */
// ?emulator in the URL points the app at the local Firebase emulators (used for development and tests).
// The Artifact edition (artifact/backend.js) provides a Firebase-compatible layer over claude.ai accounts.
const ARTIFACT = !!window.BLACKBOX_ARTIFACT;
const USE_EMULATOR = !ARTIFACT && new URLSearchParams(location.search).has("emulator");
const FB_CONFIG = ARTIFACT ? {} : USE_EMULATOR
  ? { apiKey: "demo-key", authDomain: "demo-blackbox.firebaseapp.com", projectId: "demo-blackbox" }
  : window.FIREBASE_CONFIG;
let auth = null;
let db = null;

/* ---------- State ---------- */
let user = null;          // Firebase user (verified)
let projects = {};        // id -> project data, live
let invites = [];         // projects inviting me, live
let currentId = null;
let tasks = [];
let activity = [];
let messages = [];
let lists = {};           // table key -> ordered task ids, used by Up/Down
let taskFilter = { status: "all", owner: "all" };
let unsubProjects = [];
let unsubCurrent = [];
let subscribedId = null;
let deletingId = null;      // project being deleted; its settings page shows progress   // project whose tasks/activity/messages are being listened to

const project = () => projects[currentId] || null;
const me = () => (user ? { uid: user.uid, name: user.displayName || (user.email || "").split("@")[0] || "You", email: (user.email || "").toLowerCase() } : null);
// Name written into shared data. The Artifact edition stores only account ids and resolves names when rendering.
const storedName = () => (ARTIFACT ? "" : me().name);

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
const splitList = (s) => [...new Set(String(s || "").split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 12);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function storeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2500);
}

// Runs a Firebase write and reports failures instead of failing silently.
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r ?? true;
  } catch (e) {
    console.error("BLACKBOX:", e);
    toast(friendlyError(e), true);
    return null;
  }
}

function friendlyError(e) {
  const map = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong email or password.",
    "auth/user-not-found": "No account with this email.",
    "auth/email-already-in-use": "An account already uses this email. Sign in instead.",
    "auth/weak-password": "Use at least 6 characters for the password.",
    "auth/invalid-email": "This email address doesn't look right.",
    "auth/missing-password": "Enter your password.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/network-request-failed": "No connection to the server. Check your internet.",
    "permission-denied": "You don't have access to do that.",
    unavailable: "The server can't be reached right now. Changes will sync when you're back online.",
    invalid_argument: "You can't change this workspace. Ask the owner to share it with you as Editor.",
    quota_exceeded: "The workspace is full. Delete old tasks or messages to make room.",
    revoked: "Your access to this page changed. Reload the page.",
    "not-found": "This item no longer exists.",
  };
  return map[e?.code] || e?.message || "Something went wrong.";
}

// In-page replacement for prompt()/confirm(), which sandboxed viewers block.
// Resolves to an array of field values, [] for a plain confirmation, or null if cancelled.
function ask({ title, text = "", fields = [], ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    const d = $("#ask-dialog");
    const f = $("#ask-form");
    $("#ask-title").textContent = title;
    $("#ask-text").textContent = text;
    $("#ask-text").hidden = !text;
    $("#ask-fields").innerHTML = fields.map((fl, i) =>
      `<label>${esc(fl.label)}<input id="ask-f${i}" name="f${i}" type="${fl.type || "text"}" value="${esc(fl.value || "")}" maxlength="${fl.max || 80}" autocomplete="off" ${fl.optional ? "" : "required"}></label>`).join("");
    const okBtn = $("#ask-ok");
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? "danger" : "primary"}`;
    const done = (v) => {
      f.onsubmit = d.oncancel = $("#ask-cancel").onclick = null;
      if (d.open) d.close();
      resolve(v);
    };
    f.onsubmit = (e) => { e.preventDefault(); done(fields.map((_, i) => f.elements[`f${i}`].value.trim())); };
    $("#ask-cancel").onclick = () => done(null);
    d.oncancel = (e) => { e.preventDefault(); done(null); };
    d.showModal();
    (f.querySelector("input") || okBtn).focus();
  });
}

const PRIORITY = {
  critical: { label: "Critical", icon: "chevronsUp" },
  high: { label: "High", icon: "chevronsUp" },
  medium: { label: "Medium", icon: "minus" },
  low: { label: "Low", icon: "chevronsDown" },
};
const STATUS = {
  todo: { label: "To do", icon: "circle" },
  progress: { label: "In progress", icon: "spinner" },
  review: { label: "In review", icon: "spinner" },
  done: { label: "Done", icon: "checkSmall" },
};

/* ---------- Icons (inline SVG, lucide-style) ---------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" fill="currentColor" stroke="none"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 10v10M8 13H3M21 13h-5M5 7l3 2M19 7l-3 2M5 20l3-3M19 20l-3-3M9.5 6 8 3M14.5 6 16 3"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  file: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3v5.5h-5.5"/>',
  checkBig: '<path d="m5 12 5 5 9-10"/>',
  checkSmall: '<path d="m6 12 4 4 8-8"/>',
  circleCheck: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.5 12 3 3 6-6" stroke="#0e0e14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  chevronsUp: '<path d="m7 11 5-5 5 5M7 18l5-5 5 5"/>',
  chevronsDown: '<path d="m7 6 5 5 5-5M7 13l5 5 5-5"/>',
  minus: '<path d="M5 12h14"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  spinner: '<path d="M12 4a8 8 0 1 1-7.4 5"/>',
  update: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 13h6M9 17h6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
function icon(name, size = 20, sw = 1.8) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/* ---------- Pixel avatars (derived from the account id) ---------- */
const PIXEL_PATTERNS = [
  ["..X..X..", ".XX..XX.", ".XXXXXX.", "XXoXXoXX", "XXXXXXXX", ".XXooXX.", "..XXXX..", "..X..X.."],
  ["..XXXX..", ".XXXXXX.", "XoXXXXoX", "XXXooXXX", ".XXXXXX.", "XX.XX.XX", "X..XX..X", "..X..X.."],
  ["...XX...", "..XXXX..", ".XoXXoX.", "XXXXXXXX", "X.XXXX.X", "..XooX..", ".XX..XX.", "XX....XX"],
  ["X......X", ".XXXXXX.", "XXoXXoXX", "XXXXXXXX", "XX.oo.XX", ".XXXXXX.", ".X.XX.X.", "X......X"],
];
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function memberName(uid) {
  if (uid && user && uid === user.uid) return me().name;
  if (ARTIFACT) {
    BB.want([uid]);
    return BB.name(uid) || project()?.members?.[uid]?.name || "Someone";
  }
  return project()?.members?.[uid]?.name || "Former member";
}
// Name for a row that stored its author's name at write time (activity, chat).
const nameOf = (uid, stored) => (ARTIFACT ? memberName(uid) : stored || memberName(uid));
function avatar(uid, size = 36, name = memberName(uid)) {
  const h = hash(uid || "none");
  const hue = h % 360;
  const color = `hsl(${hue} 80% 65%)`;
  const accent = `hsl(${hue} 60% 22%)`;
  const pattern = PIXEL_PATTERNS[h % PIXEL_PATTERNS.length];
  let rects = "";
  pattern.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === "X") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
    if (c === "o") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${accent}"/>`;
  }));
  const inner = Math.round(size * 0.62);
  return `<span class="avatar" style="width:${size}px;height:${size}px;box-shadow:0 0 0 1.5px hsl(${hue} 80% 65% / .35)" title="${esc(name)}"><svg width="${inner}" height="${inner}" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects}</svg></span>`;
}

function collectionArt(seed) {
  const hue = hash(seed) % 360;
  return `<svg viewBox="0 0 92 92" width="92" height="92" aria-hidden="true"><rect width="92" height="92" fill="hsl(${hue} 30% 14%)"/><path d="M24 30a4 4 0 0 1 4-4h12l6 6h18a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4z" fill="hsl(${hue} 55% 30%)" stroke="hsl(${hue} 70% 70%)" stroke-width="3"/></svg>`;
}

/* ---------- Data layer (Firestore) ---------- */
const projectsCol = () => db.collection("projects");
const sub = (name) => projectsCol().doc(currentId).collection(name);
const updateProject = (data) => projectsCol().doc(currentId).update(data);
const FV = () => firebase.firestore.FieldValue;

function log(verb, target = "", where = "", detail = "") {
  if (!currentId) return;
  const m = me();
  sub("activity").add({ uid: m.uid, name: storedName(), verb, target, where, detail, at: Date.now() })
    .catch((e) => console.error("BLACKBOX: activity log failed", e));
}

function watchProjects() {
  unsubProjects.forEach((u) => u());
  const m = me();
  let gotFirst = false;
  unsubProjects = [
    // Everyone the Artifact is shared with works in the same workspace, so it lists every project.
    (ARTIFACT ? projectsCol() : projectsCol().where("memberIds", "array-contains", m.uid)).onSnapshot((snap) => {
      projects = {};
      snap.forEach((d) => { projects[d.id] = d.data(); });
      gotFirst = true;
      if (!projects[currentId]) selectProject(pickDefaultProject());
      else if (subscribedId !== currentId) selectProject(currentId);
      else render();
    }, (e) => { console.error("BLACKBOX: projects listener", e); toast(friendlyError(e), true); }),
  ];
  if (!ARTIFACT) {
    unsubProjects.push(projectsCol().where("invitedEmails", "array-contains", m.email).onSnapshot((snap) => {
      invites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (gotFirst) render();
    }, (e) => console.error("BLACKBOX: invites listener", e)));
  }
}

function pickDefaultProject() {
  const saved = storeGet("blackbox:project");
  if (saved && projects[saved]) return saved;
  const ids = Object.keys(projects).sort((a, b) => (projects[b].createdAt || 0) - (projects[a].createdAt || 0));
  return ids[0] || null;
}

function selectProject(id) {
  unsubCurrent.forEach((u) => u());
  unsubCurrent = [];
  tasks = []; activity = []; messages = [];
  taskFilter = { status: "all", owner: "all" };
  currentId = id;
  subscribedId = id;
  if (id) storeSet("blackbox:project", id);
  if (!id) return render();
  unsubCurrent = [
    listen(() => sub("tasks"), (snap) => {
      tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      render();
    }),
    listen(() => sub("activity").orderBy("at", "desc").limit(50), (snap) => {
      activity = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }),
    listen(() => sub("messages").orderBy("at").limitToLast(200), (snap) => {
      const atBottom = isChatAtBottom();
      messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
      if (atBottom) scrollChatDown();
    }),
  ];
  render();
}

// Listens to a query of the current project. Right after creating a project or accepting an
// invitation, the server may not have the membership yet and refuses once: retry a few times.
function listen(makeQuery, onData) {
  const id = currentId;
  let inner = null;
  let stopped = false;
  let tries = 0;
  const start = () => {
    inner = makeQuery().onSnapshot(onData, (e) => {
      if (stopped || currentId !== id) return;
      if (e.code === "permission-denied" && tries++ < 5) {
        setTimeout(() => { if (!stopped) start(); }, 500 * tries);
        return;
      }
      console.error("BLACKBOX: project listener", e);
      toast(friendlyError(e), true);
    });
  };
  start();
  return () => { stopped = true; inner?.(); };
}

async function createProject(name) {
  const m = me();
  const ref = await projectsCol().add({
    name,
    description: "",
    tags: [],
    platforms: [],
    ownerId: m.uid,
    memberIds: [m.uid],
    members: { [m.uid]: { name: storedName(), email: ARTIFACT ? "" : m.email } },
    invitedEmails: [],
    release: { name: "UPDATE 1", due: "", items: [] },
    collections: [],
    createdAt: Date.now(),
  });
  storeSet("blackbox:project", ref.id);
  location.hash = "#project";
  if (projects[ref.id]) selectProject(ref.id);
  else currentId = ref.id; // the projects listener selects it when the snapshot arrives
  return ref.id;
}

async function deleteProjectData(id) {
  const ref = projectsCol().doc(id);
  for (const name of ["tasks", "activity", "messages"]) {
    const snap = await ref.collection(name).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await ref.delete();
}

/* ---------- Shared fragments ---------- */
const priorityPill = (p) => `<span class="pill p-${esc(p)}">${icon(PRIORITY[p]?.icon || "minus", 16, 2)}${PRIORITY[p]?.label || esc(p)}</span>`;
const statusPill = (s) => `<span class="pill s-${esc(s)}">${icon(STATUS[s]?.icon || "circle", 16, 2)}${STATUS[s]?.label || esc(s)}</span>`;

function taskRow(t, key) {
  return `<tr data-task="${esc(t.id)}" class="${t.status === "done" ? "task-done" : ""}">
    <td><div class="task-cell">${icon(t.type === "bug" ? "bug" : "file", 22, 1.6)}<div class="task-text"><div class="task-title">${esc(t.title)}</div>${t.desc ? `<div class="task-desc">${esc(t.desc)}</div>` : ""}</div></div></td>
    <td>${priorityPill(t.priority)}</td>
    <td>${statusPill(t.status)}</td>
    <td>${t.owner ? `<div class="owner">${avatar(t.owner, 36)}${esc(memberName(t.owner))}</div>` : '<span class="muted">Unassigned</span>'}</td>
    <td class="menu-cell"><button class="icon-btn bare" data-menu="${esc(t.id)}" data-list="${key}" aria-haspopup="menu" aria-expanded="false" title="Actions">${icon("dots", 20)}</button></td>
  </tr>`;
}
function taskTable(list, key, emptyText) {
  lists[key] = list.map((t) => t.id);
  if (!list.length) return `<div class="empty">${emptyText}</div>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Owner</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${list.map((t) => taskRow(t, key)).join("")}</tbody></table></div>`;
}

const metaLine = (p) => [`<span class="proj">${esc(p.name)}</span>`, ...[...(p.platforms || []), ...(p.tags || [])].map(esc)].join(" · ");

function header(title, crumb) {
  const p = project();
  return `<div class="crumbs">Workspace <span>/</span> <b>${esc(crumb || p.name)}</b></div>
    <div class="head">
      <div class="head-text">
        <h1>${esc(title)}</h1>
        <div class="meta">${metaLine(p)}</div>
        ${p.description ? `<p class="lede">${esc(p.description)}</p>` : '<p class="lede muted">No description yet. <a class="link" href="#project">Add one</a></p>'}
      </div>
      <div class="actions">
        <a class="avatar-stack" href="#team" title="Team">${p.memberIds.map((id) => avatar(id, 40)).join("")}</a>
        <a class="icon-btn round" href="#team" title="Invite people">${icon("plus", 18)}</a>
        <button class="btn primary" data-action="new-task">${icon("plus", 20, 2.2)}New task</button>
      </div>
    </div>`;
}

function activityFeed(items) {
  if (!items.length) return '<div class="empty">Nothing has happened yet. Create a task to get started.</div>';
  const kind = (v) => (v.startsWith("completed") ? ["circleCheck", "done"] : v.startsWith("reported") ? ["bug", "bug"] : ["update", "update"]);
  return `<ul class="feed">${items.map((a) => {
    const [ic, k] = kind(a.verb || "");
    return `<li>
      ${avatar(a.uid, 38, nameOf(a.uid, a.name))}
      <span class="kind kind-${k}">${icon(ic, 18)}</span>
      <div class="feed-text"><div class="txt"><b>${esc(nameOf(a.uid, a.name))}</b> ${esc(a.verb)}${a.target ? ` <b>${esc(a.target)}</b>` : ""}</div>
      ${a.detail ? `<div class="sub detail">${esc(a.detail)}</div>` : ""}
      <div class="sub">${a.where ? `in ${esc(a.where)} · ` : ""}${timeAgo(a.at)}</div></div></li>`;
  }).join("")}</ul>`;
}

/* ---------- Views ---------- */
function viewOverview() {
  const p = project();
  const count = (fn) => tasks.filter(fn).length;
  const stats = [
    { label: "To do", value: count((t) => t.type === "task" && t.status === "todo"), unit: "tasks", icon: "file", cls: "b-gray", href: "#tasks" },
    { label: "In progress", value: count((t) => t.type === "task" && (t.status === "progress" || t.status === "review")), unit: "tasks", icon: "refresh", cls: "b-purple", href: "#tasks" },
    { label: "Open bugs", value: count((t) => t.type === "bug" && t.status !== "done"), unit: "issues", icon: "bug", cls: "b-red", href: "#bugs" },
    { label: "Completed", value: count((t) => t.status === "done"), unit: "tasks", icon: "checkBig", cls: "b-green", href: "#tasks" },
  ];
  const priority = tasks.filter((t) => t.type === "task" && t.status !== "done").slice(0, 5);
  const colls = p.collections || [];

  return `${header("Project overview")}
    <section class="stats">${stats.map((s) => `<a class="stat" href="${s.href}">
      <div class="badge ${s.cls}">${icon(s.icon, 28, 1.7)}</div>
      <div><div class="label">${s.label}</div><div class="value">${s.value}<span class="unit">${s.unit}</span></div></div></a>`).join("")}
    </section>
    <div class="grid">
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Priority tasks</h2><a class="link" href="#tasks">View all tasks ${icon("arrow", 16)}</a></div>
          ${taskTable(priority, "priority", 'No open tasks. <button class="link" data-action="new-task">Create a task</button>')}
        </section>
        <section class="card">
          <div class="card-head"><h2>Project collections</h2><button class="link" data-action="new-collection">New collection ${icon("plus", 16)}</button></div>
          <div class="card-body">${colls.length ? `<div class="collections">${colls.map((c) => `
            <a class="coll" href="#collection.${esc(c.id)}"><div class="art">${collectionArt(c.id)}</div>
              <div class="coll-text"><div class="name">${esc(c.name)}</div>${c.desc ? `<div class="desc">${esc(c.desc)}</div>` : ""}<div class="n">${c.items.length} item${c.items.length === 1 ? "" : "s"}</div></div></a>`).join("")}
          </div>` : '<div class="empty">Group assets like characters, maps or icons into collections.</div>'}</div>
        </section>
      </div>
      <div class="col">
        ${releaseCard()}
        <section class="card">
          <div class="card-head"><h2>Recent activity</h2><a class="link" href="#activity">View all ${icon("arrow", 16)}</a></div>
          <div class="card-body">${activityFeed(activity.slice(0, 3))}</div>
        </section>
      </div>
    </div>`;
}

function releaseCard(full = false) {
  const r = project().release || { name: "UPDATE 1", due: "", items: [] };
  const done = r.items.filter((i) => i.done).length;
  const pct = r.items.length ? Math.round((done / r.items.length) * 100) : 0;
  return `<section class="card">
    <div class="card-head"><h2>Next release</h2><button class="icon-btn bare" data-action="edit-release" title="Edit release">${icon("edit", 18)}</button></div>
    <div class="card-body">
      <div class="release-top"><span class="release-name">${esc(r.name)}</span>${r.due ? `<span class="due">${icon("calendar", 18)}Due ${esc(r.due)}</span>` : ""}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="progress-row"><span>${done} of ${r.items.length} items complete</span><span>${pct}%</span></div>
      ${r.items.length ? `<ul class="checklist">${r.items.map((it, i) => `<li><label><input type="checkbox" data-release-item="${i}" ${it.done ? "checked" : ""}>${esc(it.label)}</label>${full ? `<button class="icon-btn bare" data-remove-release="${i}" title="Remove">${icon("x", 16)}</button>` : ""}</li>`).join("")}</ul>` : '<p class="muted">No items yet.</p>'}
      ${full ? '<form class="add-item" data-form="release-item"><input class="input" id="release-new" name="label" placeholder="Add a release item…" required maxlength="80"><button class="btn">Add</button></form>' : `<a class="link" href="#release">View release details ${icon("arrow", 16)}</a>`}
    </div></section>`;
}

function viewTaskList(type) {
  const p = project();
  let list = tasks.filter((t) => t.type === type);
  if (taskFilter.status !== "all") list = list.filter((t) => t.status === taskFilter.status);
  if (taskFilter.owner !== "all") list = list.filter((t) => t.owner === taskFilter.owner);
  const chip = (key, val, label) => `<button class="chip ${taskFilter[key] === val ? "on" : ""}" data-filter="${key}:${esc(val)}">${esc(label)}</button>`;
  const empty = type === "bug" ? "No bugs here." : "No tasks match these filters.";
  return `${header(type === "bug" ? "Bugs" : "Tasks", type === "bug" ? "Bugs" : "Tasks")}
    <section class="card spaced">
      <div class="card-head wrap">
        <div class="filters">${chip("status", "all", "All")}${Object.entries(STATUS).map(([k, v]) => chip("status", k, v.label)).join("")}</div>
        <div class="filters">${chip("owner", "all", "Everyone")}${p.memberIds.map((id) => chip("owner", id, memberName(id))).join("")}</div>
      </div>
      ${taskTable(list, type, `${empty} <button class="link" data-action="new-task">${type === "bug" ? "Report a bug" : "Create a task"}</button>`)}
    </section>`;
}

function viewActivity() {
  return `${header("Activity", "Activity")}
    <section class="card spaced narrow"><div class="card-head"><h2>All activity</h2></div><div class="card-body">${activityFeed(activity)}</div></section>`;
}

function viewChat() {
  const myUid = user.uid;
  return `${header("Chat", "Chat")}
    <section class="card spaced chat-card">
      <div class="chat" id="chat-log">${messages.map((m) => `<div class="msg ${m.uid === myUid ? "mine" : ""}">${avatar(m.uid, 34, nameOf(m.uid, m.name))}<div class="bubble"><div class="from">${esc(nameOf(m.uid, m.name))} · ${timeAgo(m.at)}${m.uid === myUid ? ` <button class="icon-btn bare tiny" data-delete-msg="${esc(m.id)}" title="Delete message">${icon("trash", 13)}</button>` : ""}</div><div class="msg-text">${esc(m.text)}</div></div></div>`).join("") || '<div class="empty">No messages yet. Say hi to your team.</div>'}</div>
      <form class="add-item chat-input" data-form="chat"><input class="input" id="chat-text" name="text" placeholder="Message the team…" required maxlength="1000" autocomplete="off"><button class="btn primary">${icon("send", 16)}Send</button></form>
    </section>`;
}
function isChatAtBottom() {
  const el = $("#chat-log");
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
function scrollChatDown() {
  const el = $("#chat-log");
  if (el) el.scrollTop = el.scrollHeight;
}

function viewRelease() {
  return `${header("Release", "Release")}<div class="spaced narrow">${releaseCard(true)}</div>`;
}

function viewCollection(id) {
  const c = (project().collections || []).find((x) => x.id === id);
  if (!c) return viewOverview();
  return `${header(c.name, c.name)}
    <section class="card spaced narrow">
      <div class="card-head"><h2>${c.items.length} item${c.items.length === 1 ? "" : "s"}</h2>
        <div class="row-gap"><button class="icon-btn bare" data-action="edit-collection" data-collection="${esc(c.id)}" title="Edit collection">${icon("edit", 18)}</button><button class="icon-btn bare danger-text" data-action="delete-collection" data-collection="${esc(c.id)}" title="Delete collection">${icon("trash", 18)}</button></div></div>
      <div class="card-body">
        ${c.desc ? `<p class="muted">${esc(c.desc)}</p>` : ""}
        <form class="add-item" data-form="collection-item" data-collection="${esc(c.id)}"><input class="input" id="collection-new" name="label" placeholder="Add an item…" required maxlength="80"><button class="btn">Add</button></form>
        <ul class="item-list">${c.items.map((it, i) => `<li>${esc(it)}<button class="icon-btn bare" data-remove-item="${i}" data-collection="${esc(c.id)}" title="Remove">${icon("trash", 16)}</button></li>`).join("")}</ul>
      </div>
    </section>`;
}

function viewTeam() {
  const p = project();
  const isOwner = p.ownerId === user.uid;
  return `${header("Team", "Team")}
    <div class="grid spaced">
      <section class="card">
        <div class="card-head"><h2>Members</h2><span class="muted">${p.memberIds.length}</span></div>
        <ul class="people">${p.memberIds.map((id) => `<li>${avatar(id, 40)}
          <div class="who"><div class="name">${esc(memberName(id))}${id === user.uid ? ' <span class="muted">(you)</span>' : ""}</div><div class="sub">${esc(ARTIFACT ? BB.email(id) : p.members?.[id]?.email || "")}</div></div>
          <span class="role-tag ${id === p.ownerId ? "owner" : ""}">${id === p.ownerId ? "Owner" : "Member"}</span>
          ${isOwner && id !== user.uid ? `<button class="icon-btn bare danger-text" data-remove-member="${esc(id)}" title="Remove from project">${icon("x", 18)}</button>` : ""}
        </li>`).join("")}</ul>
      </section>
      <section class="card">
        <div class="card-head"><h2>Invite people</h2></div>
        <div class="card-body">${ARTIFACT ? `
          <p>Open the <b>Share</b> menu of this page and invite them by email as <b>Editor</b>. They open the link with their Claude account and press <b>Join</b>.</p>
          <p class="muted">People with view-only access can read everything but can't make changes.</p>` : `
          <p class="muted">They sign in to BLACKBOX with this email and accept the invitation.</p>
          <form class="add-item" data-form="invite"><input class="input" id="invite-email" name="email" type="email" placeholder="name@example.com" required autocomplete="off"><button class="btn primary">${icon("mail", 16)}Invite</button></form>
          ${(p.invitedEmails || []).length ? `<div class="side-label">Pending invitations</div><ul class="item-list">${p.invitedEmails.map((e) => `<li>${esc(e)}<button class="icon-btn bare" data-cancel-invite="${esc(e)}" title="Cancel invitation">${icon("x", 16)}</button></li>`).join("")}</ul>` : ""}`}
        </div>
      </section>
    </div>`;
}

function viewProjectSettings() {
  const p = project();
  const isOwner = p.ownerId === user.uid;
  return `${header("Project settings", "Settings")}
    <section class="card spaced narrow">
      <form class="card-body settings" data-form="project">
        <label>Project name<input class="input" id="set-name" name="name" required maxlength="40" value="${esc(p.name)}"></label>
        <label>Description<input class="input" id="set-desc" name="description" maxlength="160" value="${esc(p.description)}" placeholder="What is the game about?"></label>
        <label>Platforms <span class="hint">separated by commas</span><input class="input" id="set-platforms" name="platforms" maxlength="200" value="${esc((p.platforms || []).join(", "))}" placeholder="Roblox, PC, Mobile"></label>
        <label>Tags <span class="hint">separated by commas</span><input class="input" id="set-tags" name="tags" maxlength="200" value="${esc((p.tags || []).join(", "))}" placeholder="RNG, Collection"></label>
        <div><button class="btn primary">Save changes</button></div>
      </form>
    </section>
    <section class="card spaced narrow">
      <div class="card-head"><h2>${isOwner ? "Delete project" : "Leave project"}</h2></div>
      <div class="card-body">
        <p class="muted">${isOwner ? "Deletes the project with all its tasks, bugs, activity and messages for everyone. This can't be undone." : "You lose access until someone invites you again."}</p>
        <button class="btn danger" data-action="${isOwner ? "delete-project" : "leave-project"}" ${deletingId === currentId ? "disabled" : ""}>${deletingId === currentId ? "Deleting…" : isOwner ? "Delete project" : "Leave project"}</button>
      </div>
    </section>`;
}

function viewWelcome() {
  return `<div class="welcome">
    <h1>Welcome${user.displayName ? `, ${esc(user.displayName)}` : ""}</h1>
    <p class="lede">Create a project for your game, then invite your team by email.${invites.length ? " Or accept an invitation above." : ""}</p>
    <button class="btn primary" data-action="new-project">${icon("plus", 20, 2.2)}Create a project</button>
  </div>`;
}

/* ---------- Render ---------- */
function route() {
  const h = location.hash.slice(1) || "overview";
  const [name, arg] = h.split(".");
  return { name, arg };
}

function renderInvites() {
  if (ARTIFACT) {
    const p = project();
    $("#invites").innerHTML = BB.canWrite === false
      ? `<div class="invite">${icon("mail", 20)}<span>You can view this workspace. Ask the owner to share it with you as <b>Editor</b> to make changes.</span></div>`
      : p && !p.memberIds.includes(user.uid)
        ? `<div class="invite">${icon("user", 20)}<span>You're viewing <b>${esc(p.name)}</b>. Join to appear in its team and get tasks assigned.</span><span class="spacer"></span><button class="btn primary" data-join="${esc(currentId)}">Join project</button></div>`
        : "";
    return;
  }
  $("#invites").innerHTML = invites.map((p) => `<div class="invite">
    ${icon("mail", 20)}<span><b>${esc(p.members?.[p.ownerId]?.name || "Someone")}</b> invited you to <b>${esc(p.name)}</b></span>
    <span class="spacer"></span>
    <button class="btn ghost" data-decline="${esc(p.id)}">Decline</button>
    <button class="btn primary" data-accept="${esc(p.id)}">Accept</button>
  </div>`).join("");
}

function renderSidebar() {
  const p = project();
  const r = route();
  const ids = Object.keys(projects).sort((a, b) => projects[a].name.localeCompare(projects[b].name));
  $("#project-select").innerHTML = ids.map((id) => `<option value="${esc(id)}" ${id === currentId ? "selected" : ""}>${esc(projects[id].name)}</option>`).join("");
  for (const id of ["project-picker", "side-nav", "side-collections-section", "side-team-section"]) $(`#${id}`).hidden = !p;
  const m = me();
  $("#side-user").innerHTML = `${avatar(m.uid, 42, m.name)}<div class="who"><div class="name">${esc(m.name)}</div><div class="role">${esc(m.email)}</div></div>
    ${ARTIFACT ? "" : `<button class="icon-btn bare" data-action="account" title="Edit profile">${icon("user", 19)}</button>
    <button class="icon-btn bare" data-action="sign-out" title="Sign out">${icon("logout", 19)}</button>`}`;
  if (!p) return;
  document.querySelectorAll("#side-nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === r.name));
  $("#bugs-count").textContent = tasks.filter((t) => t.type === "bug" && t.status !== "done").length;
  $("#chat-count").textContent = messages.length;
  $("#side-collections").innerHTML = (p.collections || []).map((c) => `<li><a href="#collection.${esc(c.id)}" class="${r.name === "collection" && r.arg === c.id ? "active" : ""}">${icon("folder", 22, 1.6)}<span class="grow">${esc(c.name)}</span><span class="count">${c.items.length}</span></a></li>`).join("")
    || '<li class="muted small-pad">No collections yet</li>';
  $("#team-count").textContent = p.memberIds.length;
  $("#side-team").innerHTML = p.memberIds.map((id) => avatar(id, 42)).join("") + `<a class="icon-btn round" href="#team" title="Invite people">${icon("plus", 18)}</a>`;
}

function render() {
  if (!user) return;
  const openMenuFor = menu.hidden ? null : { ...menuTarget, focus: document.activeElement?.dataset?.mi };
  menu.hidden = true;
  // Keep what the user is typing when a live update re-renders the view.
  const focused = document.activeElement;
  const keep = focused && focused.id && $("#view").contains(focused)
    ? { id: focused.id, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const chatScroll = $("#chat-log")?.scrollTop;

  renderInvites();
  const r = route();
  const views = {
    overview: viewOverview,
    tasks: () => viewTaskList("task"),
    bugs: () => viewTaskList("bug"),
    activity: viewActivity,
    chat: viewChat,
    release: viewRelease,
    team: viewTeam,
    project: viewProjectSettings,
    collection: () => viewCollection(r.arg),
  };
  lists = {};
  $("#view").innerHTML = project() ? (views[r.name] || viewOverview)() : viewWelcome();
  renderSidebar();
  document.title = project() ? `${project().name} · BLACKBOX` : "BLACKBOX";

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      if (keep.value !== undefined) el.value = keep.value;
      el.focus();
      try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text input */ }
    }
  }
  if (chatScroll !== undefined && $("#chat-log")) $("#chat-log").scrollTop = chatScroll;
  // A live update re-rendered the view while the task menu was open: keep it open on the same row.
  if (openMenuFor) {
    const btn = document.querySelector(`[data-menu="${CSS.escape(openMenuFor.task)}"][data-list="${CSS.escape(openMenuFor.list)}"]`);
    if (btn) openMenu(btn, openMenuFor.focus);
    else menuBtn = null;
  }
}

/* ---------- Task menu (Edit / Up / Down / Delete) ---------- */
const menu = $("#task-menu");
let menuBtn = null;
let menuTarget = { task: null, list: null }; // kept out of the DOM so clicks in the menu never look like row clicks
function openMenu(btn, focusItem) {
  closeMenu();
  const id = btn.dataset.menu;
  const ids = lists[btn.dataset.list] || [];
  const i = ids.indexOf(id);
  menu.innerHTML = `
    <button role="menuitem" data-mi="edit">${icon("edit", 16)}Edit</button>
    <button role="menuitem" data-mi="up" ${i <= 0 ? "disabled" : ""}>${icon("arrowUp", 16)}Up</button>
    <button role="menuitem" data-mi="down" ${i < 0 || i >= ids.length - 1 ? "disabled" : ""}>${icon("arrowDown", 16)}Down</button>
    <hr>
    <button role="menuitem" data-mi="delete" class="danger-text">${icon("trash", 16)}Delete</button>`;
  menuTarget = { task: id, list: btn.dataset.list };
  menu.hidden = false;
  menuBtn = btn;
  btn.setAttribute("aria-expanded", "true");
  const r = btn.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const mw = menu.offsetWidth;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
  (menu.querySelector(`[data-mi="${focusItem}"]:not([disabled])`) || menu.querySelector("button:not([disabled])")).focus();
}
function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  menuBtn = null;
}

async function moveTask(id, dir, key) {
  const ids = lists[key] || [];
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  const a = tasks.find((t) => t.id === id);
  const b = tasks.find((t) => t.id === ids[j]);
  let newA = b.order ?? 0;
  const newB = a.order ?? 0;
  if (newA === newB) newA = newB + dir * 0.5;
  const batch = db.batch();
  batch.update(sub("tasks").doc(a.id), { order: newA });
  batch.update(sub("tasks").doc(b.id), { order: newB });
  await act(() => batch.commit());
}

async function deleteTask(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const ok = await ask({ title: `Delete "${t.title}"?`, text: "This removes it for the whole team.", ok: "Delete", danger: true });
  if (!ok) return;
  if (await act(() => sub("tasks").doc(id).delete(), "Deleted")) log("deleted", t.title, t.type === "bug" ? "Bugs" : "Tasks");
}

menu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-mi]");
  if (!b || b.disabled) return;
  const { task, list } = menuTarget;
  closeMenu();
  if (b.dataset.mi === "edit") openTask(task);
  if (b.dataset.mi === "up") moveTask(task, -1, list);
  if (b.dataset.mi === "down") moveTask(task, 1, list);
  if (b.dataset.mi === "delete") deleteTask(task);
});
menu.addEventListener("keydown", (e) => {
  const items = [...menu.querySelectorAll("button:not([disabled])")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  if (e.key === "Escape") { const b = menuBtn; closeMenu(); b?.focus(); }
  if (e.key === "Tab") closeMenu();
});
window.addEventListener("resize", closeMenu);
document.addEventListener("scroll", (e) => { if (!menu.contains(e.target)) closeMenu(); }, true);

/* ---------- Task dialog ---------- */
const taskDialog = $("#task-dialog");
const taskForm = $("#task-form");
let editingId = null;

function openTask(id, defaults = {}) {
  const p = project();
  const t = id ? tasks.find((x) => x.id === id) : null;
  editingId = t ? t.id : null;
  $("#task-dialog-title").textContent = t ? "Edit task" : defaults.type === "bug" ? "Report a bug" : "New task";
  $("#task-owner").innerHTML = '<option value="">Unassigned</option>' + p.memberIds.map((m) => `<option value="${esc(m)}">${esc(memberName(m))}</option>`).join("");
  const v = t || { title: "", desc: "", type: "task", priority: "medium", status: "todo", owner: user.uid, ...defaults };
  for (const k of ["title", "desc", "type", "priority", "status", "owner"]) taskForm.elements[k].value = v[k] || "";
  taskDialog.showModal();
  taskForm.elements.title.focus();
}

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(taskForm));
  data.title = data.title.trim();
  data.desc = data.desc.trim();
  if (!data.title) return;
  taskDialog.close();
  const where = data.type === "bug" ? "Bugs" : "Tasks";
  if (editingId) {
    const wasDone = tasks.find((x) => x.id === editingId)?.status === "done";
    if (await act(() => sub("tasks").doc(editingId).update({ ...data, updatedAt: Date.now() }))) {
      log(!wasDone && data.status === "done" ? "completed" : "updated", data.title, where);
    }
  } else {
    const order = Math.max(0, ...tasks.map((t) => t.order ?? 0)) + 1;
    if (await act(() => sub("tasks").add({ ...data, order, createdBy: user.uid, createdAt: Date.now() }))) {
      if (data.type === "bug") log("reported a new bug", "", "Bugs", data.title);
      else log("created", data.title, "Tasks");
    }
  }
});
$("#cancel-task-btn").addEventListener("click", () => taskDialog.close());

/* ---------- Project actions ---------- */
function updateCollections(fn) {
  const colls = structuredClone(project().collections || []);
  fn(colls);
  return act(() => updateProject({ collections: colls }));
}
function updateRelease(fn) {
  const r = structuredClone(project().release || { name: "UPDATE 1", due: "", items: [] });
  fn(r);
  return act(() => updateProject({ release: r }));
}

const actions = {
  "new-task": () => openTask(null, { type: route().name === "bugs" ? "bug" : "task" }),
  "new-project": async () => {
    const [name] = (await ask({ title: "New project", fields: [{ label: "Project name", max: 40 }], ok: "Create" })) || [];
    if (name) await act(() => createProject(name), "Project created");
  },
  "new-collection": async () => {
    const res = await ask({ title: "New collection", fields: [{ label: "Name", max: 40 }, { label: "Description", optional: true, max: 120 }], ok: "Create" });
    if (!res || !res[0]) return;
    const colls = project().collections || [];
    let id = slug(res[0]);
    while (colls.some((c) => c.id === id)) id += "-2";
    if (await updateCollections((cs) => cs.push({ id, name: res[0], desc: res[1] || "", items: [] }))) {
      log("created collection", res[0]);
      location.hash = `#collection.${id}`;
      render();
    }
  },
  "edit-collection": async (el) => {
    const c = project().collections.find((x) => x.id === el.dataset.collection);
    const res = await ask({ title: "Edit collection", fields: [{ label: "Name", value: c.name, max: 40 }, { label: "Description", value: c.desc, optional: true, max: 120 }], ok: "Save" });
    if (res && res[0]) await updateCollections((cs) => Object.assign(cs.find((x) => x.id === c.id), { name: res[0], desc: res[1] }));
  },
  "delete-collection": async (el) => {
    const c = project().collections.find((x) => x.id === el.dataset.collection);
    if (!(await ask({ title: `Delete "${c.name}"?`, text: "Its item list is removed for everyone.", ok: "Delete", danger: true }))) return;
    if (await updateCollections((cs) => cs.splice(cs.findIndex((x) => x.id === c.id), 1))) {
      log("deleted collection", c.name);
      location.hash = "#overview";
    }
  },
  "edit-release": async () => {
    const r = project().release || {};
    const res = await ask({ title: "Edit release", fields: [{ label: "Release name", value: r.name, max: 40 }, { label: "Due date", value: r.due, optional: true, max: 30 }], ok: "Save" });
    if (res && res[0]) await updateRelease((x) => { x.name = res[0]; x.due = res[1]; });
  },
  "delete-project": async () => {
    const p = project();
    const res = await ask({ title: `Delete ${p.name}?`, text: "Type the project name to confirm. This deletes everything in it for the whole team.", fields: [{ label: "Project name" }], ok: "Delete project", danger: true });
    if (!res) return;
    if (res[0] !== p.name) return toast("The name doesn't match, so nothing was deleted.", true);
    // Stay on the project until everything is gone, so nobody leaves while the deletion is half done.
    deletingId = currentId;
    render();
    const ok = await act(() => deleteProjectData(deletingId), "Project deleted");
    deletingId = null;
    if (ok) location.hash = "#overview";
    render();
  },
  "leave-project": async () => {
    const p = project();
    if (!(await ask({ title: `Leave ${p.name}?`, ok: "Leave", danger: true }))) return;
    const id = currentId;
    await act(() => sub("activity").add({ uid: user.uid, name: storedName(), verb: "left the project", target: "", where: "Team", detail: "", at: Date.now() }));
    await act(() => projectsCol().doc(id).update({
      memberIds: FV().arrayRemove(user.uid),
      [`members.${user.uid}`]: FV().delete(),
    }), "You left the project");
  },
  account: async () => {
    const m = me();
    const res = await ask({ title: "Your profile", text: `Signed in as ${m.email}.`, fields: [{ label: "Display name", value: m.name, max: 40 }], ok: "Save" });
    if (!res || !res[0] || res[0] === m.name) return;
    await act(async () => {
      await user.updateProfile({ displayName: res[0] });
      await Promise.all(Object.keys(projects).map((id) => projectsCol().doc(id).update({ [`members.${user.uid}.name`]: res[0] })));
    }, "Name updated");
    render();
  },
  "sign-out": () => auth.signOut(),
};

document.addEventListener("click", async (e) => {
  if (!menu.hidden && !e.target.closest("#task-menu") && !e.target.closest("[data-menu]")) closeMenu();
  const el = e.target.closest("[data-action],[data-menu],[data-task],[data-filter],[data-remove-item],[data-remove-release],[data-remove-member],[data-cancel-invite],[data-accept],[data-decline],[data-delete-msg],[data-join]");
  if (!el || !user) return;
  const d = el.dataset;

  if (d.menu) return menuBtn === el ? closeMenu() : openMenu(el);
  if (d.action) return actions[d.action]?.(el);
  if (d.task) return openTask(d.task);
  if (d.filter) {
    const [k, v] = d.filter.split(":");
    taskFilter[k] = v;
    return render();
  }
  if (d.removeItem !== undefined) return updateCollections((cs) => cs.find((x) => x.id === d.collection).items.splice(+d.removeItem, 1));
  if (d.removeRelease !== undefined) return updateRelease((r) => r.items.splice(+d.removeRelease, 1));
  if (d.deleteMsg) return act(() => sub("messages").doc(d.deleteMsg).delete());
  if (d.cancelInvite) return act(() => updateProject({ invitedEmails: FV().arrayRemove(d.cancelInvite) }), "Invitation cancelled");
  if (d.removeMember) {
    const name = memberName(d.removeMember);
    if (!(await ask({ title: `Remove ${name}?`, text: "They lose access to this project.", ok: "Remove", danger: true }))) return;
    if (await act(() => updateProject({
      memberIds: FV().arrayRemove(d.removeMember),
      [`members.${d.removeMember}`]: FV().delete(),
    }), `${name} removed`)) log("removed", name, "Team");
    return;
  }
  if (d.accept) {
    const m = me();
    const id = d.accept;
    const ok = await act(() => projectsCol().doc(id).update({
      memberIds: FV().arrayUnion(m.uid),
      [`members.${m.uid}`]: { name: m.name, email: m.email },
      invitedEmails: FV().arrayRemove(m.email),
    }), "Welcome to the team");
    if (ok) {
      storeSet("blackbox:project", id);
      location.hash = "#overview";
      if (projects[id]) selectProject(id);
      else currentId = id; // selected by the projects listener
      await act(() => projectsCol().doc(id).collection("activity").add({ uid: m.uid, name: m.name, verb: "joined the project", target: "", where: "Team", detail: "", at: Date.now() }));
    }
    return;
  }
  if (d.join) {
    const id = d.join;
    const ok = await act(() => projectsCol().doc(id).update({
      memberIds: FV().arrayUnion(user.uid),
      [`members.${user.uid}`]: { name: storedName(), email: "" },
    }), "You joined the project");
    if (ok) log("joined the project", "", "Team");
    return;
  }
  if (d.decline) return act(() => projectsCol().doc(d.decline).update({ invitedEmails: FV().arrayRemove(me().email) }), "Invitation declined");
});

document.addEventListener("change", (e) => {
  const i = e.target.dataset.releaseItem;
  if (i === undefined || !user) return;
  const checked = e.target.checked;
  const label = project().release.items[+i]?.label;
  updateRelease((r) => { r.items[+i].done = checked; }).then((ok) => { if (ok && checked) log("completed", label, project()?.release?.name); });
});

document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (!f.dataset.form || !user) return;
  e.preventDefault();
  const val = (name) => (f.elements[name]?.value || "").trim();
  const type = f.dataset.form;

  if (type === "chat") {
    const text = val("text");
    if (!text) return;
    f.reset();
    const m = me();
    await act(() => sub("messages").add({ uid: m.uid, name: storedName(), text, at: Date.now() }));
    scrollChatDown();
  }
  if (type === "release-item") {
    const label = val("label");
    if (!label) return;
    f.reset();
    await updateRelease((r) => r.items.push({ label, done: false }));
  }
  if (type === "collection-item") {
    const label = val("label");
    if (!label) return;
    f.reset();
    const c = project().collections.find((x) => x.id === f.dataset.collection);
    if (await updateCollections((cs) => cs.find((x) => x.id === c.id).items.push(label))) log("added", label, c.name);
  }
  if (type === "invite") {
    const email = val("email").toLowerCase();
    const p = project();
    if (!EMAIL_RE.test(email)) return toast("Enter a valid email address.", true);
    if (Object.values(p.members || {}).some((m) => m.email === email)) return toast("This person is already in the team.", true);
    if ((p.invitedEmails || []).includes(email)) return toast("This email is already invited.", true);
    f.reset();
    if (await act(() => updateProject({ invitedEmails: FV().arrayUnion(email) }), `Invitation sent to ${email}`)) log("invited", email, "Team");
  }
  if (type === "project") {
    const name = val("name");
    if (!name) return toast("The project needs a name.", true);
    const ok = await act(() => updateProject({
      name,
      description: val("description"),
      platforms: splitList(val("platforms")),
      tags: splitList(val("tags")),
    }), "Project saved");
    if (ok) log("updated the project settings");
  }
});

$("#project-select").addEventListener("change", (e) => {
  selectProject(e.target.value);
  location.hash = "#overview";
});

$("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
let lastView = route().name;
window.addEventListener("hashchange", () => {
  $("#sidebar").classList.remove("open");
  if (route().name !== lastView) taskFilter = { status: "all", owner: "all" };
  lastView = route().name;
  render();
  if (route().name === "chat") scrollChatDown();
});

/* ---------- Auth screens ---------- */
function showScreen(id) {
  for (const s of ["boot-screen", "setup-screen", "auth-screen", "verify-screen", "app"]) $(`#${s}`).hidden = s !== id;
}

let authMode = "signin";
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("[data-auth-mode]").forEach((b) => b.classList.toggle("on", b.dataset.authMode === mode));
  $("#auth-name-row").hidden = mode !== "signup";
  $("#auth-submit").textContent = mode === "signup" ? "Create account" : "Sign in";
  $("#auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("#forgot-btn").hidden = mode === "signup";
  $("#auth-error").hidden = true;
}
function authError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = !msg;
}

document.querySelectorAll("[data-auth-mode]").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.authMode)));

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const name = $("#auth-name").value.trim();
  if (!EMAIL_RE.test(email)) return authError("#auth-error", "Enter a valid email address.");
  if (authMode === "signup" && !name) return authError("#auth-error", "Choose a display name.");
  const btn = $("#auth-submit");
  btn.disabled = true;
  try {
    if (authMode === "signup") {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: name });
      await cred.user.sendEmailVerification();
      onAuth(cred.user);
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
    authError("#auth-error", "");
  } catch (err) {
    console.error("BLACKBOX: auth", err);
    authError("#auth-error", friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

$("#forgot-btn").addEventListener("click", async () => {
  const email = $("#auth-email").value.trim();
  if (!EMAIL_RE.test(email)) return authError("#auth-error", "Type your email above first, then press Forgot password.");
  try {
    await auth.sendPasswordResetEmail(email);
    authError("#auth-error", "");
    toast(`Password reset email sent to ${email}`);
  } catch (err) {
    authError("#auth-error", friendlyError(err));
  }
});

$("#verify-continue").addEventListener("click", async () => {
  try {
    await auth.currentUser.reload();
    if (!auth.currentUser.emailVerified) return authError("#verify-error", "Your email isn't confirmed yet. Open the link in the email we sent, then try again.");
    await auth.currentUser.getIdToken(true); // refresh the token so the database sees the verified email
    authError("#verify-error", "");
    onAuth(auth.currentUser);
  } catch (err) {
    authError("#verify-error", friendlyError(err));
  }
});
$("#verify-resend").addEventListener("click", async () => {
  try {
    await auth.currentUser.sendEmailVerification();
    toast("Confirmation email sent again");
  } catch (err) {
    authError("#verify-error", friendlyError(err));
  }
});
$("#verify-signout").addEventListener("click", () => auth.signOut());

function onAuth(u) {
  unsubProjects.forEach((f) => f());
  unsubCurrent.forEach((f) => f());
  unsubProjects = []; unsubCurrent = [];
  projects = {}; invites = []; currentId = null; subscribedId = null; tasks = []; activity = []; messages = [];
  user = null;
  if (!u && ARTIFACT) {
    $("#setup-title").textContent = "Sign in to use BLACKBOX";
    $("#setup-text").textContent = "Open this page while signed in to Claude. If someone sent you the link, ask them to share the page with your email.";
    return showScreen("setup-screen");
  }
  if (!u) {
    setAuthMode("signin");
    return showScreen("auth-screen");
  }
  if (!u.emailVerified) {
    $("#verify-email").textContent = u.email;
    authError("#verify-error", "");
    return showScreen("verify-screen");
  }
  user = u;
  showScreen("app");
  $("#view").innerHTML = '<div class="empty">Loading your projects…</div>';
  renderSidebar();
  watchProjects();
}

/* ---------- Boot ---------- */
document.querySelectorAll("[data-icon]").forEach((el) => {
  if (!el.innerHTML) el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, el.dataset.icon === "home" ? 20 : 18));
});

if (!FB_CONFIG || typeof firebase === "undefined") {
  if (typeof firebase === "undefined") console.error("BLACKBOX: Firebase SDK failed to load.");
  showScreen("setup-screen");
} else {
  if (ARTIFACT) BB.onNames(render);
  firebase.initializeApp(FB_CONFIG);
  auth = firebase.auth();
  db = firebase.firestore();
  if (USE_EMULATOR) {
    auth.useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
    db.useEmulator("127.0.0.1", 8080);
  }
  auth.onAuthStateChanged(onAuth);
}
