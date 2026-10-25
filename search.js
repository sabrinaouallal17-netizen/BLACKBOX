"use strict";

/* ---------- Global search (command palette) ----------
   Ctrl+K / Cmd+K, the sidebar Search button or the mobile search icon open a palette that searches the
   current project: tasks, bugs, feedback, chat messages (last 300 per channel), assets, collection items,
   update notes (and their sheets), plus pages, quick actions and other projects. */

const SP_TYPES = {
  task: { group: "tasks", label: "Tasks", icon: "check" },
  bug: { group: "bugs", label: "Bugs", icon: "bug" },
  feedback: { group: "feedback", label: "Feedback", icon: "inbox" },
  message: { group: "messages", label: "Messages", icon: "chat" },
  asset: { group: "docs", label: "Documents", icon: "file" },
  item: { group: "docs", label: "Documents", icon: "folder" },
  update: { group: "updates", label: "Updates", icon: "history" },
  sheet: { group: "updates", label: "Updates", icon: "fileText" },
  page: { group: "commands", label: "Pages & actions", icon: "arrow" },
  action: { group: "commands", label: "Pages & actions", icon: "plus" },
  project: { group: "projects", label: "Projects", icon: "gamepad" },
};
const SP_GROUPS = {
  tasks: "Tasks", bugs: "Bugs", feedback: "Feedback", messages: "Messages", docs: "Documents",
  updates: "Updates", commands: "Pages & actions", projects: "Projects",
};
const SP_GROUP_ORDER = ["commands", "tasks", "bugs", "feedback", "messages", "docs", "updates", "projects"];
const SP_FILTERS = [
  { id: "all", label: "All" },
  { id: "tasks", label: "Tasks", icon: "check" },
  { id: "bugs", label: "Bugs", icon: "bug" },
  { id: "feedback", label: "Feedback", icon: "inbox" },
  { id: "messages", label: "Messages", icon: "chat" },
  { id: "docs", label: "Docs", icon: "file" },
  { id: "updates", label: "Updates", icon: "history" },
];
const SP_PREFIXES = {
  task: "tasks", tasks: "tasks", bug: "bugs", bugs: "bugs", fb: "feedback", feedback: "feedback",
  msg: "messages", message: "messages", messages: "messages", chat: "messages",
  doc: "docs", docs: "docs", asset: "docs", assets: "docs", file: "docs", item: "docs",
  update: "updates", updates: "updates", patch: "updates",
};
const SP_GROUP_MAX = 6;
const SP_MSG_TTL = 60000;
const SP_RECENT_KEY = "blackbox:search:recent";
const SP_IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "");

const sp = {
  el: null, input: null, list: null,
  open: false, query: "", filter: "all", sel: 0, expanded: new Set(),
  rows: [],              // selectable rows of the current render: { kind: "result"|"more"|"recent", ... }
  returnFocus: null,
  msgCache: null,        // { pid, at, byChannel: { cid: [msg] } }
  msgLoading: false,
  msgError: "",
  msgPromise: null,
  sheetCache: {},        // updateId -> { v, sheets: [{ id, name, text }] }
  sheetPid: null,
  sheetLoading: 0,
  flashTimer: null,
};

/* ---------- Text helpers ---------- */
const spNorm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
// Normalized text plus, for each normalized character, the index of the original character.
function spMap(text) {
  const s = String(text ?? "");
  let norm = "";
  const map = [];
  let i = 0;
  for (const ch of s) {
    const n = spNorm(ch);
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
    i += ch.length;
  }
  map.push(s.length);
  return { s, norm, map };
}
// Escapes the text, then wraps every match of the query tokens in <mark>.
function spHighlight(text, tokens, { snippet = 0 } = {}) {
  const { s, norm, map } = spMap(text);
  const ranges = [];
  for (const t of tokens) {
    if (!t) continue;
    let from = 0, idx;
    while ((idx = norm.indexOf(t, from)) !== -1) {
      ranges.push([map[idx], map[idx + t.length] ?? s.length]);
      from = idx + t.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r.slice());
  }
  let start = 0, end = s.length;
  if (snippet && s.length > snippet) {
    const first = merged.length ? merged[0][0] : 0;
    start = Math.max(0, first - Math.round(snippet * 0.3));
    end = Math.min(s.length, start + snippet);
    if (end - start < snippet) start = Math.max(0, end - snippet);
    // Don't cut words in half.
    if (start > 0) { const sp1 = s.indexOf(" ", start); if (sp1 > -1 && sp1 < first && sp1 - start < 20) start = sp1 + 1; }
    if (end < s.length) { const sp2 = s.lastIndexOf(" ", end); if (sp2 > start + snippet * 0.6) end = sp2; }
  }
  let out = start > 0 ? "…" : "";
  let pos = start;
  for (const [a, b] of merged) {
    if (b <= start || a >= end) continue;
    const aa = Math.max(a, start), bb = Math.min(b, end);
    out += esc(s.slice(pos, aa)) + `<mark>${esc(s.slice(aa, bb))}</mark>`;
    pos = bb;
  }
  out += esc(s.slice(pos, end)) + (end < s.length ? "…" : "");
  return out;
}
const spClean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
function spStripHtml(html) {
  const spaced = String(html || "").replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/blockquote)\b[^>]*>/gi, " $&");
  try { return spClean(new DOMParser().parseFromString(spaced, "text/html").body.textContent || ""); } catch { return spClean(spaced.replace(/<[^>]*>/g, " ")); }
}
const spMsgText = (m) => spClean(typeof detokenizeMentions === "function" ? detokenizeMentions(m.text) : String(m.text || "").replace(/<@[A-Za-z0-9_-]+>/g, "@member"));
const spWhen = (t) => (t && typeof timeAgo === "function" ? timeAgo(t) : "");
const spName = (uid, stored) => (typeof nameOf === "function" ? nameOf(uid, stored) : typeof memberName === "function" ? memberName(uid) : stored || "");

/* ---------- Scoring ---------- */
const spWordStart = (n, i) => i === 0 || /[^a-z0-9]/.test(n[i - 1]);
function spFieldScore(n, q, tokens) {
  if (!n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  let i = n.indexOf(q);
  while (i > 0 && !spWordStart(n, i)) i = n.indexOf(q, i + 1);
  if (i > 0) return 62;
  if (n.includes(q)) return 42;
  if (tokens.length < 2) return 0;
  let s = 0;
  for (const t of tokens) {
    let j = n.indexOf(t);
    if (j < 0) return 0;
    let ws = spWordStart(n, j);
    while (!ws && (j = n.indexOf(t, j + 1)) !== -1) ws = spWordStart(n, j);
    s += ws ? 12 : 6;
  }
  return Math.min(36, s);
}
// Fields: [[text, weight]]. Every token must appear somewhere; the best weighted field decides the score.
const spNormCache = new WeakMap();
function spScore(rec, q, tokens) {
  let norms = spNormCache.get(rec);
  if (!norms) { norms = rec.fields.map(([t]) => spNorm(t)); spNormCache.set(rec, norms); }
  const hay = norms.join(" \u0001 ");
  for (const t of tokens) if (!hay.includes(t)) return 0;
  let best = 0;
  norms.forEach((n, i) => { best = Math.max(best, spFieldScore(n, q, tokens) * rec.fields[i][1]); });
  if (!best) best = 8; // tokens spread over several fields
  const age = rec.at ? (Date.now() - rec.at) / 864e5 : 365;
  return best + Math.max(0, 3 - age / 30) + (rec.boost || 0);
}

/* ---------- Records ---------- */
// Records are cached per source object so each keystroke only scores.
const spRecCache = new WeakMap();
function spRec(src, make) {
  let r = spRecCache.get(src);
  if (!r) { r = make(); spRecCache.set(src, r); }
  return r;
}
function spStatus(t) {
  if (t.type === "bug" && typeof bugStatusLabel === "function") { try { return bugStatusLabel(t.status); } catch { /* fall back */ } }
  if (t.type === "bug") return { todo: "Open", progress: "In progress", review: "To test", done: "Resolved" }[t.status] || t.status || "";
  return (typeof STATUS !== "undefined" && STATUS[t.status]?.label) || t.status || "";
}
function spTaskRecords() {
  if (typeof tasks === "undefined") return [];
  return tasks.map((t) => spRec(t, () => {
    const bug = t.type === "bug";
    const fields = [[t.title, 1], [t.desc, 0.55]];
    if (bug) for (const k of ["steps", "expected", "actual", "platform", "device", "gameVersion"]) if (t[k]) fields.push([t[k], 0.45]);
    const long = bug ? [t.desc, t.steps, t.actual, t.expected].filter(Boolean).join(" · ") : t.desc;
    return {
      type: bug ? "bug" : "task", id: t.id, title: t.title || "Untitled", text: spClean(long), fields, at: t.updatedAt || t.createdAt,
      meta: [spStatus(t), t.owner ? spName(t.owner) : ""].filter(Boolean).join(" · "), done: t.status === "done",
    };
  }));
}
function spFeedbackRecords() {
  const list = typeof feedbackItems !== "undefined" ? feedbackItems : null;
  if (!Array.isArray(list)) return [];
  const st = (typeof FEEDBACK_STATUS !== "undefined" && FEEDBACK_STATUS) || {};
  return list.map((f) => spRec(f, () => ({
    type: "feedback", id: f.id, title: f.title || "Untitled feedback", text: spClean(f.desc),
    fields: [[f.title, 1], [f.desc, 0.55], [f.author, 0.6], [(f.tags || []).join(" "), 0.6], [f.source, 0.3]],
    at: f.receivedAt || f.createdAt,
    meta: [st[f.status]?.label || (typeof st[f.status] === "string" ? st[f.status] : f.status), f.author].filter(Boolean).join(" · "),
  })));
}
function spMessageRecords() {
  if (typeof channelsOf !== "function" || typeof project !== "function" || !project()) return [];
  const chans = channelsOf();
  const by = {};
  if (sp.msgCache && sp.msgCache.pid === currentId) Object.assign(by, sp.msgCache.byChannel);
  if (typeof messages !== "undefined" && typeof channelId !== "undefined") {
    // The open channel's live messages are always the freshest.
    const seen = new Map((by[channelId] || []).map((m) => [m.id, m]));
    for (const m of messages) seen.set(m.id, m);
    by[channelId] = [...seen.values()];
  }
  const out = [];
  for (const c of chans) {
    for (const m of by[c.id] || []) {
      out.push(spRec(m, () => {
        const text = spMsgText(m);
        const files = (m.attachments || []).map((a) => a.name).filter(Boolean).join(" ");
        const author = spName(m.uid, m.name);
        return {
          type: "message", id: m.id, cid: c.id, title: text || files || "Attachment", text, fields: [[text, 1], [files, 0.6], [author, 0.35]],
          at: m.at, chan: c.name, author,
        };
      }));
    }
  }
  return out;
}
function spDocRecords() {
  const out = [];
  if (typeof assets !== "undefined") {
    for (const a of assets) out.push(spRec(a, () => ({
      type: "asset", id: a.id, title: a.name || "File", text: "", fields: [[a.name, 1], [a.kind, 0.2]], at: a.at,
      meta: [(typeof ASSET_KINDS !== "undefined" && ASSET_KINDS[a.kind]?.one) || "File", typeof formatSize === "function" ? formatSize(a.size) : ""].filter(Boolean).join(" · "),
      url: a.url, mime: a.type, folder: a.folder || "",
    })));
  }
  if (typeof items !== "undefined" && typeof project === "function" && project()) {
    const colls = project().collections || [];
    for (const x of items) {
      const c = colls.find((k) => k.id === x.collectionId);
      if (!c) continue;
      out.push(spRec(x, () => ({
        type: "item", id: x.id, cid: x.collectionId, title: x.name || "Item", text: spClean(x.desc), fields: [[x.name, 1], [x.desc, 0.55], [c.name, 0.2]],
        at: x.createdAt, meta: c.name, image: x.image,
      })));
    }
  }
  return out;
}
function spUpdateRecords() {
  const list = typeof updates !== "undefined" ? updates : null;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const u of list) {
    out.push(spRec(u, () => {
      const legacy = u.sections ? Object.values(u.sections).flat().filter((l) => typeof l === "string").join(" · ") : "";
      return {
        type: "update", id: u.id, title: u.title || "Untitled update", text: spClean(u.summary || legacy),
        fields: [[u.title, 1], [u.version, 0.9], [u.summary, 0.55], [legacy, 0.45]], at: u.date || u.publishedAt || u.createdAt,
        meta: [u.version ? `v${String(u.version).replace(/^v/i, "")}` : "", u.status === "draft" ? "Draft" : ""].filter(Boolean).join(" · "),
      };
    }));
    for (const sh of sp.sheetCache[u.id]?.sheets || []) {
      out.push(spRec(sh, () => ({
        type: "sheet", id: u.id, sheet: sh.id, title: `${u.title || "Update"} · ${sh.name || "Page"}`, text: sh.text,
        fields: [[sh.name, 0.8], [sh.text, 0.6]], at: u.date || u.createdAt, meta: "Update notes",
      })));
    }
  }
  return out;
}
const SP_PAGES = [
  ["overview", "Overview", "home", "home dashboard"],
  ["tasks", "Tasks", "check", "todo board"],
  ["bugs", "Bugs", "bug", "issues"],
  ["feedback", "Feedback", "inbox", "players suggestions"],
  ["chat", "Chat", "chat", "messages channels"],
  ["assets", "Assets", "images", "files documents images"],
  ["updates", "Updates", "history", "patch notes changelog releases"],
  ["analytics", "Analytics", "chart", "ccu revenue stats"],
  ["activity", "Activity", "pulse", "history log"],
  ["team", "Team", "users", "members invite"],
  ["project", "Project settings", "sliders", "settings configure"],
  ["profile", "Your profile", "user", "account settings"],
];
function spCommandRecords() {
  const out = [];
  const p = typeof project === "function" ? project() : null;
  if (!p) {
    out.push({ type: "page", id: "profile", title: "Go to Your profile", fields: [["Your profile", 1], ["account settings", 0.5]], icon: "user", hash: "#profile" });
    return out;
  }
  const canDo = (perm) => typeof can !== "function" || can(perm);
  for (const [id, label, ic, kw] of SP_PAGES) {
    if (id !== "profile" && id !== "overview" && id !== "project" && id !== "team" && !$(`#side-nav a[data-view="${id}"]`)) continue;
    out.push({ type: "page", id, title: `Go to ${label}`, fields: [[label, 1], [`go to ${label}`, 0.7], [kw, 0.5]], icon: ic, hash: `#${id}`, boost: 1 });
  }
  for (const c of typeof channelsOf === "function" ? channelsOf() : []) {
    out.push({ type: "page", id: `chan:${c.id}`, title: `Go to #${c.name}`, fields: [[c.name, 0.9], [`#${c.name} channel chat`, 0.5]], icon: "hash", hash: `#chat.${c.id}` });
  }
  for (const c of p.collections || []) {
    out.push({ type: "page", id: `coll:${c.id}`, title: `Open collection ${c.name}`, fields: [[c.name, 0.9], ["collection", 0.4]], icon: "folder", hash: `#collection.${c.id}` });
  }
  if (canDo("edit")) {
    out.push({ type: "action", id: "new-task", title: "New task", fields: [["New task", 1], ["create add task", 0.6]], icon: "plus", boost: 2 });
    out.push({ type: "action", id: "new-bug", title: "Report a bug", fields: [["New bug", 1], ["report a bug create issue", 0.7]], icon: "bug", boost: 2 });
    if (typeof actions !== "undefined" && actions["new-feedback"]) out.push({ type: "action", id: "new-feedback", title: "New feedback", fields: [["New feedback", 1], ["add player feedback", 0.6]], icon: "inbox" });
    out.push({ type: "action", id: "new-collection", title: "New collection", fields: [["New collection", 1], ["create", 0.4]], icon: "folderPlus" });
  }
  if (canDo("manage")) {
    out.push({ type: "action", id: "new-update", title: "New update", fields: [["New update", 1], ["patch notes", 0.5]], icon: "history" });
    out.push({ type: "action", id: "new-channel", title: "New channel", fields: [["New channel", 1], ["chat create", 0.4]], icon: "hash" });
  }
  out.push({ type: "action", id: "settings", title: "Settings", fields: [["Settings", 1], ["project settings preferences", 0.6]], icon: "sliders", hash: "#project" });
  out.push({ type: "action", id: "whats-new", title: "What's new", fields: [["What's new", 1], ["changelog release notes", 0.5]], icon: "sparkle" });
  return out;
}
function spProjectRecords() {
  if (typeof projects === "undefined") return [];
  return Object.entries(projects).filter(([id]) => id !== currentId).map(([id, p]) => ({
    type: "project", id, title: `Switch to ${p.name}`, fields: [[p.name, 1], ["switch project", 0.4]], meta: `${(p.memberIds || []).length} member${(p.memberIds || []).length === 1 ? "" : "s"}`, proj: p,
  }));
}

/* ---------- Background loading: messages of every channel, update sheets ---------- */
function spLoadMessages(force = false) {
  if (typeof msgCol !== "function" || typeof project !== "function" || !project()) return;
  const pid = currentId;
  if (!force && sp.msgCache && sp.msgCache.pid === pid && Date.now() - sp.msgCache.at < SP_MSG_TTL) return;
  if (sp.msgLoading) return;
  sp.msgLoading = true;
  const chans = channelsOf();
  let failed = null;
  const byChannel = {};
  sp.msgPromise = Promise.all(chans.map((c) => msgCol(c.id).orderBy("at").limitToLast(300).get()
    .then((snap) => { byChannel[c.id] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); })
    .catch((e) => { failed = failed || e; console.warn("BLACKBOX: search could not load #" + c.name, e); })))
    .then(() => {
      if (currentId !== pid) return;
      // Keep earlier results of channels that failed this time.
      const prev = sp.msgCache && sp.msgCache.pid === pid ? sp.msgCache.byChannel : {};
      sp.msgCache = { pid, at: failed ? 0 : Date.now(), byChannel: { ...prev, ...byChannel } };
      sp.msgError = failed ? (typeof friendlyError === "function" ? friendlyError(failed) : failed.message || "network error") : "";
      if (failed) toast(`Couldn't search all chat messages: ${typeof friendlyError === "function" ? friendlyError(failed) : failed.message || "network error"}`, true);
    })
    .finally(() => { sp.msgLoading = false; if (sp.open) spRender(); });
  if (sp.open) spRender();
}
function spLoadSheets() {
  if (typeof loadSheets !== "function") return;
  const list = typeof updates !== "undefined" ? updates : null;
  if (!Array.isArray(list)) return;
  if (sp.sheetPid !== currentId) { sp.sheetCache = {}; sp.sheetPid = currentId; }
  const pid = currentId;
  for (const u of list.slice(0, 40)) {
    const v = u.updatedAt || u.createdAt || 0;
    const c = sp.sheetCache[u.id];
    if (c && (c.v === v || c.loading)) continue;
    sp.sheetCache[u.id] = { v, sheets: c?.sheets || [], loading: true };
    sp.sheetLoading++;
    Promise.resolve().then(() => loadSheets(u.id))
      .then((sheets) => {
        if (currentId !== pid) return;
        sp.sheetCache[u.id] = { v, sheets: (Array.isArray(sheets) ? sheets : []).map((s) => ({ id: s.id, name: s.name || "", text: spStripHtml(s.html) })) };
      })
      .catch((e) => { console.warn("BLACKBOX: search could not load update pages", e); if (sp.sheetCache[u.id]) sp.sheetCache[u.id].loading = false; })
      .finally(() => { sp.sheetLoading--; if (sp.open) spRender(); });
  }
}
function spResetCaches() {
  sp.msgCache = null; sp.sheetCache = {}; sp.sheetPid = null; sp.expanded.clear();
  if (sp.open) spClose(false);
}
if (typeof onProjectReset === "function") onProjectReset(spResetCaches);

/* ---------- Recent searches & opened items ---------- */
function spRecent() {
  try {
    const r = JSON.parse(storeGet(SP_RECENT_KEY) || "{}");
    return { queries: Array.isArray(r.queries) ? r.queries.filter((q) => typeof q === "string") : [], items: Array.isArray(r.items) ? r.items.filter((x) => x && x.type) : [] };
  } catch { return { queries: [], items: [] }; }
}
function spSaveRecent(fn) {
  const r = spRecent();
  fn(r);
  r.queries = r.queries.slice(0, 6);
  r.items = r.items.slice(0, 30);
  try { storeSet(SP_RECENT_KEY, JSON.stringify(r)); } catch { /* storage full or blocked */ }
}
function spRemember(rec, query) {
  spSaveRecent((r) => {
    const q = spClean(query);
    if (q) r.queries = [q, ...r.queries.filter((x) => spNorm(x) !== spNorm(q))];
    if (["page", "action", "project"].includes(rec.type)) return;
    const keep = { type: rec.type, id: rec.id, pid: currentId, title: rec.title, cid: rec.cid, sheet: rec.sheet, chan: rec.chan, author: rec.author, at: rec.at, url: rec.url, mime: rec.mime, folder: rec.folder, meta: rec.meta };
    r.items = [keep, ...r.items.filter((x) => !(x.type === rec.type && x.id === rec.id && x.pid === currentId))];
  });
}

/* ---------- Results ---------- */
function spParse(raw) {
  let q = raw.trim();
  let filter = sp.filter;
  const m = q.match(/^([a-z]+):\s*/i);
  if (m && SP_PREFIXES[m[1].toLowerCase()]) { filter = SP_PREFIXES[m[1].toLowerCase()]; q = q.slice(m[0].length); }
  const nq = spNorm(q).replace(/\s+/g, " ").trim();
  return { q: nq, tokens: nq.split(" ").filter(Boolean), filter, text: q };
}
function spSearch(raw) {
  const { q, tokens, filter } = spParse(raw);
  if (!q) return { groups: [], filter, q, tokens, total: 0, counts: {} };
  const all = [
    ...spCommandRecords(), ...spTaskRecords(), ...spFeedbackRecords(), ...spMessageRecords(),
    ...spDocRecords(), ...spUpdateRecords(), ...spProjectRecords(),
  ];
  const byGroup = {};
  const counts = {};
  for (const rec of all) {
    const score = spScore(rec, q, tokens);
    if (!score) continue;
    const g = SP_TYPES[rec.type].group;
    counts[g] = (counts[g] || 0) + 1;
    if (filter !== "all" && g !== filter) continue;
    (byGroup[g] = byGroup[g] || []).push({ rec, score });
  }
  const groups = Object.entries(byGroup).map(([id, list]) => {
    list.sort((a, b) => b.score - a.score || (b.rec.at || 0) - (a.rec.at || 0));
    return { id, list, top: list[0].score };
  });
  // Groups with the strongest match come first; commands only lead when they match well.
  groups.sort((a, b) => {
    const ta = a.id === "commands" && a.top < 60 ? a.top - 50 : a.top;
    const tb = b.id === "commands" && b.top < 60 ? b.top - 50 : b.top;
    return Math.round(tb / 10) - Math.round(ta / 10) || SP_GROUP_ORDER.indexOf(a.id) - SP_GROUP_ORDER.indexOf(b.id);
  });
  const total = groups.reduce((n, g) => n + g.list.length, 0);
  return { groups, filter, q, tokens, total, counts };
}

/* ---------- Rendering ---------- */
function spIconFor(rec) {
  if (rec.icon) return icon(rec.icon, 17);
  if (rec.type === "asset" && typeof isImageType === "function" && isImageType(rec.mime) && safeUrl(rec.url)) return `<img src="${src(rec.url)}" alt="" loading="lazy">`;
  if (rec.type === "item" && rec.image && safeUrl(rec.image)) return `<img src="${src(rec.image)}" alt="" loading="lazy">`;
  if (rec.type === "project" && rec.proj && typeof gameIcon === "function") return gameIcon(rec.proj, 26);
  if (rec.type === "asset") return icon(rec.mime && /^image\//.test(rec.mime) ? "image" : rec.mime && /^video\//.test(rec.mime) ? "video" : "file", 17);
  return icon(SP_TYPES[rec.type]?.icon || "search", 17);
}
function spRowHtml(rec, tokens, idx) {
  const title = rec.type === "message"
    ? `<span class="sp-chan">#${esc(rec.chan)}</span><b class="sp-author">${esc(rec.author)}</b><span class="sp-time">${esc(spWhen(rec.at))}</span>`
    : `<span class="sp-title-text">${spHighlight(rec.title, tokens)}</span>`;
  const sub = rec.type === "message"
    ? spHighlight(rec.text || rec.title, tokens, { snippet: 110 })
    : rec.text ? spHighlight(rec.text, tokens, { snippet: 90 }) : "";
  const meta = rec.type === "message" ? "" : [rec.meta, rec.type !== "page" && rec.type !== "action" && rec.type !== "project" ? spWhen(rec.at) : ""].filter(Boolean).join(" · ");
  return `<div class="sp-row ${idx === sp.sel ? "on" : ""} ${rec.done ? "is-done" : ""}" role="option" id="sp-opt-${idx}" data-sp-i="${idx}" aria-selected="${idx === sp.sel}">
    <span class="sp-ic sp-ic-${esc(rec.type)}">${spIconFor(rec)}</span>
    <span class="sp-main"><span class="sp-title">${title}</span>${sub ? `<span class="sp-sub">${sub}</span>` : ""}</span>
    ${meta ? `<span class="sp-meta">${esc(meta)}</span>` : ""}
    <span class="sp-enter" aria-hidden="true">↵</span>
  </div>`;
}
function spRender() {
  if (!sp.el) return;
  const res = spSearch(sp.query);
  const hasProject = typeof project === "function" && !!project();
  sp.rows = [];
  let html = "";
  const add = (row, rowHtml) => { const i = sp.rows.length; sp.rows.push(row); return rowHtml(i); };

  if (!res.q) {
    // Empty query: recent searches, recently opened items, quick actions.
    const recent = spRecent();
    if (recent.queries.length) {
      html += `<div class="sp-group"><div class="sp-group-head"><span>Recent searches</span><button type="button" class="sp-clear" data-sp-clear>Clear</button></div>`;
      for (const q of recent.queries) html += add({ kind: "recent", query: q }, (i) => `<div class="sp-row ${i === sp.sel ? "on" : ""}" role="option" id="sp-opt-${i}" data-sp-i="${i}" aria-selected="${i === sp.sel}"><span class="sp-ic">${icon("clock", 17)}</span><span class="sp-main"><span class="sp-title">${esc(q)}</span></span><span class="sp-enter" aria-hidden="true">↵</span></div>`);
      html += "</div>";
    }
    const opened = recent.items.filter((x) => x.pid === currentId).slice(0, 5);
    if (opened.length && hasProject) {
      html += `<div class="sp-group"><div class="sp-group-head"><span>Recently opened</span></div>`;
      for (const r of opened) {
        const rec = { ...r, text: r.type === "message" ? r.title : "" };
        if (r.type === "message") rec.title = r.title;
        html += add({ kind: "result", rec }, (i) => spRowHtml(rec, [], i));
      }
      html += "</div>";
    }
    const QUICK = ["new-task", "new-bug", "chat", "updates", "settings", "whats-new"];
    const quick = spCommandRecords().filter((c) => QUICK.includes(c.id)).sort((a, b) => QUICK.indexOf(a.id) - QUICK.indexOf(b.id));
    if (quick.length) {
      html += `<div class="sp-group"><div class="sp-group-head"><span>Quick actions</span></div>`;
      for (const rec of quick) html += add({ kind: "result", rec }, (i) => spRowHtml(rec, [], i));
      html += "</div>";
    }
    if (!html) html = `<div class="sp-state">${icon("search", 30)}<b>Search everything</b><span class="muted">Tasks, bugs, feedback, messages, documents and updates.</span></div>`;
    else html += `<p class="sp-tip">Tip: type <kbd>bug:</kbd> <kbd>msg:</kbd> <kbd>doc:</kbd> to search one type, or press <kbd>Tab</kbd> to switch filters.</p>`;
  } else if (!res.total) {
    const others = Object.entries(res.counts).filter(([g]) => g !== res.filter);
    html = `<div class="sp-state">${icon("search", 30)}<b>No results for “${esc(res.q)}”</b>
      <span class="muted">${res.filter !== "all" && others.length
        ? `Nothing in ${esc(SP_FILTERS.find((f) => f.id === res.filter)?.label || "")}, but ${others.reduce((n, [, c]) => n + c, 0)} match${others.reduce((n, [, c]) => n + c, 0) === 1 ? "es" : ""} elsewhere.`
        : "Check the spelling or try fewer words."}${sp.msgLoading ? " Still loading messages…" : ""}</span>
      ${res.filter !== "all" ? `<button type="button" class="btn small" data-sp-filter="all">Search all types</button>` : ""}</div>`;
  } else {
    const single = res.filter !== "all";
    for (const g of res.groups) {
      const open = single || sp.expanded.has(g.id);
      const shown = open ? g.list.slice(0, 100) : g.list.slice(0, SP_GROUP_MAX);
      html += `<div class="sp-group" role="group" aria-label="${esc(SP_GROUPS[g.id])}"><div class="sp-group-head"><span>${esc(SP_GROUPS[g.id])}</span><span class="sp-count">${g.list.length}</span>${g.id === "messages" && sp.msgLoading ? `<span class="sp-loading">${icon("spinner", 13)}Loading…</span>` : ""}</div>`;
      for (const { rec } of shown) html += add({ kind: "result", rec }, (i) => spRowHtml(rec, res.tokens, i));
      if (g.list.length > shown.length) {
        html += add({ kind: "more", group: g.id }, (i) => `<div class="sp-row sp-more ${i === sp.sel ? "on" : ""}" role="option" id="sp-opt-${i}" data-sp-i="${i}" aria-selected="${i === sp.sel}"><span class="sp-ic">${icon("chevronsDown", 16)}</span><span class="sp-main"><span class="sp-title">Show all ${g.list.length} ${esc(SP_GROUPS[g.id].toLowerCase())}</span></span></div>`);
      }
      html += "</div>";
    }
  }
  if (sp.msgError && !sp.msgLoading && (res.filter === "all" || res.filter === "messages")) {
    html = `<div class="sp-notice" role="alert">${icon("alert", 15)}<span>Couldn't search all chat messages: ${esc(sp.msgError)}</span><button type="button" class="link small" data-sp-retry>Retry</button></div>` + html;
  }
  if (sp.sel >= sp.rows.length) sp.sel = Math.max(0, sp.rows.length - 1);
  sp.list.innerHTML = html;
  sp.list.querySelectorAll(".sp-row").forEach((r) => r.classList.toggle("on", +r.dataset.spI === sp.sel));
  // Filter chips with counts.
  const activeFilter = res.filter;
  const chips = SP_FILTERS.map((f) => {
    const n = f.id === "all" ? Object.values(res.counts).reduce((a, b) => a + b, 0) : res.counts[f.id] || 0;
    return `<button type="button" class="chip ${activeFilter === f.id ? "on" : ""}" data-sp-filter="${f.id}" role="tab" aria-selected="${activeFilter === f.id}">${f.icon ? icon(f.icon, 13) : ""}${esc(f.label)}${res.q ? `<span class="sp-chip-n">${n}</span>` : ""}</button>`;
  }).join("");
  const fbar = sp.el.querySelector(".sp-filters");
  if (fbar.innerHTML !== chips) fbar.innerHTML = chips;
  const loading = sp.msgLoading || sp.sheetLoading > 0;
  sp.el.querySelector(".sp-spin").hidden = !loading;
  sp.el.querySelector(".sp-status").textContent = loading ? (sp.msgLoading ? "Loading chat messages…" : "Loading update notes…") : res.q ? `${res.total} result${res.total === 1 ? "" : "s"}` : "";
  spSyncActive();
}
function spSyncActive(scroll = false) {
  const rows = sp.list.querySelectorAll(".sp-row[data-sp-i]");
  rows.forEach((r) => { const on = +r.dataset.spI === sp.sel; r.classList.toggle("on", on); r.setAttribute("aria-selected", on); });
  const cur = sp.list.querySelector(`[data-sp-i="${sp.sel}"]`);
  if (cur) sp.input.setAttribute("aria-activedescendant", cur.id); else sp.input.removeAttribute("aria-activedescendant");
  if (scroll && cur) cur.scrollIntoView({ block: "nearest" });
}

/* ---------- Open / close ---------- */
function spBuild() {
  if (sp.el) return;
  const root = $("#search-root") || document.body;
  root.insertAdjacentHTML("beforeend", `<dialog class="sp" id="search-dialog" aria-label="Search">
    <div class="sp-head">
      <span class="sp-head-ic">${icon("search", 19)}</span>
      <input id="sp-input" type="text" role="combobox" aria-expanded="true" aria-controls="sp-list" aria-autocomplete="list" placeholder="Search tasks, bugs, messages, docs…" autocomplete="off" spellcheck="false" maxlength="120">
      <span class="sp-spin" hidden>${icon("spinner", 16)}</span>
      <button type="button" class="sp-esc" data-sp-close title="Close (Esc)"><kbd>esc</kbd></button>
      <button type="button" class="sp-cancel" data-sp-close>Cancel</button>
    </div>
    <div class="sp-filters" role="tablist" aria-label="Filter results"></div>
    <div class="sp-list" id="sp-list" role="listbox" aria-label="Results"></div>
    <div class="sp-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to open</span><span><kbd>tab</kbd> filters</span><span><kbd>esc</kbd> to close</span>
      <span class="spacer"></span><span class="sp-status" role="status"></span>
    </div>
  </dialog>`);
  sp.el = $("#search-dialog");
  sp.input = $("#sp-input");
  sp.list = $("#sp-list");

  sp.input.addEventListener("input", () => { sp.query = sp.input.value; sp.sel = 0; sp.expanded.clear(); spMaybeLoad(); spRender(); sp.list.scrollTop = 0; });
  sp.el.addEventListener("keydown", spKey);
  sp.el.addEventListener("cancel", (e) => { e.preventDefault(); spClose(); });
  sp.el.addEventListener("close", () => { if (sp.open && !sp.el.open) spClose(); }); // a stale close event never shuts a reopened palette
  sp.el.addEventListener("mousedown", (e) => { sp.downOnBackdrop = e.target === sp.el; });
  sp.el.addEventListener("click", (e) => {
    // A click on the dim backdrop (outside the panel) closes the palette.
    if (e.target === sp.el && sp.downOnBackdrop) return spClose();
    const close = e.target.closest("[data-sp-close]");
    if (close) return spClose();
    const f = e.target.closest("[data-sp-filter]");
    if (f) { spSetFilter(f.dataset.spFilter); sp.input.focus(); return; }
    if (e.target.closest("[data-sp-retry]")) { sp.msgError = ""; spLoadMessages(true); sp.input.focus(); return; }
    if (e.target.closest("[data-sp-clear]")) { spSaveRecent((r) => { r.queries = []; }); spRender(); sp.input.focus(); return; }
    const row = e.target.closest("[data-sp-i]");
    if (row) { sp.sel = +row.dataset.spI; spActivate(); }
  });
  sp.list.addEventListener("mousemove", (e) => {
    const row = e.target.closest("[data-sp-i]");
    if (row && +row.dataset.spI !== sp.sel) { sp.sel = +row.dataset.spI; spSyncActive(); }
  });
}
function spMaybeLoad() {
  if (!sp.query.trim()) return;
  spLoadSheets();
}
function openSearch(opts = {}) {
  if (typeof user !== "undefined" && !user) return;
  spBuild();
  if (!sp.open) {
    sp.returnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    sp.open = true;
    if (typeof closePopover === "function") { try { closePopover(); } catch { /* none open */ } }
    if (typeof setMenu === "function") setMenu(false);
    sp.el.showModal();
    document.documentElement.classList.add("sp-open");
    // Each opening starts fresh: recent searches and quick actions show until something is typed.
    sp.query = ""; sp.filter = "all";
  }
  if (opts.filter && SP_FILTERS.some((f) => f.id === opts.filter)) sp.filter = opts.filter;
  if (typeof opts.query === "string") sp.query = opts.query;
  sp.input.value = sp.query;
  sp.sel = 0;
  sp.expanded.clear();
  spLoadMessages();
  spMaybeLoad();
  spRender();
  sp.input.focus();
  sp.input.select();
}
function spClose(restore = true) {
  if (!sp.el) return;
  sp.open = false;
  document.documentElement.classList.remove("sp-open");
  if (sp.el.open) sp.el.close();
  const back = sp.returnFocus;
  sp.returnFocus = null;
  if (restore && back && document.contains(back)) { try { back.focus({ preventScroll: true }); } catch { /* gone */ } }
}
const closeSearch = () => spClose();
function spSetFilter(id) {
  sp.filter = id;
  // A typed prefix ("bug:") gives way to the chip that was picked.
  const m = sp.query.match(/^([a-z]+):\s*/i);
  if (m && SP_PREFIXES[m[1].toLowerCase()]) { sp.query = sp.query.slice(m[0].length); sp.input.value = sp.query; }
  sp.sel = 0;
  spRender();
  sp.list.scrollTop = 0;
}
function spKey(e) {
  if (e.isComposing) return;
  const n = sp.rows.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "n" || e.key === "p"))) {
    e.preventDefault();
    if (!n) return;
    const down = e.key === "ArrowDown" || e.key === "n";
    sp.sel = (sp.sel + (down ? 1 : -1) + n) % n;
    spSyncActive(true);
  } else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); sp.sel = 0; spSyncActive(true); }
  else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); sp.sel = Math.max(0, n - 1); spSyncActive(true); }
  else if (e.key === "Enter") {
    e.preventDefault();
    spActivate();
  } else if (e.key === "Tab") {
    // Focus stays in the palette: Tab / Shift+Tab switch the filter instead.
    e.preventDefault();
    const ids = SP_FILTERS.map((f) => f.id);
    const cur = spParse(sp.query).filter;
    spSetFilter(ids[(ids.indexOf(cur) + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
    sp.input.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    spClose();
  } else if (e.target !== sp.input && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    sp.input.focus();
  }
}
function spActivate() {
  const row = sp.rows[sp.sel];
  if (!row) return;
  if (row.kind === "recent") {
    sp.query = row.query; sp.input.value = row.query; sp.sel = 0; spMaybeLoad(); spRender(); sp.input.focus();
    return;
  }
  if (row.kind === "more") {
    sp.expanded.add(row.group);
    spRender();
    sp.input.focus();
    return;
  }
  const rec = row.rec;
  spRemember(rec, sp.query);
  spClose(false);
  spOpenRecord(rec);
}

/* ---------- Navigation to a result ---------- */
// Sets the hash and runs `fn` once the page for it has rendered.
function spGo(hash, fn) {
  if (location.hash === hash || (!location.hash && hash === "#overview")) { fn?.(); return; }
  if (fn) window.addEventListener("hashchange", () => setTimeout(fn, 40), { once: true });
  location.hash = hash;
}
function spWaitFor(sel, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const el = document.querySelector(sel);
      if (el) return resolve(el);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(tick, 80);
    };
    tick();
  });
}
// Highlights an element for a moment; re-applied if a live re-render resets its classes.
function spFlash(el, sel) {
  clearInterval(sp.flashTimer);
  $$(".search-flash").forEach((x) => x.classList.remove("search-flash"));
  el.scrollIntoView({ block: "center" });
  el.classList.add("search-flash");
  const until = Date.now() + 2600;
  sp.flashTimer = setInterval(() => {
    const cur = document.querySelector(sel);
    if (Date.now() > until) { clearInterval(sp.flashTimer); cur?.classList.remove("search-flash"); return; }
    if (cur && !cur.classList.contains("search-flash")) cur.classList.add("search-flash");
  }, 120);
}
function spRunAction(name) {
  const btn = document.querySelector(`#view [data-action="${name}"]`);
  if (btn) return btn.click();
  if (typeof ACTION_PERMS !== "undefined" && ACTION_PERMS[name] && typeof can === "function" && !can(ACTION_PERMS[name])) return toast("You don't have permission to do that.", true);
  if (typeof actions !== "undefined" && typeof actions[name] === "function") actions[name]({ dataset: {} });
}
function spOpenRecord(rec) {
  const has = (list, id) => typeof list !== "undefined" && Array.isArray(list) && list.some((x) => x.id === id);
  switch (rec.type) {
    case "task":
      if (typeof tasks !== "undefined" && !has(tasks, rec.id)) return toast("This task no longer exists.", true);
      return spGo(route().name === "overview" || route().name === "tasks" ? location.hash || "#overview" : "#tasks", () => openTask(rec.id));
    case "bug":
      if (typeof tasks !== "undefined" && !has(tasks, rec.id)) return toast("This bug no longer exists.", true);
      if (typeof openBug === "function") return openBug(rec.id);
      return spGo(`#bugs.${rec.id}`, () => openTask(rec.id));
    case "feedback":
      if (typeof openFeedback === "function") return openFeedback(rec.id);
      return spGo(`#feedback.${rec.id}`);
    case "message": {
      const sel = `#chat-log [data-msg-id="${CSS.escape(rec.id)}"]`;
      spGo(`#chat.${rec.cid}`, async () => {
        const el = await spWaitFor(sel, 4000);
        if (el) spFlash(el, sel);
        else toast("That message isn't loaded in the chat anymore (only the latest 300 are shown).", true);
      });
      return;
    }
    case "asset": {
      const folder = rec.folder && typeof foldersOf === "function" && foldersOf().some((f) => f.id === rec.folder) ? rec.folder : "";
      spGo(folder ? `#assets.${folder}` : "#assets", async () => {
        const sel = `#view [data-asset="${CSS.escape(rec.id)}"]`;
        const card = await spWaitFor(sel, 1500);
        if (card) spFlash(card, sel);
        const a = typeof assets !== "undefined" ? assets.find((x) => x.id === rec.id) : null;
        if (a && typeof isImageType === "function" && isImageType(a.type) && safeUrl(a.url)) openLightbox(a.url, a.name);
        else if (!a) toast("This file no longer exists.", true);
      });
      return;
    }
    case "item":
      return spGo(`#collection.${rec.cid}`, () => {
        if (typeof items !== "undefined" && !has(items, rec.id)) return toast("This item no longer exists.", true);
        openItem(rec.cid, rec.id);
      });
    case "update":
    case "sheet":
      return spGo(`#updates.${rec.id}`);
    case "page":
      return spGo(rec.hash);
    case "project":
      if (typeof selectProject === "function" && typeof projects !== "undefined" && projects[rec.id]) {
        selectProject(rec.id);
        if (location.hash !== "#overview") location.hash = "#overview";
        toast(`Switched to ${projects[rec.id].name}`);
      }
      return;
    case "action":
      if (rec.id === "new-task") return openTask(null, { type: "task", status: "todo" });
      if (rec.id === "new-bug") {
        if (typeof createBug === "function") return createBug();
        return openTask(null, { type: "bug", status: "todo" });
      }
      if (rec.id === "settings") return spGo("#project");
      if (rec.id === "whats-new") return typeof openWhatsNew === "function" ? openWhatsNew() : null;
      if (rec.id === "new-feedback") return spGo("#feedback", () => spRunAction("new-feedback"));
      return spRunAction(rec.id);
    default:
  }
}

/* ---------- Shortcuts & wiring ---------- */
function spAppReady() {
  const app = $("#app");
  return typeof user !== "undefined" && !!user && app && !app.hidden;
}
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key || "").toLowerCase() !== "k") return;
  if (!spAppReady()) return;
  // Another dialog (task form, confirmation) is open: leave it alone.
  if ([...document.querySelectorAll("dialog[open]")].some((d) => d !== sp.el)) return;
  e.preventDefault();
  if (sp.open) spClose(); else openSearch();
});
(() => {
  const kbd = $("#search-kbd");
  if (kbd) kbd.textContent = SP_IS_MAC ? "⌘ K" : "Ctrl K";
  const btn = $("#search-btn");
  if (btn) btn.title = `Search (${SP_IS_MAC ? "⌘K" : "Ctrl+K"})`;
})();
if (typeof actions !== "undefined") Object.assign(actions, { "open-search": () => openSearch() });
