"use strict";

const STORE_KEY = "blackbox:v1";

/* ---------- State ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("BLACKBOX: could not read saved data, using seed.", e);
  }
  return structuredClone(SEED);
}
let state = loadState();
const save = () => {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn("BLACKBOX: could not save data.", e); }
};
const project = () => state.projects[state.currentProject];

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
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
const PRIORITY_ORDER = ["critical", "high", "medium", "low"];

/* ---------- Icons (inline SVG, lucide-style) ---------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" fill="currentColor" stroke="none"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>',
  bug: '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M12 10v10M8 13H3M21 13h-5M5 7l3 2M19 7l-3 2M5 20l3-3M19 20l-3-3M9.5 6 8 3M14.5 6 16 3"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  file: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-1-.8-1.4-.8-2.3 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5M20 3v5.5h-5.5"/>',
  checkBig: '<path d="m5 12 5 5 9-10"/>',
  checkSmall: '<path d="m6 12 4 4 8-8"/>',
  circleCheck: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.5 12 3 3 6-6" stroke="#0e0e14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chevronsUp: '<path d="m7 11 5-5 5 5M7 18l5-5 5 5"/>',
  chevronsDown: '<path d="m7 6 5 5 5-5M7 13l5 5 5-5"/>',
  minus: '<path d="M5 12h14"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  spinner: '<path d="M12 4a8 8 0 1 1-7.4 5"/>',
  update: '<path d="M6 2h9l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 13h6M9 17h6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
};
function icon(name, size = 20, sw = 1.8) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

/* ---------- Pixel avatars ---------- */
const PIXEL_PATTERNS = [
  ["..X..X..", ".XX..XX.", ".XXXXXX.", "XXoXXoXX", "XXXXXXXX", ".XXooXX.", "..XXXX..", "..X..X.."],
  ["..XXXX..", ".XXXXXX.", "XoXXXXoX", "XXXooXXX", ".XXXXXX.", "XX.XX.XX", "X..XX..X", "..X..X.."],
  ["...XX...", "..XXXX..", ".XoXXoX.", "XXXXXXXX", "X.XXXX.X", "..XooX..", ".XX..XX.", "XX....XX"],
];
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function avatar(id, size = 36) {
  const m = state.members[id] || { name: "?", color: "#888", accent: "#333" };
  const keys = Object.keys(state.members);
  const pattern = PIXEL_PATTERNS[(keys.indexOf(id) >= 0 ? keys.indexOf(id) : hash(id)) % PIXEL_PATTERNS.length];
  let rects = "";
  pattern.forEach((row, y) => [...row].forEach((c, x) => {
    if (c === "X") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${m.color}"/>`;
    if (c === "o") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${m.accent}"/>`;
  }));
  const inner = Math.round(size * 0.62);
  return `<span class="avatar" style="width:${size}px;height:${size}px;box-shadow:0 0 0 1.5px ${m.color}55" title="${esc(m.name)}"><svg width="${inner}" height="${inner}" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects}</svg></span>`;
}

/* ---------- Collection art (procedural SVG placeholders) ---------- */
function collectionArt(kind) {
  const svgs = {
    characters: '<svg viewBox="0 0 92 92" width="92" height="92"><defs><linearGradient id="gc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b2a5c"/><stop offset="1" stop-color="#120d1f"/></linearGradient></defs><rect width="92" height="92" fill="url(#gc)"/><circle cx="46" cy="38" r="18" fill="#2a2235"/><path d="M26 34c2-16 38-18 40 0-6-6-12-4-20-8-6 6-14 4-20 8z" fill="#120d1f"/><rect x="38" y="36" width="5" height="4" fill="#a78bfa"/><rect x="50" y="36" width="5" height="4" fill="#a78bfa"/><path d="M22 92c2-20 46-20 48 0z" fill="#1d1729"/></svg>',
    maps: '<svg viewBox="0 0 92 92" width="92" height="92"><defs><linearGradient id="gm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e2a44"/><stop offset="1" stop-color="#0b0f1a"/></linearGradient></defs><rect width="92" height="92" fill="url(#gm)"/><rect x="4" y="22" width="22" height="60" fill="#151c2e"/><rect x="66" y="16" width="24" height="66" fill="#151c2e"/><rect x="9" y="30" width="5" height="6" fill="#f5c26b"/><rect x="72" y="26" width="5" height="6" fill="#f5c26b"/><rect x="80" y="42" width="5" height="6" fill="#f5c26b" opacity=".6"/><path d="M30 92 42 50h8l12 42z" fill="#1a2338"/><circle cx="46" cy="44" r="10" fill="#f5c26b" opacity=".15"/></svg>',
    ui: '<svg viewBox="0 0 92 92" width="92" height="92"><rect width="92" height="92" fill="#16141f"/><rect x="22" y="22" width="48" height="48" rx="10" fill="#7c5cf0"/><path d="M22 34 46 22l24 12-24 12z" fill="#a78bfa"/><circle cx="46" cy="34" r="3" fill="#fff"/><circle cx="34" cy="50" r="3" fill="#fff"/><circle cx="40" cy="60" r="3" fill="#fff"/><circle cx="56" cy="52" r="3" fill="#fff"/><circle cx="60" cy="60" r="3" fill="#fff"/></svg>',
  };
  if (svgs[kind]) return svgs[kind];
  const hue = hash(kind) % 360;
  return `<svg viewBox="0 0 92 92" width="92" height="92"><rect width="92" height="92" fill="hsl(${hue} 30% 14%)"/><g fill="none" stroke="hsl(${hue} 70% 70%)" stroke-width="3"><path d="M24 30a4 4 0 0 1 4-4h12l6 6h18a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4z"/></g></svg>`;
}

/* ---------- Shared fragments ---------- */
const priorityPill = (p) => `<span class="pill p-${p}">${icon(PRIORITY[p].icon, 16, 2)}${PRIORITY[p].label}</span>`;
const statusPill = (s) => `<span class="pill s-${s}">${icon(STATUS[s].icon, 16, 2)}${STATUS[s].label}</span>`;

function taskRow(t) {
  const owner = state.members[t.owner];
  return `<tr data-task="${t.id}" class="${t.status === "done" ? "task-done" : ""}">
    <td><div class="task-cell">${icon(t.type === "bug" ? "bug" : t.icon || "file", 22, 1.6)}<div><div class="task-title">${esc(t.title)}</div><div class="task-desc">${esc(t.desc)}</div></div></div></td>
    <td>${priorityPill(t.priority)}</td>
    <td>${statusPill(t.status)}</td>
    <td><div class="owner">${avatar(t.owner, 36)}${esc(owner ? owner.name : "—")}</div></td>
    <td><button class="icon-btn bare" data-edit="${t.id}" title="Edit">${icon("dots", 20)}</button></td>
  </tr>`;
}
function taskTable(tasks, emptyText = "Nothing here yet.") {
  if (!tasks.length) return `<div class="empty">${emptyText}</div>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Owner</th><th></th></tr></thead>
    <tbody>${tasks.map(taskRow).join("")}</tbody></table></div>`;
}

function header(title, crumb) {
  const p = project();
  return `<div class="crumbs">Workspace <span>/</span> <b>${esc(crumb || p.name)}</b></div>
    <div class="head">
      <div class="head-text">
        <h1>${esc(title)}</h1>
        <div class="meta"><span class="proj">${esc(p.name)}</span>${p.tags.map((t) => ` · ${esc(t)}`).join("")}</div>
        <p class="lede">${esc(p.description)}</p>
      </div>
      <div class="actions">
        <div class="avatar-stack">${p.team.map((id) => avatar(id, 40)).join("")}<button class="icon-btn round" data-action="add-member" title="Add member">${icon("plus", 18)}</button></div>
        <button class="btn primary" data-action="new-task">${icon("plus", 20, 2.2)}New task</button>
      </div>
    </div>`;
}

function activityFeed(items) {
  if (!items.length) return `<div class="empty">No activity yet.</div>`;
  const kindIcon = { done: "circleCheck", bug: "bug", update: "update" };
  return `<ul class="feed">${items.map((a) => `<li>
    ${avatar(a.who, 38)}
    <span class="kind kind-${a.kind}">${icon(kindIcon[a.kind] || "update", 18)}</span>
    <div><div class="txt"><b>${esc(state.members[a.who]?.name)}</b> ${a.text}</div>
    ${a.detail ? `<div class="sub" style="color:#c9c9d4">${esc(a.detail)}</div>` : ""}
    <div class="sub">in ${esc(a.where)} · ${timeAgo(a.at)}</div></div></li>`).join("")}</ul>`;
}

function log(kind, html, where, detail) {
  project().activity.unshift({ who: state.me, kind, text: html, where, detail, at: Date.now() });
  project().activity = project().activity.slice(0, 100);
}

/* ---------- Views ---------- */
function viewOverview() {
  const p = project();
  const tasks = p.tasks.filter((t) => t.type === "task");
  const count = (fn) => p.tasks.filter(fn).length;
  const stats = [
    { label: "To do", value: count((t) => t.type === "task" && t.status === "todo"), unit: "tasks", icon: "file", cls: "b-gray" },
    { label: "In progress", value: count((t) => t.type === "task" && (t.status === "progress" || t.status === "review")), unit: "tasks", icon: "refresh", cls: "b-purple" },
    { label: "Open bugs", value: count((t) => t.type === "bug" && t.status !== "done"), unit: "issues", icon: "bug", cls: "b-red" },
    { label: "Completed", value: count((t) => t.status === "done"), unit: "tasks", icon: "checkBig", cls: "b-green" },
  ];
  const priority = tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
    .slice(0, 5);

  return `${header("Project overview")}
    <section class="stats">${stats.map((s) => `<div class="stat">
      <div class="badge ${s.cls}">${icon(s.icon, 28, 1.7)}</div>
      <div><div class="label">${s.label}</div><div class="value">${s.value}<span class="unit">${s.unit}</span></div></div></div>`).join("")}
    </section>
    <div class="grid">
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Priority tasks</h2><a class="link" href="#tasks">View all tasks ${icon("arrow", 16)}</a></div>
          ${taskTable(priority, "All caught up — no open tasks.")}
        </section>
        <section class="card">
          <div class="card-head"><h2>Project collections</h2><a class="link" href="#collection/${esc(p.collections[0]?.id || "")}">View all ${icon("arrow", 16)}</a></div>
          <div class="card-body"><div class="collections">${p.collections.map((c) => `
            <a class="coll" href="#collection/${esc(c.id)}"><div class="art">${collectionArt(c.art)}</div>
              <div><div class="name">${esc(c.name)}</div><div class="desc">${esc(c.desc)}</div><div class="n">${c.items.length} item${c.items.length === 1 ? "" : "s"}</div></div></a>`).join("")}
          </div></div>
        </section>
      </div>
      <div class="col">
        ${releaseCard()}
        <section class="card">
          <div class="card-head"><h2>Recent activity</h2><a class="link" href="#activity">View all ${icon("arrow", 16)}</a></div>
          <div class="card-body">${activityFeed(p.activity.slice(0, 3))}</div>
        </section>
      </div>
    </div>`;
}

function releaseCard(full = false) {
  const r = project().release;
  const done = r.items.filter((i) => i.done).length;
  const pct = r.items.length ? Math.round((done / r.items.length) * 100) : 0;
  return `<section class="card">
    <div class="card-head"><h2>Next release</h2><button class="icon-btn bare" data-action="edit-release" title="Edit release">${icon("dots", 20)}</button></div>
    <div class="card-body">
      <div class="release-top"><span class="release-name">${esc(r.name)}</span><span class="due">${icon("calendar", 18)}Due ${esc(r.due)}</span></div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="progress-row"><span>${done} of ${r.items.length} tasks complete</span><span>${pct}%</span></div>
      <ul class="checklist">${r.items.map((it, i) => `<li><label><input type="checkbox" data-release-item="${i}" ${it.done ? "checked" : ""}>${esc(it.label)}</label></li>`).join("")}</ul>
      ${full ? `<form class="add-item" data-form="release-item"><input class="input" name="label" placeholder="Add a release item…" required><button class="btn">Add</button></form>` : ""}
      ${full ? "" : `<a class="link" href="#release">View release details ${icon("arrow", 16)}</a>`}
    </div></section>`;
}

let taskFilter = { status: "all", owner: "all" };
function viewTaskList(type) {
  const p = project();
  let list = p.tasks.filter((t) => t.type === type);
  if (taskFilter.status !== "all") list = list.filter((t) => t.status === taskFilter.status);
  if (taskFilter.owner !== "all") list = list.filter((t) => t.owner === taskFilter.owner);
  list.sort((a, b) => (a.status === "done") - (b.status === "done") || PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  const chip = (key, val, label) => `<button class="chip ${taskFilter[key] === val ? "on" : ""}" data-filter="${key}:${val}">${esc(label)}</button>`;
  return `${header(type === "bug" ? "Bugs" : "Tasks", type === "bug" ? "Bugs" : "Tasks")}
    <section class="card" style="margin-top:24px">
      <div class="card-head" style="flex-wrap:wrap">
        <div class="filters">${chip("status", "all", "All")}${Object.entries(STATUS).map(([k, v]) => chip("status", k, v.label)).join("")}</div>
        <div class="filters">${chip("owner", "all", "Everyone")}${p.team.map((id) => chip("owner", id, state.members[id].name)).join("")}</div>
      </div>
      ${taskTable(list, type === "bug" ? "No bugs 🎉" : "No tasks match these filters.")}
    </section>`;
}

function viewActivity() {
  const p = project();
  return `${header("Activity & Chat", "Activity & Chat")}
    <div class="grid" style="margin-top:24px">
      <section class="card"><div class="card-head"><h2>Team chat</h2></div><div class="card-body">
        <div class="chat">${p.chat.map((m) => `<div class="msg">${avatar(m.who, 34)}<div class="bubble"><div class="from">${esc(state.members[m.who]?.name)} · ${timeAgo(m.at)}</div>${esc(m.text)}</div></div>`).join("") || '<div class="empty">Say hi to your team 👋</div>'}</div>
        <form class="add-item" data-form="chat"><input class="input" name="text" placeholder="Message the team…" required maxlength="500" autocomplete="off"><button class="btn primary">${icon("send", 16)}Send</button></form>
      </div></section>
      <section class="card"><div class="card-head"><h2>All activity</h2></div><div class="card-body">${activityFeed(p.activity)}</div></section>
    </div>`;
}

function viewRelease() {
  return `${header("Release", "Release")}<div style="margin-top:24px;max-width:560px">${releaseCard(true)}</div>`;
}

function viewCollection(id) {
  const c = project().collections.find((x) => x.id === id);
  if (!c) return viewOverview();
  return `${header(c.name, c.name)}
    <section class="card" style="margin-top:24px;max-width:720px">
      <div class="card-head"><h2>${c.items.length} item${c.items.length === 1 ? "" : "s"}</h2></div>
      <div class="card-body">
        <form class="add-item" data-form="collection-item" data-collection="${esc(c.id)}"><input class="input" name="label" placeholder="Add an item…" required maxlength="80"><button class="btn">Add</button></form>
        <ul class="item-list">${c.items.map((it, i) => `<li>${esc(it)}<button class="icon-btn bare" data-remove-item="${i}" data-collection="${esc(c.id)}" title="Remove">${icon("trash", 16)}</button></li>`).join("")}</ul>
      </div>
    </section>`;
}

/* ---------- Render ---------- */
function route() {
  const h = location.hash.slice(1) || "overview";
  const [name, arg] = h.split("/");
  return { name, arg };
}

function renderSidebar() {
  const p = project();
  const r = route();
  $("#project-select").innerHTML = Object.entries(state.projects)
    .map(([id, pr]) => `<option value="${esc(id)}" ${id === state.currentProject ? "selected" : ""}>${esc(pr.name)}</option>`).join("");
  document.querySelectorAll("#side-nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === r.name));
  $("#activity-count").textContent = p.activity.length + p.chat.length;
  $("#side-collections").innerHTML = p.collections.map((c) => `<li><a href="#collection/${esc(c.id)}" class="${r.name === "collection" && r.arg === c.id ? "active" : ""}">${icon("folder", 22, 1.6)}<span style="flex:1">${esc(c.name)}</span><span class="count">${c.items.length}</span></a></li>`).join("");
  $("#team-count").textContent = p.team.length;
  $("#side-team").innerHTML = p.team.map((id) => avatar(id, 42)).join("") + `<button class="icon-btn round" data-action="add-member" title="Add member">${icon("plus", 18)}</button>`;
  const me = state.members[state.me];
  $("#side-user").innerHTML = `${avatar(state.me, 42)}<div class="who"><div class="name">${esc(me.name)}</div><div class="role">${esc(me.role)}</div></div><button class="icon-btn bare" data-action="reset" title="Reset demo data">${icon("settings", 20)}</button>`;
}

function render() {
  const r = route();
  const views = {
    overview: viewOverview,
    tasks: () => viewTaskList("task"),
    bugs: () => viewTaskList("bug"),
    activity: viewActivity,
    release: viewRelease,
    collection: () => viewCollection(r.arg),
  };
  $("#view").innerHTML = (views[r.name] || viewOverview)();
  renderSidebar();
  document.title = `${project().name} · BLACKBOX`;
}

/* ---------- Task dialog ---------- */
const dialog = $("#task-dialog");
const form = $("#task-form");
let editingId = null;

function openTask(id, defaults = {}) {
  const p = project();
  const t = id ? p.tasks.find((x) => x.id === id) : null;
  editingId = t ? t.id : null;
  $("#task-dialog-title").textContent = t ? "Edit task" : "New task";
  $("#delete-task-btn").hidden = !t;
  $("#owner-select").innerHTML = p.team.map((m) => `<option value="${esc(m)}">${esc(state.members[m].name)}</option>`).join("");
  const v = t || { title: "", desc: "", type: "task", priority: "medium", status: "todo", owner: state.me, ...defaults };
  for (const k of ["title", "desc", "type", "priority", "status", "owner"]) form.elements[k].value = v[k];
  dialog.showModal();
  form.elements.title.focus();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const p = project();
  const data = Object.fromEntries(new FormData(form));
  data.title = data.title.trim();
  if (!data.title) return;
  if (editingId) {
    const t = p.tasks.find((x) => x.id === editingId);
    const wasDone = t.status === "done";
    Object.assign(t, data);
    if (!wasDone && t.status === "done") log("done", `completed <b>${esc(t.title)}</b>`, t.type === "bug" ? "Bugs" : "Tasks");
    else log("update", `updated <b>${esc(t.title)}</b>`, t.type === "bug" ? "Bugs" : "Tasks");
  } else {
    const id = Math.max(0, ...p.tasks.map((t) => t.id)) + 1;
    p.tasks.push({ id, icon: "file", ...data });
    if (data.type === "bug") log("bug", "reported a new bug", "Bugs", data.title);
    else log("update", `created <b>${esc(data.title)}</b>`, "Tasks");
  }
  save();
  dialog.close();
  render();
});
$("#cancel-task-btn").addEventListener("click", () => dialog.close());
$("#delete-task-btn").addEventListener("click", () => {
  const p = project();
  const t = p.tasks.find((x) => x.id === editingId);
  if (!t || !confirm(`Delete "${t.title}"?`)) return;
  p.tasks = p.tasks.filter((x) => x.id !== editingId);
  log("update", `deleted <b>${esc(t.title)}</b>`, t.type === "bug" ? "Bugs" : "Tasks");
  save();
  dialog.close();
  render();
});

/* ---------- Global events ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action],[data-edit],[data-task],[data-filter],[data-remove-item]");
  if (!el) return;
  const p = project();

  if (el.dataset.filter) {
    const [k, v] = el.dataset.filter.split(":");
    taskFilter[k] = v;
    return render();
  }
  if (el.dataset.removeItem !== undefined) {
    const c = p.collections.find((x) => x.id === el.dataset.collection);
    c.items.splice(+el.dataset.removeItem, 1);
    save();
    return render();
  }
  if (el.dataset.edit || el.dataset.task) {
    return openTask(+(el.dataset.edit || el.dataset.task));
  }

  switch (el.dataset.action) {
    case "new-task":
      return openTask(null, { type: route().name === "bugs" ? "bug" : "task" });
    case "add-member": {
      const name = prompt("New team member name:")?.trim();
      if (!name) return;
      let id = slug(name);
      while (state.members[id] && p.team.includes(id)) id += "-2";
      if (!state.members[id]) {
        const hue = hash(name) % 360;
        state.members[id] = { name, role: "Member", color: `hsl(${hue} 80% 65%)`, accent: `hsl(${hue} 60% 25%)` };
      }
      p.team.push(id);
      save();
      return render();
    }
    case "edit-release": {
      const name = prompt("Release name:", p.release.name)?.trim();
      if (!name) return;
      const due = prompt("Due date:", p.release.due)?.trim();
      p.release.name = name;
      if (due) p.release.due = due;
      save();
      return render();
    }
    case "reset":
      if (!confirm("Reset all BLACKBOX data to the demo project?")) return;
      state = structuredClone(SEED);
      save();
      location.hash = "#overview";
      return render();
  }
});

document.addEventListener("change", (e) => {
  const i = e.target.dataset.releaseItem;
  if (i === undefined) return;
  const it = project().release.items[+i];
  it.done = e.target.checked;
  if (it.done) log("done", `completed <b>${esc(it.label)}</b>`, project().release.name);
  save();
  render();
});

document.addEventListener("submit", (e) => {
  const f = e.target;
  if (!f.dataset.form) return;
  e.preventDefault();
  const p = project();
  const val = (f.elements.label || f.elements.text).value.trim();
  if (!val) return;
  if (f.dataset.form === "chat") p.chat.push({ who: state.me, text: val, at: Date.now() });
  if (f.dataset.form === "release-item") p.release.items.push({ label: val, done: false });
  if (f.dataset.form === "collection-item") {
    const c = p.collections.find((x) => x.id === f.dataset.collection);
    c.items.push(val);
    log("update", `added <b>${esc(val)}</b>`, c.name);
  }
  save();
  render();
});

$("#project-select").addEventListener("change", (e) => {
  state.currentProject = e.target.value;
  taskFilter = { status: "all", owner: "all" };
  save();
  location.hash = "#overview";
  render();
});

$("#add-project-btn").addEventListener("click", () => {
  const name = prompt("Project name:")?.trim();
  if (!name) return;
  let id = slug(name);
  while (state.projects[id]) id += "-2";
  state.projects[id] = {
    name, tags: ["Roblox"], description: "A new game project.", team: [state.me], tasks: [],
    release: { name: "UPDATE 1", due: "TBD", items: [] }, collections: [], activity: [], chat: [],
  };
  state.currentProject = id;
  save();
  location.hash = "#overview";
  render();
});

$("#add-collection-btn").addEventListener("click", () => {
  const name = prompt("Collection name:")?.trim();
  if (!name) return;
  const p = project();
  let id = slug(name);
  while (p.collections.some((c) => c.id === id)) id += "-2";
  p.collections.push({ id, name, desc: "", art: id, items: [] });
  save();
  location.hash = `#collection/${id}`;
});

$("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
let lastView = route().name;
window.addEventListener("hashchange", () => {
  $("#sidebar").classList.remove("open");
  if (route().name !== lastView) taskFilter = { status: "all", owner: "all" };
  lastView = route().name;
  render();
});

document.querySelectorAll("[data-icon]").forEach((el) => {
  if (!el.innerHTML) el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, el.dataset.icon === "home" ? 20 : 18));
});
render();
