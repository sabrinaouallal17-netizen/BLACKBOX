"use strict";

/* ---------- Updates: changelog documents ----------
 * projects/{pid}/updates/{id}: { title, version, date, status, summary, cover, sheetOrder, createdBy, createdAt, updatedAt, editedBy, publishedAt }
 * projects/{pid}/updates/{id}/sheets/{sheetId}: { name, html, order, updatedAt } — one document per page, so a
 * changelog is not limited to the 1 MB of a single Firestore document. Images and videos are stored files
 * (bbfile:… / /_blob/…) referenced by data-src, so the HTML itself stays small.
 * Routes: #updates (history) · #updates.<id> (read) · #updates.<id>.edit · #updates.<id>.preview
 */
let updates = []; // filled by app.js (listenUpdates): admins get drafts too, members only published ones

const SHEET_WARN = 750 * 1024;   // bytes of HTML: suggest a new page
const SHEET_MAX = 1000 * 1000;   // bytes of HTML: refuse to save (Firestore documents hold 1 MiB)
const LEGACY_SECTIONS = { new: "New features", improved: "Improvements", fixed: "Bug fixes", balance: "Balance" };
const STARTER_HEADINGS = ["New features", "Improvements", "Bug fixes", "Known issues"];
const starterHtml = () => STARTER_HEADINGS.map((h) => `<h2>${h}</h2><ul><li><br></li></ul>`).join("");

/* ---------- Sanitizer ---------- */
// Stored HTML is written by project members: everything is rebuilt from an allow-list, on save and on render.
const SAN_TAGS = new Set(["p", "h1", "h2", "h3", "b", "strong", "i", "em", "u", "s", "strike", "a", "ul", "ol", "li", "blockquote", "hr", "br",
  "table", "thead", "tbody", "tr", "th", "td", "img", "video", "figure", "figcaption", "span", "div", "code", "pre"]);
// Removed together with everything inside them (not unwrapped).
const SAN_DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "template", "noscript", "textarea", "select", "option",
  "svg", "math", "title", "head", "meta", "link", "base", "form", "input", "button", "audio", "source", "track", "canvas", "applet", "param", "xmp", "plaintext", "noembed", "portal"]);
const safeMediaRef = (u) => { const s = String(u || "").trim(); return isStoredFile(s) || safeUrl(s) ? s : ""; };
function safeHref(u) {
  const s = String(u || "").trim();
  if (/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return s;
  if (/^mailto:[^\s"'<>\\:]+@[^\s"'<>\\]+$/i.test(s)) return s;
  return "";
}
function sanitizeHtml(html, { display = false } = {}) {
  let doc;
  try { doc = new DOMParser().parseFromString(`<!doctype html><html><body>${String(html ?? "")}</body></html>`, "text/html"); } catch { return ""; }
  const body = doc.body;
  cleanNode(body);
  if (display) tidyForReading(body);
  return body.innerHTML;
}
function cleanNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue;
    if (child.nodeType !== 1) { child.remove(); continue; }
    const tag = child.tagName.toLowerCase();
    if (SAN_DROP.has(tag)) { child.remove(); continue; }
    if (!SAN_TAGS.has(tag)) { cleanNode(child); child.replaceWith(...child.childNodes); continue; }
    const attrs = {};
    for (const a of child.attributes) attrs[a.name.toLowerCase()] = a.value;
    for (const a of [...child.attributes]) child.removeAttribute(a.name);
    if (tag === "a") {
      const href = safeHref(attrs.href);
      if (href) { child.setAttribute("href", href); child.setAttribute("rel", "noopener noreferrer"); child.setAttribute("target", "_blank"); }
    } else if (tag === "img" || tag === "video") {
      const ref = safeMediaRef(attrs["data-src"]) || safeMediaRef(attrs.src);
      if (!ref || (tag === "video" && /^data:/i.test(ref))) { child.remove(); continue; }
      child.setAttribute("data-src", ref);
      if (tag === "video") { child.setAttribute("controls", ""); child.setAttribute("preload", "metadata"); child.setAttribute("playsinline", ""); child.textContent = ""; }
      if (tag === "img") child.setAttribute("alt", String(attrs.alt || "").slice(0, 200));
    } else if (tag === "ul" && "data-checklist" in attrs) {
      child.setAttribute("data-checklist", "");
    } else if (tag === "li" && "data-checked" in attrs) {
      child.setAttribute("data-checked", attrs["data-checked"] === "true" ? "true" : "false");
    } else if (tag === "td" || tag === "th") {
      for (const k of ["colspan", "rowspan"]) {
        const n = parseInt(attrs[k], 10);
        if (n > 1 && n <= 50) child.setAttribute(k, String(n));
      }
    }
    if (tag !== "video") cleanNode(child);
  }
}
// Reading view only: empty bullets and empty sections of the starter structure are not shown to players.
function tidyForReading(body) {
  const isEmpty = (el) => !el.textContent.trim() && !el.querySelector("img,video,hr,table");
  body.querySelectorAll("li").forEach((li) => { if (isEmpty(li)) li.remove(); });
  body.querySelectorAll("ul,ol").forEach((l) => { if (!l.querySelector("li")) l.remove(); });
  const blocks = [...body.children];
  blocks.forEach((el, i) => {
    if (!/^H[123]$/.test(el.tagName)) return;
    const level = +el.tagName[1];
    let j = i + 1, content = false;
    for (; j < blocks.length; j++) {
      const b = blocks[j];
      if (/^H[123]$/.test(b.tagName) && +b.tagName[1] <= level) break;
      if (b.isConnected && !(b.tagName === "P" && isEmpty(b))) { content = true; break; }
    }
    if (!content) el.remove();
  });
}
// Stored references become playable src at render time (chunked files load in the background, then re-render).
const resolveDocMedia = (html) => html.replace(/ data-src="([^"]*)"/g, (m, v) => {
  const s = mediaSrc(v.replace(/&amp;/g, "&"));
  return s ? `${m} src="${esc(s)}"` : m;
});
const docHtml = (html) => resolveDocMedia(sanitizeHtml(html, { display: true }));

/* ---------- Data ---------- */
const updRef = (id) => sub("updates").doc(id);
const sheetCol = (id) => updRef(id).collection("sheets");
const sortSheets = (list) => list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt || 0) - (b.createdAt || 0));
const updateWhen = (u) => u.date || u.publishedAt || u.createdAt || 0;
const updateDate = (u) => new Date(updateWhen(u)).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const dateInput = (t) => { const d = new Date(t || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const legacyLines = (s) => (Array.isArray(s) ? s : String(s || "").split("\n")).map((l) => String(l).replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean);
function legacyHtml(u) {
  return Object.entries(LEGACY_SECTIONS).map(([k, label]) => {
    const ls = legacyLines(u.sections?.[k]);
    return ls.length ? `<h2>${label}</h2><ul>${ls.map((l) => `<li>${formatMessage(l).replace(/\n/g, " ")}</li>`).join("")}</ul>` : "";
  }).join("");
}
const hasLegacy = (u) => Object.keys(LEGACY_SECTIONS).some((k) => legacyLines(u?.sections?.[k]).length);

// Pages of an update, read once (search, duplicate). Legacy updates give one page built from their sections.
async function loadSheets(updateId) {
  const snap = await sheetCol(updateId).get();
  const list = sortSheets(snap.docs.map((d) => ({ id: d.id, ...d.data() }))).map((s) => ({ id: s.id, name: s.name || "Page", html: s.html || "", order: s.order ?? 0 }));
  if (!list.length) {
    const u = updates.find((x) => x.id === updateId);
    if (hasLegacy(u)) return [{ id: "legacy", name: "Patch notes", html: sanitizeHtml(legacyHtml(u)), order: 0 }];
  }
  return list;
}

// Live pages of the update being read or edited.
const sheetLive = { id: null, unsub: null, list: null };
function watchSheets(id) {
  if (sheetLive.id === id) return;
  sheetLive.unsub?.();
  Object.assign(sheetLive, { id, list: null, unsub: null });
  sheetLive.unsub = listen(() => sheetCol(id), (snap) => {
    if (sheetLive.id !== id) return;
    sheetLive.list = sortSheets(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    sheetLive.fromCache = !!snap.metadata?.fromCache;
    sheetsArrived(id);
    scheduleRender();
  });
}
function stopSheets() { sheetLive.unsub?.(); Object.assign(sheetLive, { id: null, unsub: null, list: null }); }
const liveSheets = (id) => (sheetLive.id === id ? sheetLive.list : null);

function nextVersion() {
  const last = updates.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).find((u) => /\d/.test(u.version || ""));
  if (!last) return "v1.0";
  return last.version.replace(/(\d+)(?!.*\d)/, (n) => String(+n + 1));
}

/* ---------- Editor state ---------- */
const ED = {
  id: null, sheetId: null, rev: 0,
  dirty: false, saving: null, status: "saved", timer: null,
  size: 0, edited: false, metaDraft: {}, metaTimer: null,
};
let updQuery = "";
let updFilter = "all";
let updDetailsOpen = false;
const converting = new Set();
const docRoute = () => { const [, id, mode] = location.hash.slice(1).split("."); return { id: id || "", mode: mode || "" }; };
const editorEl = () => document.getElementById("doc-body");

function resetEditor() {
  clearTimeout(ED.timer); clearTimeout(ED.metaTimer);
  Object.assign(ED, { id: null, sheetId: null, dirty: false, saving: null, status: "saved", timer: null, size: 0, edited: false, metaDraft: {}, metaTimer: null });
  ED.rev++;
}
onProjectReset(() => { resetEditor(); stopSheets(); updQuery = ""; updFilter = "all"; closeTablePicker(); });
PROJECT_CLEANUPS.push(async (ref) => {
  for (const u of (await ref.collection("updates").get()).docs) await deleteDocs((await u.ref.collection("sheets").get()).docs);
});
async function deleteDocs(docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// First pages of an update opened in the editor: convert legacy sections, or give it the starter page.
async function sheetsArrived(id) {
  const list = sheetLive.list;
  if (ED.id === id && list.length && !list.some((s) => s.id === ED.sheetId)) { ED.sheetId = list[0].id; ED.rev++; }
  // Only from the server's answer: an empty cache must not create a duplicate first page.
  if (list.length || sheetLive.fromCache || ED.id !== id || !can("manage") || converting.has(id)) return;
  const u = updates.find((x) => x.id === id);
  if (!u) return;
  converting.add(id);
  const ref = sheetCol(id).doc();
  const html = hasLegacy(u) ? sanitizeHtml(legacyHtml(u)) : starterHtml();
  await act(async () => {
    await ref.set({ name: "Patch notes", html, order: 0, updatedAt: Date.now() });
    await updRef(id).update({ sheetOrder: [ref.id], updatedAt: Date.now() });
  });
  converting.delete(id);
}

/* ---------- Views ---------- */
function viewUpdates(id) {
  const { mode } = docRoute();
  if (!id) return viewUpdateHistory();
  const u = updates.find((x) => x.id === id);
  if (!u) {
    return `${header("Updates", "Updates", { actions: false })}<section class="card"><div class="empty big-empty">${icon("history", 34)}<h3>Update not found</h3>
      <p class="muted">It may have been deleted${can("manage") ? "" : ", or it isn't published yet"}.</p><a class="btn" href="#updates">${icon("arrow", 16)}All updates</a></div></section>`;
  }
  watchSheets(id);
  if (mode === "edit" && can("manage")) return viewUpdateEditor(u);
  return viewUpdateRead(u, mode === "preview" && can("manage"));
}

function statusChip(u) {
  return u.status === "published" ? `<span class="doc-status pub">${icon("circleCheck", 13)}Published</span>` : `<span class="doc-status draft">${icon("edit", 13)}Draft</span>`;
}

function viewUpdateHistory() {
  const admin = can("manage");
  const q = updQuery.trim().toLowerCase();
  const all = updates.filter((u) => u.status === "published" || admin).sort((a, b) => updateWhen(b) - updateWhen(a) || (b.createdAt || 0) - (a.createdAt || 0));
  const shown = all.filter((u) => (updFilter === "all" || u.status === updFilter)
    && (!q || [u.title, u.version, u.summary].some((s) => String(s || "").toLowerCase().includes(q))));
  const counts = { all: all.length, published: all.filter((u) => u.status === "published").length, draft: all.filter((u) => u.status !== "published").length };
  const item = (u) => `<li class="tl-item ${u.status === "published" ? "is-pub" : "is-draft"}">
      <div class="tl-rail"><span class="tl-dot"></span><span class="tl-version">${esc(u.version || "—")}</span></div>
      <article class="tl-card">
        ${safeUrl(u.cover) ? `<a class="tl-cover" href="#updates.${esc(u.id)}" tabindex="-1"><img src="${src(u.cover)}" alt="" loading="lazy"></a>` : ""}
        <div class="tl-body">
          <div class="row-gap tl-meta">${u.version ? `<span class="tag-chip">${esc(u.version)}</span>` : ""}${admin ? statusChip(u) : ""}<span class="muted small">${icon("calendar", 13)} ${updateDate(u)}</span></div>
          <h3><a href="#updates.${esc(u.id)}">${esc(u.title || "Untitled update")}</a></h3>
          ${u.summary ? `<p class="muted tl-summary">${esc(u.summary)}</p>` : ""}
          <div class="tl-foot muted small">${avatar(u.createdBy, 20)}<span>${esc(memberName(u.createdBy))}</span>${u.updatedAt ? `<span>· edited ${esc(timeAgo(u.updatedAt))}${u.editedBy && u.editedBy !== u.createdBy ? ` by ${esc(memberName(u.editedBy))}` : ""}</span>` : ""}</div>
        </div>
        <div class="tl-actions">
          <a class="btn small ghost" href="#updates.${esc(u.id)}">${icon("eye", 15)}Read</a>
          ${admin ? `<a class="btn small" href="#updates.${esc(u.id)}.edit">${icon("edit", 15)}Edit</a>
          <button class="icon-btn bare" data-upd-menu="${esc(u.id)}" data-menu-key="upd-${esc(u.id)}" title="More">${icon("dots", 18)}</button>` : ""}
        </div>
      </article></li>`;
  return `${header("Updates", "", { actions: false })}
    <section class="card updates-page">
      <div class="coll-toolbar">
        <div class="coll-title"><span class="coll-badge">${icon("history", 20)}</span><div class="min0"><div class="coll-h">Version history</div><div class="muted small">Every update of ${esc(project().name)}, newest first</div></div></div>
        ${admin ? `<button class="btn primary" data-action="new-update">${icon("plus", 18, 2.2)}New update</button>` : ""}
      </div>
      ${all.length ? `<div class="upd-filters">
        <label class="upd-search">${icon("search", 16)}<input class="input" id="upd-search" type="search" placeholder="Search updates" value="${esc(updQuery)}" autocomplete="off"></label>
        ${admin ? `<div class="row-gap">${[["all", "All"], ["published", "Published"], ["draft", "Drafts"]].map(([k, l]) => `<button class="chip ${updFilter === k ? "on" : ""}" data-upd-filter="${k}">${l} <span class="muted">${counts[k]}</span></button>`).join("")}</div>` : ""}
      </div>` : ""}
      ${shown.length ? `<ol class="timeline">${shown.map(item).join("")}</ol>`
        : all.length ? `<div class="empty">${icon("search", 22)}<div>No update matches${q ? ` “${esc(updQuery)}”` : ""}.</div></div>`
        : `<div class="empty big-empty">${icon("history", 34)}<h3>No updates yet</h3><p class="muted">${admin ? "Write your first changelog: pages, headings, lists, images and videos. BLACKBOX can fill it from the tasks and bugs you completed." : "Changelogs appear here when an admin publishes them."}</p>${admin ? `<button class="btn primary" data-action="new-update">${icon("plus", 18, 2.2)}New update</button>` : ""}</div>`}
    </section>`;
}

function viewUpdateRead(u, preview) {
  const sheets = liveSheets(u.id);
  const admin = can("manage");
  let pages;
  if (!sheets) pages = `<div class="doc-loading">${icon("spinner", 18)}Loading…</div>`;
  else {
    const list = sheets.length ? sheets : hasLegacy(u) ? [{ id: "legacy", name: "Patch notes", html: legacyHtml(u) }] : [];
    pages = list.length ? list.map((s) => `<section class="doc-sheet" id="sheet-${esc(s.id)}">${list.length > 1 ? `<h2 class="doc-sheet-title">${esc(s.name)}</h2>` : ""}<div class="doc-prose">${docHtml(s.html) || '<p class="muted">This page is empty.</p>'}</div></section>`).join("")
      : '<div class="empty">This update has no notes yet.</div>';
    if (list.length > 1) pages = `<nav class="doc-jump">${list.map((s) => `<button class="chip" data-doc-jump="${esc(s.id)}">${icon("fileText", 14)}${esc(s.name)}</button>`).join("")}</nav>${pages}`;
  }
  const actionsHtml = preview
    ? `<div class="doc-preview-bar"><span>${icon("eye", 18)}<b>Preview</b><span class="muted">This is exactly what members will see.</span></span><span class="spacer"></span>
        <a class="btn" href="#updates.${esc(u.id)}.edit">${icon("edit", 16)}Back to editing</a>
        ${u.status === "published" ? `<a class="btn primary" href="#updates.${esc(u.id)}">Done</a>` : `<button class="btn primary" data-action="publish-update" data-update="${esc(u.id)}">${icon("rocket", 16)}Publish</button>`}</div>`
    : admin ? `<div class="row-gap doc-read-actions">
        <a class="btn small" href="#updates.${esc(u.id)}.edit">${icon("edit", 15)}Edit</a>
        ${u.status === "published" ? `<button class="btn small" data-action="unpublish-update" data-update="${esc(u.id)}">Back to draft</button>` : `<button class="btn primary small" data-action="publish-update" data-update="${esc(u.id)}">${icon("rocket", 15)}Publish</button>`}
        <button class="btn small ghost" data-action="duplicate-update" data-update="${esc(u.id)}">${icon("images", 15)}Duplicate</button>
        <button class="btn danger small" data-action="delete-update" data-update="${esc(u.id)}">${icon("trash", 15)}Delete</button></div>` : "";
  return `${header(u.title || "Untitled update", "Updates", { actions: false })}
    ${actionsHtml.startsWith('<div class="doc-preview-bar') ? actionsHtml : ""}
    <article class="doc-read ${preview ? "is-preview" : ""}">
      ${safeUrl(u.cover) ? `<div class="doc-cover"><img src="${src(u.cover)}" alt=""></div>` : ""}
      <header class="doc-read-head">
        <div class="row-gap">${u.version ? `<span class="tag-chip">${esc(u.version)}</span>` : ""}${u.status !== "published" ? statusChip(u) : ""}<span class="muted">${updateDate(u)}</span><span class="muted">· by ${esc(memberName(u.createdBy))}</span></div>
        <h1 class="doc-read-title">${esc(u.title || "Untitled update")}</h1>
        ${u.summary ? `<p class="lede">${esc(u.summary)}</p>` : ""}
        ${preview ? "" : actionsHtml}
      </header>
      <div class="doc-pages">${pages}</div>
      <footer class="doc-read-foot"><a class="link" href="#updates">${icon("history", 15)}All updates</a></footer>
    </article>`;
}

const TB = (cmd, ic, title, extra = "") => `<button type="button" class="tb-btn" data-doc-cmd="${cmd}" title="${esc(title)}" aria-label="${esc(title)}" data-live ${extra}>${icon(ic, 17)}</button>`;
function toolbarHtml() {
  return `<div class="doc-toolbar" id="doc-toolbar" data-live role="toolbar" aria-label="Formatting">
    ${TB("undo", "undo", "Undo (Ctrl+Z)")}${TB("redo", "redo", "Redo (Ctrl+Y)")}<span class="tb-sep"></span>
    <button type="button" class="tb-btn tb-block" data-doc-cmd="blockmenu" data-menu-key="doc-block" title="Text style" data-live><span data-keep="doc-block-label">Paragraph</span>${icon("chevron", 14)}</button><span class="tb-sep"></span>
    ${TB("bold", "bold", "Bold (Ctrl+B)")}${TB("italic", "italic", "Italic (Ctrl+I)")}${TB("underline", "underline", "Underline (Ctrl+U)")}${TB("strikeThrough", "strike", "Strikethrough")}<span class="tb-sep"></span>
    ${TB("link", "link", "Link (Ctrl+K)")}${TB("unlink", "unlink", "Remove link")}<span class="tb-sep"></span>
    ${TB("ul", "list", "Bulleted list")}${TB("ol", "listOrdered", "Numbered list")}${TB("checklist", "checklist", "Checklist")}<span class="tb-sep"></span>
    ${TB("quote", "quote", "Quote")}${TB("hr", "divider", "Divider")}<span class="tb-sep"></span>
    <button type="button" class="tb-btn" data-pick="doc-image" title="Insert image" aria-label="Insert image">${icon("image", 17)}</button>
    <button type="button" class="tb-btn" data-pick="doc-video" title="Insert video" aria-label="Insert video">${icon("video", 17)}</button>
    ${TB("table", "table", "Insert table")}
    <span class="tb-table"><span class="tb-sep"></span>
      ${TB("rowAbove", "arrowUp", "Insert row above")}${TB("rowBelow", "arrowDown", "Insert row below")}
      <button type="button" class="tb-btn tb-txt" data-doc-cmd="colLeft" title="Insert column left">+ Col ←</button><button type="button" class="tb-btn tb-txt" data-doc-cmd="colRight" title="Insert column right">+ Col →</button>
      <button type="button" class="tb-btn tb-txt" data-doc-cmd="delRow" title="Delete row">− Row</button><button type="button" class="tb-btn tb-txt" data-doc-cmd="delCol" title="Delete column">− Col</button>
      ${TB("delTable", "trash", "Delete table")}
    </span>
  </div>`;
}

function saveStatusHtml() {
  const offline = !navigator.onLine;
  const [cls, ic, text] = ED.status === "toolong" ? ["failed", "alert", "Page too long to save"]
    : ED.status === "failed" ? ["failed", "cloudOff", offline ? "Offline: couldn't save" : "Couldn't save"]
    : ED.status === "uploading" ? ["saving", "spinner", "Uploading…"]
    : (ED.status === "saving" || ED.status === "pending") && offline ? ["offline", "cloudOff", "Offline: changes sync when you're back"]
    : ED.status === "saving" ? ["saving", "spinner", "Saving…"]
    : ED.status === "pending" ? ["pending", "edit", "Editing…"]
    : ["saved", "cloud", "All changes saved"];
  return `<span class="doc-save ${cls}">${icon(ic, 15)}<span class="doc-save-text">${text}</span>${cls === "failed" && ED.status !== "toolong" ? '<button type="button" class="link" data-action="doc-retry">Retry</button>' : ""}</span>`;
}
function showDocStatus() {
  const el = $("#doc-save");
  if (el) el.innerHTML = saveStatusHtml();
  const warn = $("#doc-size-warn");
  if (warn) warn.outerHTML = sizeWarnHtml();
}
function sizeWarnHtml() {
  if (ED.size < SHEET_WARN) return '<div id="doc-size-warn" hidden></div>';
  const kb = Math.round(ED.size / 1024);
  return `<div id="doc-size-warn" class="notice doc-warn">${icon("alert", 18)}<span>${ED.size > SHEET_MAX ? `<b>This page is too long to save (${kb} KB).</b> Move part of it to a new page.` : `This page is getting long (${kb} KB of about 950 KB). Continue on a new page to keep it fast.`}</span><span class="spacer"></span><button type="button" class="btn small" data-action="doc-add-sheet">${icon("plus", 15)}New page</button></div>`;
}

function viewUpdateEditor(u) {
  if (ED.id !== u.id) { resetEditor(); ED.id = u.id; }
  const sheets = liveSheets(u.id);
  if (sheets?.length && !sheets.some((s) => s.id === ED.sheetId)) { ED.sheetId = sheets[0].id; ED.rev++; }
  const cur = sheets?.find((s) => s.id === ED.sheetId);
  const m = { title: u.title || "", version: u.version || "", summary: u.summary || "", date: dateInput(updateWhen(u)), ...ED.metaDraft };
  const tabs = (sheets || []).map((s, i) => `<li class="sheet-tab ${s.id === ED.sheetId ? "on" : ""}" data-sheet-tab="${esc(s.id)}" draggable="true">
      <button type="button" class="sheet-name" data-sheet-open="${esc(s.id)}" title="${esc(s.name)}">${icon("fileText", 15)}<span class="ellipsis">${esc(s.name || "Page")}</span></button>
      <button type="button" class="icon-btn bare sheet-more" data-sheet-menu="${esc(s.id)}" data-menu-key="sheet-${esc(s.id)}" title="Page options" aria-label="Page options">${icon("dots", 16)}</button>
      <span class="sheet-idx">${i + 1}</span></li>`).join("");
  queueMicrotask(hydrateEditorMedia);
  return `${header(m.title || "Untitled update", "Updates", { actions: false })}
    <div class="doc-shell">
      <div class="doc-topbar">
        <a class="link" href="#updates">${icon("history", 15)}History</a>
        ${statusChip(u)}
        <span id="doc-save" class="doc-save-wrap">${saveStatusHtml()}</span>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-action="fill-update">${icon("sparkle", 15)}Fill from completed work</button>
        <button type="button" class="btn small" data-action="preview-update" data-update="${esc(u.id)}">${icon("eye", 15)}Preview</button>
        ${u.status === "published" ? `<button type="button" class="btn small" data-action="unpublish-update" data-update="${esc(u.id)}">Unpublish</button>` : `<button type="button" class="btn small primary" data-action="preview-update" data-update="${esc(u.id)}" data-then="publish">${icon("rocket", 15)}Publish…</button>`}
        <button type="button" class="icon-btn bare" data-upd-menu="${esc(u.id)}" data-menu-key="upd-editor" title="More">${icon("dots", 18)}</button>
      </div>
      <div class="doc-layout">
        <aside class="doc-side">
          <section class="doc-panel">
            <div class="doc-panel-head"><b>Pages</b><button type="button" class="icon-btn bare" data-action="doc-add-sheet" title="Add a page" aria-label="Add a page">${icon("plus", 17)}</button></div>
            <ul class="sheet-tabs" id="sheet-tabs">${tabs || '<li class="muted small sheet-empty">Loading…</li>'}</ul>
          </section>
          <details class="doc-panel doc-details" id="doc-details" ${updDetailsOpen ? "open" : ""}>
            <summary><b>Details</b><span class="muted small">title, version, date, cover</span>${icon("chevron", 15)}</summary>
            <div class="doc-meta" data-update="${esc(u.id)}">
              <label>Title<input class="input" id="doc-title" data-meta="title" maxlength="80" value="${esc(m.title)}" placeholder="UPDATE 2: Quests"></label>
              <div class="doc-meta-row">
                <label>Version<input class="input" id="doc-version" data-meta="version" maxlength="20" value="${esc(m.version)}" placeholder="v1.2"></label>
                <label>Date<input class="input" id="doc-date" data-meta="date" type="date" value="${esc(m.date)}"></label>
              </div>
              <div class="doc-meta-status"><span class="muted small">Status</span><div class="seg seg-text">
                <button type="button" class="${u.status !== "published" ? "on" : ""}" data-action="unpublish-update" data-update="${esc(u.id)}" ${u.status !== "published" ? "disabled" : ""}>Draft</button>
                <button type="button" class="${u.status === "published" ? "on" : ""}" data-action="publish-update" data-update="${esc(u.id)}" ${u.status === "published" ? "disabled" : ""}>Published</button></div></div>
              <label>Summary <span class="hint">shown in the history</span><textarea class="input" id="doc-summary" data-meta="summary" rows="3" maxlength="300" placeholder="One or two sentences for players">${esc(m.summary)}</textarea></label>
              <div class="doc-cover-pick">
                <button type="button" class="brand-pick thumb-pick" data-pick="doc-cover" data-drop="doc-cover" title="Cover image">${safeUrl(u.cover) ? `<img src="${src(u.cover)}" alt="">` : `<span class="muted">${icon("images", 22)}<span>Cover image (optional)</span></span>`}</button>
                ${safeUrl(u.cover) ? `<button type="button" class="link small" data-action="doc-remove-cover">Remove cover</button>` : ""}
              </div>
            </div>
          </details>
        </aside>
        <div class="doc-main">
          ${toolbarHtml()}
          ${sizeWarnHtml()}
          <div class="doc-page" data-drop="doc-media">
            ${cur ? `<div class="doc-body doc-prose" id="doc-body" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Page content"
                data-update="${esc(u.id)}" data-sheet="${esc(cur.id)}" data-keep="sheet:${esc(u.id)}:${esc(cur.id)}:${ED.rev}" data-placeholder="Start writing…">${resolveDocMedia(sanitizeHtml(cur.html || ""))}</div>`
              : `<div class="doc-loading" data-keep="loading">${icon("spinner", 18)}Loading page…</div>`}
          </div>
          <div class="doc-page-foot muted small">${cur ? `${esc(cur.name)} · ${sheets.length} page${sheets.length === 1 ? "" : "s"}` : ""}<span class="spacer"></span><button type="button" class="link small" data-action="doc-add-sheet">${icon("plus", 14)}Add a page</button></div>
        </div>
      </div>
    </div>`;
}

// Chunked files finish loading after the editor was drawn (it is never re-morphed): give them their src.
function hydrateEditorMedia() {
  const el = editorEl();
  if (!el) return;
  el.querySelectorAll("img[data-src]:not([src]), video[data-src]:not([src])").forEach((m) => {
    const s = mediaSrc(m.dataset.src);
    if (s) m.setAttribute("src", s);
  });
}

/* ---------- Saving ---------- */
function markDirty() {
  if (!ED.sheetId || !editorEl()) return;
  ED.dirty = true;
  if (ED.status !== "saving") ED.status = "pending";
  showDocStatus();
  clearTimeout(ED.timer);
  ED.timer = setTimeout(() => saveSheet(), 1200);
}
// Saves the open page now (debounced typing, page switch, blur, leaving). The HTML is read from the editor
// synchronously, before any await, so it still works while the page is being navigated away from.
async function saveSheet() {
  clearTimeout(ED.timer); ED.timer = null;
  if (ED.saving) { await ED.saving; return ED.dirty ? saveSheet() : ED.status === "saved"; }
  if (!ED.dirty) return ED.status !== "failed" && ED.status !== "toolong";
  const el = editorEl();
  if (!el || el.dataset.update !== ED.id || el.dataset.sheet !== ED.sheetId) return false;
  const job = { id: ED.id, sheetId: ED.sheetId, html: sanitizeHtml(el.innerHTML) };
  ED.size = new Blob([job.html]).size;
  if (ED.size > SHEET_MAX) { ED.status = "toolong"; showDocStatus(); return false; }
  ED.dirty = false;
  ED.status = "saving";
  showDocStatus();
  const now = Date.now();
  ED.saving = act(async () => {
    await sheetCol(job.id).doc(job.sheetId).update({ html: job.html, updatedAt: now });
    await updRef(job.id).update({ updatedAt: now, editedBy: user.uid });
  });
  const ok = await ED.saving;
  ED.saving = null;
  if (ED.id !== job.id) return !!ok;
  if (!ok) { ED.dirty = true; ED.status = "failed"; showDocStatus(); return false; }
  if (!ED.edited) {
    ED.edited = true;
    const u = updates.find((x) => x.id === job.id);
    log("update.edit", "edited", u?.title || "Untitled update", "Updates", { ref: `update:${job.id}` });
  }
  ED.status = ED.dirty ? "pending" : "saved";
  showDocStatus();
  return true;
}
const flushDoc = () => (ED.dirty || ED.saving ? saveSheet() : Promise.resolve(ED.status !== "failed" && ED.status !== "toolong"));

function metaChanged(input) {
  ED.metaDraft[input.dataset.meta] = input.value;
  if (input.dataset.meta === "title") { const h = $("#view h1"); if (h) h.textContent = input.value || "Untitled update"; }
  clearTimeout(ED.metaTimer);
  ED.metaTimer = setTimeout(saveMeta, 700);
}
async function saveMeta() {
  clearTimeout(ED.metaTimer);
  const id = ED.id;
  const d = { ...ED.metaDraft };
  if (!id || !Object.keys(d).length) return;
  const data = { updatedAt: Date.now(), editedBy: user.uid };
  if ("title" in d) data.title = d.title.trim().slice(0, 80) || "Untitled update";
  if ("version" in d) data.version = d.version.trim().slice(0, 20);
  if ("summary" in d) data.summary = d.summary.trim().slice(0, 300);
  if ("date" in d) { const [y, mo, da] = d.date.split("-").map(Number); if (y) data.date = new Date(y, mo - 1, da, 12).getTime(); }
  const ok = await act(() => updRef(id).update(data));
  if (ok && ED.id === id) for (const [k, v] of Object.entries(d)) if (ED.metaDraft[k] === v) delete ED.metaDraft[k];
  if (ok && !ED.edited && ED.id === id) { ED.edited = true; log("update.edit", "edited", data.title || updates.find((x) => x.id === id)?.title || "", "Updates", { ref: `update:${id}` }); }
}

/* ---------- Editor commands ---------- */
let savedRange = null;
const inEditor = (node) => { const el = editorEl(); return !!(el && node && el.contains(node)); };
const elOf = (node) => (node?.nodeType === 1 ? node : node?.parentElement);
function closestIn(node, sel) { const el = editorEl(); const e = elOf(node)?.closest(sel); return e && el?.contains(e) && e !== el ? e : null; }
function restoreRange() {
  const el = editorEl();
  if (!el) return false;
  el.focus({ preventScroll: true });
  const s = getSelection();
  if (savedRange && el.contains(savedRange.commonAncestorContainer)) { s.removeAllRanges(); s.addRange(savedRange); }
  else if (!s.rangeCount || !el.contains(s.getRangeAt(0).commonAncestorContainer)) {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r);
  }
  return true;
}
const exec = (cmd, arg = null) => document.execCommand(cmd, false, arg);
function blockOf(node) {
  const el = editorEl();
  let e = elOf(node);
  while (e && e !== el && !/^(P|H1|H2|H3|BLOCKQUOTE|LI|PRE|DIV|TD|TH|FIGURE)$/.test(e.tagName)) e = e.parentElement;
  return e && e !== el ? e : null;
}
const BLOCK_LABELS = { p: "Paragraph", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3" };
function updateToolbarState() {
  const tb = $("#doc-toolbar");
  const s = getSelection();
  if (!tb || !s.rangeCount || !inEditor(s.anchorNode)) return;
  const set = (cmd, on) => tb.querySelector(`[data-doc-cmd="${cmd}"]`)?.classList.toggle("on", !!on);
  for (const c of ["bold", "italic", "underline", "strikeThrough"]) { let v = false; try { v = document.queryCommandState(c); } catch { /* old engines */ } set(c, v); }
  const list = closestIn(s.anchorNode, "ul,ol");
  set("ul", list?.tagName === "UL" && !list.hasAttribute("data-checklist"));
  set("ol", list?.tagName === "OL");
  set("checklist", list?.hasAttribute("data-checklist"));
  set("quote", closestIn(s.anchorNode, "blockquote"));
  set("link", closestIn(s.anchorNode, "a"));
  const h = closestIn(s.anchorNode, "h1,h2,h3");
  const lbl = tb.querySelector('[data-keep="doc-block-label"]');
  if (lbl) lbl.textContent = BLOCK_LABELS[h ? h.tagName.toLowerCase() : "p"];
  tb.classList.toggle("in-table", !!closestIn(s.anchorNode, "td,th"));
}
document.addEventListener("selectionchange", () => {
  const s = getSelection();
  if (!s.rangeCount || !inEditor(s.getRangeAt(0).commonAncestorContainer)) return;
  savedRange = s.getRangeAt(0).cloneRange();
  updateToolbarState();
});

function setBlock(tag) {
  const s = getSelection();
  const quote = closestIn(s.anchorNode, "blockquote");
  if (tag === "blockquote") {
    if (quote) unwrapQuote(quote); else exec("formatBlock", "<blockquote>");
    return;
  }
  const cur = closestIn(s.anchorNode, "h1,h2,h3");
  if (cur && cur.tagName.toLowerCase() === tag) tag = "p";
  if (closestIn(s.anchorNode, "li") && tag !== "p") {
    const list = closestIn(s.anchorNode, "ul,ol");
    exec(list.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
  }
  exec("formatBlock", `<${tag}>`);
}
function unwrapQuote(q) {
  const frag = document.createDocumentFragment();
  let inline = null;
  for (const n of [...q.childNodes]) {
    if (n.nodeType === 1 && /^(P|H1|H2|H3|UL|OL|TABLE|FIGURE|HR|PRE|DIV)$/.test(n.tagName)) { inline = null; frag.appendChild(n); }
    else { if (!inline) { inline = document.createElement("p"); frag.appendChild(inline); } inline.appendChild(n); }
  }
  q.replaceWith(frag);
}
function toggleList(kind) {
  const s = getSelection();
  const list = closestIn(s.anchorNode, "ul,ol");
  if (kind === "checklist") {
    if (list?.tagName === "UL" && list.hasAttribute("data-checklist")) {
      list.removeAttribute("data-checklist");
      list.querySelectorAll(":scope > li").forEach((li) => li.removeAttribute("data-checked"));
      return;
    }
    if (list?.tagName !== "UL") exec("insertUnorderedList");
    const ul = closestIn(getSelection().anchorNode, "ul");
    if (ul) { ul.setAttribute("data-checklist", ""); ul.querySelectorAll(":scope > li").forEach((li) => { if (!li.hasAttribute("data-checked")) li.setAttribute("data-checked", "false"); }); }
    return;
  }
  if (kind === "ul" && list?.hasAttribute("data-checklist")) {
    list.removeAttribute("data-checklist");
    list.querySelectorAll(":scope > li").forEach((li) => li.removeAttribute("data-checked"));
    return;
  }
  exec(kind === "ol" ? "insertOrderedList" : "insertUnorderedList");
}

function normalizeHref(s) {
  s = String(s || "").trim();
  if (!s) return "";
  if (/^mailto:/i.test(s)) return safeHref(s);
  if (EMAIL_RE.test(s)) return safeHref(`mailto:${s}`);
  if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  return safeHref(s);
}
async function editLink() {
  if (!restoreRange()) return;
  const range = getSelection().getRangeAt(0).cloneRange();
  const a = closestIn(range.startContainer, "a");
  const fields = [{ label: "Link address (https:// or mailto:)", value: a?.getAttribute("href") || "", max: 600, optional: !!a }];
  if (!a && range.collapsed) fields.push({ label: "Text to show", optional: true, max: 200 });
  const res = await ask({ title: a ? "Edit link" : "Insert link", text: a ? "Clear the address to remove the link." : "", fields, ok: a ? "Save" : "Insert" });
  savedRange = range;
  restoreRange();
  if (!res) return;
  if (a && !res[0]) { removeLink(a); return markDirty(); }
  const href = normalizeHref(res[0]);
  if (!href) return toast("Use a web address (https://…) or an email address.", true);
  if (a) a.setAttribute("href", href);
  else if (range.collapsed) exec("insertHTML", `<a href="${esc(href)}">${esc(res[1] || href)}</a>&nbsp;`);
  else exec("createLink", href);
  markDirty();
}
function removeLink(a) {
  a = a || closestIn(getSelection().anchorNode, "a");
  if (!a) return;
  const r = document.createRange(); r.selectNodeContents(a);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  exec("unlink");
}

/* Tables */
function insertTable(rows, cols) {
  if (!restoreRange()) return;
  const row = `<tr>${"<td><br></td>".repeat(cols)}</tr>`;
  exec("insertHTML", `<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`);
  markDirty();
}
function tableOp(op) {
  const s = getSelection();
  const cell = closestIn(s.anchorNode, "td,th");
  if (!cell) return;
  const tr = cell.parentElement;
  const table = cell.closest("table");
  const ci = [...tr.children].indexOf(cell);
  const rowsOf = () => [...table.querySelectorAll("tr")];
  const blankRow = () => { const r = document.createElement("tr"); for (let i = 0; i < tr.children.length; i++) r.insertAdjacentHTML("beforeend", "<td><br></td>"); return r; };
  const focusCell = (c) => { if (!c) return; const r = document.createRange(); r.selectNodeContents(c); r.collapse(true); s.removeAllRanges(); s.addRange(r); };
  if (op === "rowAbove") { const r = blankRow(); tr.before(r); focusCell(r.firstElementChild); }
  if (op === "rowBelow") { const r = blankRow(); tr.after(r); focusCell(r.firstElementChild); }
  if (op === "colLeft" || op === "colRight") rowsOf().forEach((r) => {
    const ref = r.children[Math.min(ci, r.children.length - 1)];
    const td = document.createElement(ref?.tagName === "TH" ? "th" : "td"); td.innerHTML = "<br>";
    if (!ref) r.appendChild(td); else if (op === "colLeft") ref.before(td); else ref.after(td);
  });
  if (op === "delRow") { const next = tr.nextElementSibling || tr.previousElementSibling; tr.remove(); if (!table.querySelector("tr")) table.remove(); else focusCell(next?.children[Math.min(ci, next.children.length - 1)]); }
  if (op === "delCol") { rowsOf().forEach((r) => r.children[ci]?.remove()); rowsOf().forEach((r) => { if (!r.children.length) r.remove(); }); if (!table.querySelector("td,th")) table.remove(); }
  if (op === "delTable") table.remove();
  markDirty();
  updateToolbarState();
}
let tablePicker = null;
function closeTablePicker() { tablePicker?.remove(); tablePicker = null; }
function openTablePicker(btn) {
  closeTablePicker();
  const N = 8;
  const box = document.createElement("div");
  box.className = "doc-tablepick";
  box.id = "doc-tablepick";
  box.innerHTML = `<div class="tp-grid">${Array.from({ length: N * N }, (_, i) => `<button type="button" data-tp-r="${Math.floor(i / N) + 1}" data-tp-c="${(i % N) + 1}" aria-label="${Math.floor(i / N) + 1} by ${(i % N) + 1}"></button>`).join("")}</div><div class="tp-label">Choose the table size</div>`;
  document.body.appendChild(box);
  const r = btn.getBoundingClientRect();
  box.style.top = `${Math.min(r.bottom + 6, innerHeight - box.offsetHeight - 8)}px`;
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8))}px`;
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("mouseover", (e) => {
    const b = e.target.closest("[data-tp-r]");
    if (!b) return;
    const R = +b.dataset.tpR, C = +b.dataset.tpC;
    box.querySelectorAll("[data-tp-r]").forEach((x) => x.classList.toggle("on", +x.dataset.tpR <= R && +x.dataset.tpC <= C));
    box.querySelector(".tp-label").textContent = `${R} × ${C}`;
  });
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tp-r]");
    if (!b) return;
    closeTablePicker();
    insertTable(+b.dataset.tpR, +b.dataset.tpC);
  });
  tablePicker = box;
}

function docCmd(cmd, btn) {
  if (cmd === "table") { restoreRange(); return tablePicker ? closeTablePicker() : openTablePicker(btn); }
  if (cmd === "blockmenu") {
    return openPopover(btn, () => [
      { id: "p", label: "Paragraph", icon: "fileText" }, { id: "h1", label: "Heading 1", icon: "heading" },
      { id: "h2", label: "Heading 2", icon: "heading" }, { id: "h3", label: "Heading 3", icon: "heading" },
    ], (it) => { if (restoreRange()) { setBlock(it.id); markDirty(); updateToolbarState(); } });
  }
  if (cmd === "link") return editLink();
  if (!restoreRange()) return;
  if (["bold", "italic", "underline", "strikeThrough", "undo", "redo"].includes(cmd)) exec(cmd);
  else if (cmd === "unlink") removeLink();
  else if (cmd === "ul" || cmd === "ol" || cmd === "checklist") toggleList(cmd);
  else if (cmd === "quote") setBlock("blockquote");
  else if (cmd === "hr") exec("insertHTML", "<hr><p><br></p>");
  else if (/^(rowAbove|rowBelow|colLeft|colRight|delRow|delCol|delTable)$/.test(cmd)) return tableOp(cmd);
  markDirty();
  updateToolbarState();
}

// Markdown-ish shortcuts typed at the start of a line, then a space.
const AUTOFORMAT = [[/^#$/, "h1"], [/^##$/, "h2"], [/^###$/, "h3"], [/^[-*]$/, "ul"], [/^1[.)]$/, "ol"], [/^\[ ?\]$/, "checklist"], [/^>$/, "blockquote"]];
function autoFormat() {
  const s = getSelection();
  if (!s.isCollapsed || !s.rangeCount) return false;
  const block = blockOf(s.anchorNode);
  if (block && /^(LI|TD|TH)$/.test(block.tagName)) return false;
  const r = document.createRange();
  r.setStart(block || editorEl(), 0);
  r.setEnd(s.anchorNode, s.anchorOffset);
  const text = r.toString();
  const rule = AUTOFORMAT.find(([re]) => re.test(text));
  if (!rule) return false;
  s.removeAllRanges(); s.addRange(r);
  exec("delete");
  const kind = rule[1];
  if (/^h[123]$|^blockquote$/.test(kind)) setBlock(kind); else toggleList(kind);
  markDirty();
  return true;
}

/* ---------- Media ---------- */
function dataUrlToBlob(u) {
  const [head, b64] = u.split(",");
  const type = head.match(/data:([^;]+)/)?.[1] || "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
// Pictures are compressed like everywhere else; the Firebase edition then stores them as separate files
// (instead of inline data) so a page with many images stays far below the document size limit.
async function uploadDocFile(file) {
  let up = await storeFile(file, "doc");
  if (/^data:/.test(up.url)) {
    const blob = dataUrlToBlob(up.url);
    const stored = await storeChunked(new File([blob], up.name || "image", { type: blob.type }));
    mediaUrls.set(stored.url, URL.createObjectURL(blob));
    up = { ...up, url: stored.url };
  } else if (isStoredFile(up.url)) mediaUrls.set(up.url, URL.createObjectURL(file));
  return up;
}
async function insertMedia(files) {
  if (!editorEl()) return toast("Open a page of the update first.", true);
  const range = savedRange;
  for (const f of files) {
    const kind = mediaKind(f.type);
    if (kind !== "image" && kind !== "video") { toast(`${f.name}: choose an image or a video.`, true); continue; }
    ED.status = "uploading"; showDocStatus();
    const up = await act(() => uploadDocFile(f));
    ED.status = ED.dirty ? "pending" : "saved"; showDocStatus();
    if (!up || !editorEl()) continue;
    const s = mediaSrc(up.url);
    const ref = esc(up.url);
    const html = kind === "image"
      ? `<figure><img data-src="${ref}" ${s ? `src="${esc(s)}"` : ""} alt=""></figure><p><br></p>`
      : `<figure><video controls preload="metadata" playsinline data-src="${ref}" ${s ? `src="${esc(s)}"` : ""}></video></figure><p><br></p>`;
    savedRange = range && editorEl().contains(range.commonAncestorContainer) ? range : savedRange;
    restoreRange();
    exec("insertHTML", html);
    savedRange = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
    markDirty();
  }
}
Object.assign(FILE_TARGETS, {
  "doc-image": (files) => insertMedia(files),
  "doc-video": (files) => insertMedia(files),
  "doc-media": (files) => insertMedia(files),
  "doc-cover": async (files) => {
    const id = ED.id;
    if (!id) return;
    const up = await act(() => storeFile(files[0], "thumbnail"));
    if (up && await act(() => updRef(id).update({ cover: up.url, updatedAt: Date.now(), editedBy: user.uid }), "Cover updated")) {
      log("update.edit", "changed the cover of", updates.find((x) => x.id === id)?.title || "", "Updates", { ref: `update:${id}` });
    }
  },
});
Object.assign(FILE_TARGET_PERMS, { "doc-image": "manage", "doc-video": "manage", "doc-media": "manage", "doc-cover": "manage" });
Object.assign(PICK_ACCEPT, { "doc-image": () => "image/*", "doc-video": () => "video/*", "doc-cover": () => "image/*" });
PICK_MULTI.add("doc-image");

/* ---------- Pages ---------- */
async function addSheet() {
  const id = ED.id;
  const list = liveSheets(id) || [];
  if (!id) return;
  if (!(await flushDoc())) return toast("Save this page first (see Retry above).", true);
  const ref = sheetCol(id).doc();
  const order = list.reduce((m, s) => Math.max(m, s.order ?? 0), -1) + 1;
  let name = `Page ${list.length + 1}`;
  while (list.some((s) => s.name === name)) name += "+";
  const ok = await act(async () => {
    await ref.set({ name, html: "<p><br></p>", order, updatedAt: Date.now() });
    await updRef(id).update({ sheetOrder: [...list.map((s) => s.id), ref.id], updatedAt: Date.now(), editedBy: user.uid });
  }, `${name} added`);
  if (ok && ED.id === id) { ED.sheetId = ref.id; ED.rev++; ED.size = 0; render(); editorEl()?.focus(); }
}
async function openSheet(sheetId) {
  if (sheetId === ED.sheetId) return;
  if (!(await flushDoc())) return toast("This page couldn't be saved yet. Retry before switching pages.", true);
  ED.sheetId = sheetId; ED.rev++; ED.size = 0; savedRange = null;
  render();
}
async function renameSheet(sheetId) {
  const s = (liveSheets(ED.id) || []).find((x) => x.id === sheetId);
  if (!s) return;
  const [name] = (await ask({ title: "Rename page", fields: [{ label: "Page name", value: s.name, max: 60 }], ok: "Rename" })) || [];
  if (name && name !== s.name) await act(() => sheetCol(ED.id).doc(sheetId).update({ name, updatedAt: Date.now() }));
}
async function deleteSheet(sheetId) {
  const id = ED.id;
  const list = liveSheets(id) || [];
  const s = list.find((x) => x.id === sheetId);
  if (!s) return;
  if (list.length < 2) return toast("An update needs at least one page.", true);
  if (!(await ask({ title: `Delete “${s.name}”?`, text: "This page and everything on it are removed from the update.", ok: "Delete page", danger: true }))) return;
  if (sheetId === ED.sheetId) { clearTimeout(ED.timer); ED.dirty = false; ED.status = "saved"; }
  const ok = await act(async () => {
    await sheetCol(id).doc(sheetId).delete();
    await updRef(id).update({ sheetOrder: list.filter((x) => x.id !== sheetId).map((x) => x.id), updatedAt: Date.now(), editedBy: user.uid });
  }, "Page deleted");
  if (ok && ED.sheetId === sheetId) { ED.sheetId = list.find((x) => x.id !== sheetId)?.id || null; ED.rev++; render(); }
}
async function moveSheet(sheetId, toIndex) {
  const id = ED.id;
  const list = (liveSheets(id) || []).slice();
  const from = list.findIndex((x) => x.id === sheetId);
  if (from < 0 || toIndex < 0 || toIndex >= list.length || from === toIndex) return;
  const [s] = list.splice(from, 1);
  list.splice(toIndex, 0, s);
  const batch = db.batch();
  list.forEach((x, i) => { if ((x.order ?? 0) !== i) batch.update(sheetCol(id).doc(x.id), { order: i }); });
  batch.update(updRef(id), { sheetOrder: list.map((x) => x.id), updatedAt: Date.now(), editedBy: user.uid });
  await act(() => batch.commit());
}
function openSheetMenu(btn) {
  const sid = btn.dataset.sheetMenu;
  openPopover(btn, () => {
    const list = liveSheets(ED.id) || [];
    const i = list.findIndex((x) => x.id === sid);
    return [
      { id: "rename", label: "Rename", icon: "edit" },
      { id: "up", label: "Move up", icon: "arrowUp", disabled: i <= 0 },
      { id: "down", label: "Move down", icon: "arrowDown", disabled: i < 0 || i >= list.length - 1 },
      { sep: true },
      { id: "delete", label: "Delete page", icon: "trash", danger: true, disabled: list.length < 2 },
    ];
  }, (it) => {
    const list = liveSheets(ED.id) || [];
    const i = list.findIndex((x) => x.id === sid);
    if (it.id === "rename") renameSheet(sid);
    if (it.id === "up") moveSheet(sid, i - 1);
    if (it.id === "down") moveSheet(sid, i + 1);
    if (it.id === "delete") deleteSheet(sid);
  });
}

/* ---------- Fill from completed work ---------- */
const IMPROVEMENT_RE = /\b(improv|polish|optimi[sz]|better|faster|rework|refactor|tweak|balanc|redesign|clean ?up|smoother|updat)/i;
function fillUpdateFromWork() {
  const el = editorEl();
  if (!el) return toast("Open a page of the update first.", true);
  const lastPub = updates.filter((u) => u.status === "published" && u.id !== ED.id).reduce((m, u) => Math.max(m, u.publishedAt || 0), 0);
  const recent = tasks.filter((t) => t.status === "done" && (t.resolvedAt || t.updatedAt || t.createdAt || 0) > lastPub);
  const groups = {
    "New features": recent.filter((t) => t.type !== "bug" && !IMPROVEMENT_RE.test(t.title)).map((t) => t.title),
    Improvements: recent.filter((t) => t.type !== "bug" && IMPROVEMENT_RE.test(t.title)).map((t) => t.title),
    "Bug fixes": recent.filter((t) => t.type === "bug").map((t) => t.title),
  };
  let added = 0;
  for (const [label, titles] of Object.entries(groups)) {
    if (!titles.length) continue;
    let h = [...el.querySelectorAll("h1,h2,h3")].find((x) => x.textContent.trim().toLowerCase() === label.toLowerCase());
    if (!h) { h = document.createElement("h2"); h.textContent = label; el.appendChild(h); }
    let list = h.nextElementSibling;
    if (!list || !/^(UL|OL)$/.test(list.tagName)) { list = document.createElement("ul"); h.after(list); }
    const have = new Set([...list.children].map((li) => li.textContent.trim()));
    [...list.children].forEach((li) => { if (!li.textContent.trim() && !li.querySelector("img,video")) li.remove(); });
    for (const t of titles) {
      if (have.has(t.trim())) continue;
      const li = document.createElement("li");
      if (list.hasAttribute("data-checklist")) li.setAttribute("data-checked", "false");
      li.textContent = t;
      list.appendChild(li);
      added++;
    }
  }
  if (added) markDirty();
  toast(added ? `Added ${added} completed item${added === 1 ? "" : "s"}` : "Nothing new completed since the last published update.");
}

/* ---------- Update actions ---------- */
async function createUpdate() {
  const now = Date.now();
  const ref = sub("updates").doc();
  const sheet = ref.collection("sheets").doc();
  const title = "Untitled update";
  const ok = await act(async () => {
    await ref.set({ title, version: nextVersion(), date: now, status: "draft", summary: "", cover: "", sheetOrder: [sheet.id], createdBy: user.uid, createdAt: now, updatedAt: now });
    await sheet.set({ name: "Patch notes", html: starterHtml(), order: 0, updatedAt: now });
  });
  if (!ok) return;
  log("update.create", "drafted", title, "Updates", { ref: `update:${ref.id}` });
  updDetailsOpen = true;
  location.hash = `#updates.${ref.id}.edit`;
}
async function duplicateUpdate(id) {
  const u = updates.find((x) => x.id === id);
  if (!u) return;
  if (ED.id === id && !(await flushDoc())) return;
  const now = Date.now();
  const ref = sub("updates").doc();
  const ok = await act(async () => {
    const sheets = await loadSheets(id);
    const refs = sheets.map(() => ref.collection("sheets").doc());
    await ref.set({ title: `${u.title || "Untitled update"} (copy)`.slice(0, 80), version: u.version || "", date: now, status: "draft", summary: u.summary || "", cover: u.cover || "", sheetOrder: refs.map((r) => r.id), createdBy: user.uid, createdAt: now, updatedAt: now });
    for (const [i, s] of sheets.entries()) await refs[i].set({ name: s.name, html: sanitizeHtml(s.html), order: i, updatedAt: now });
  }, "Duplicated as a new draft");
  if (!ok) return;
  log("update.create", "duplicated", u.title, "Updates", { ref: `update:${ref.id}` });
  location.hash = `#updates.${ref.id}.edit`;
}
async function setUpdateStatus(id, status) {
  const u = updates.find((x) => x.id === id);
  if (!u) return;
  if (ED.id === id) { await saveMeta(); if (!(await flushDoc())) return toast("Save the page first (see Retry above).", true); }
  const fresh = updates.find((x) => x.id === id) || u;
  if (status === "published" && !(fresh.title || "").trim()) return toast("Give the update a title first.", true);
  const data = { status, updatedAt: Date.now(), editedBy: user.uid };
  if (status === "published") data.publishedAt = Date.now();
  if (!(await act(() => updRef(id).update(data), status === "published" ? "Update published" : "Moved back to drafts"))) return;
  log(status === "published" ? "update.publish" : "update.edit", status === "published" ? "published" : "unpublished", fresh.title, "Updates", { ref: `update:${id}` });
  if (status === "published") {
    for (const m of project().memberIds) notify(m, "update", fresh.title, `#updates.${id}`);
    if (docRoute().mode) location.hash = `#updates.${id}`;
  }
}
async function deleteUpdate(id) {
  const u = updates.find((x) => x.id === id);
  if (!u || !(await ask({ title: `Delete ${u.title || "this update"}?`, text: "The update and all its pages are removed for everyone. This can't be undone.", ok: "Delete", danger: true }))) return;
  if (ED.id === id) { clearTimeout(ED.timer); ED.dirty = false; }
  const ok = await act(async () => {
    await deleteDocs((await sheetCol(id).get()).docs);
    await updRef(id).delete();
  }, "Update deleted");
  if (!ok) return;
  log("update.delete", "deleted", u.title, "Updates", { ref: `update:${id}` });
  if (docRoute().id === id) location.hash = "#updates";
}
function openUpdateMenu(btn) {
  const id = btn.dataset.updMenu;
  openPopover(btn, () => {
    const u = updates.find((x) => x.id === id);
    return [
      { id: "read", label: "Read", icon: "eye" },
      { id: "edit", label: "Edit", icon: "edit" },
      { id: "dup", label: "Duplicate as new draft", icon: "images" },
      u?.status === "published" ? { id: "unpub", label: "Unpublish", icon: "archive" } : { id: "pub", label: "Publish", icon: "rocket" },
      { sep: true },
      { id: "delete", label: "Delete", icon: "trash", danger: true },
    ];
  }, (it) => {
    if (it.id === "read") location.hash = `#updates.${id}`;
    if (it.id === "edit") location.hash = `#updates.${id}.edit`;
    if (it.id === "dup") duplicateUpdate(id);
    if (it.id === "pub") setUpdateStatus(id, "published");
    if (it.id === "unpub") setUpdateStatus(id, "draft");
    if (it.id === "delete") deleteUpdate(id);
  });
}

Object.assign(ACTION_PERMS, {
  "duplicate-update": "manage", "preview-update": "manage", "fill-update": "manage", "doc-add-sheet": "manage",
  "doc-retry": "manage", "doc-remove-cover": "manage",
});
Object.assign(actions, {
  "new-update": () => createUpdate(),
  "edit-update": (el) => { location.hash = `#updates.${el.dataset.update}.edit`; },
  "cancel-update": () => { location.hash = "#updates"; },
  "fill-update": () => fillUpdateFromWork(),
  "publish-update": (el) => setUpdateStatus(el.dataset.update, "published"),
  "unpublish-update": (el) => setUpdateStatus(el.dataset.update, "draft"),
  "delete-update": (el) => deleteUpdate(el.dataset.update),
  "duplicate-update": (el) => duplicateUpdate(el.dataset.update),
  "preview-update": async (el) => {
    await saveMeta();
    if (!(await flushDoc())) return toast("Save the page first (see Retry above).", true);
    location.hash = `#updates.${el.dataset.update}.preview`;
  },
  "doc-add-sheet": () => addSheet(),
  "doc-retry": () => { ED.dirty = true; saveSheet(); },
  "doc-remove-cover": async () => { if (ED.id) await act(() => updRef(ED.id).update({ cover: "", updatedAt: Date.now() }), "Cover removed"); },
});

/* ---------- Events ---------- */
document.addEventListener("mousedown", (e) => {
  // Toolbar buttons keep the caret in the page.
  if (e.target.closest?.("[data-doc-cmd], .doc-toolbar [data-pick]")) e.preventDefault();
  // Checklist boxes: a click in the box area toggles the item.
  const li = e.target.closest?.("#doc-body ul[data-checklist] > li");
  if (li && e.target === li && e.clientX - li.getBoundingClientRect().left < 28) {
    e.preventDefault();
    li.setAttribute("data-checked", li.getAttribute("data-checked") === "true" ? "false" : "true");
    markDirty();
  }
});
document.addEventListener("click", (e) => {
  if (tablePicker && !e.target.closest("#doc-tablepick, [data-doc-cmd=table]")) closeTablePicker();
  const t = e.target.closest?.("[data-doc-cmd],[data-sheet-open],[data-sheet-menu],[data-upd-menu],[data-upd-filter],[data-doc-jump]");
  if (!t || !user) return;
  const d = t.dataset;
  if (d.docJump) return document.getElementById(`sheet-${d.docJump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (d.updFilter) { updFilter = d.updFilter; return render(); }
  if (!can("manage")) return toast("Your role in this project can't do that.", true);
  if (d.docCmd) return docCmd(d.docCmd, t);
  if (d.sheetOpen) return openSheet(d.sheetOpen);
  if (d.sheetMenu) return popover.anchor === t ? closePopover() : openSheetMenu(t);
  if (d.updMenu) return popover.anchor === t ? closePopover() : openUpdateMenu(t);
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "upd-search") { updQuery = t.value; return render(); }
  if (t.dataset?.meta) return metaChanged(t);
  if (t.id !== "doc-body") return;
  // A new item of a checklist starts unchecked.
  if (e.inputType === "insertParagraph") {
    const li = closestIn(getSelection().anchorNode, "ul[data-checklist] > li");
    if (li) li.setAttribute("data-checked", "false");
  }
  markDirty();
});
document.addEventListener("change", (e) => { if (e.target.dataset?.meta) saveMeta(); });
document.addEventListener("toggle", (e) => { if (e.target.id === "doc-details") updDetailsOpen = e.target.open; }, true);
document.addEventListener("focusout", (e) => { if (e.target.id === "doc-body" && ED.dirty) saveSheet(); });
document.addEventListener("keydown", (e) => {
  if (e.target.id !== "doc-body") return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "k") { e.preventDefault(); return editLink(); }
  if (mod && k === "s") { e.preventDefault(); return saveSheet(); }
  if (mod && (k === "b" || k === "i" || k === "u")) { e.preventDefault(); exec({ b: "bold", i: "italic", u: "underline" }[k]); markDirty(); return updateToolbarState(); }
  if (mod && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); exec("redo"); return markDirty(); }
  if (mod && k === "z") { e.preventDefault(); exec("undo"); return markDirty(); }
  if (e.key === " " && !mod && autoFormat()) { e.preventDefault(); return; }
  if (e.key === "Tab") {
    const cell = closestIn(getSelection().anchorNode, "td,th");
    if (!cell) return;
    e.preventDefault();
    const cells = [...cell.closest("table").querySelectorAll("td,th")];
    let next = cells[cells.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    if (!next && !e.shiftKey) { tableOp("rowBelow"); return; }
    if (next) { const r = document.createRange(); r.selectNodeContents(next); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
});
document.addEventListener("paste", (e) => {
  if (e.target.closest?.("#doc-body") == null) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^(image|video)\//.test(f.type));
  if (files.length) { e.preventDefault(); savedRange = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : savedRange; return insertMedia(files); }
  const html = e.clipboardData?.getData("text/html");
  if (html) { e.preventDefault(); exec("insertHTML", resolveDocMedia(sanitizeHtml(html))); markDirty(); }
});
// Leaving the editor saves first: this runs before the page is redrawn (capture listener on the target).
window.addEventListener("hashchange", () => {
  if (ED.dirty && editorEl()) saveSheet();
  if (ED.id && Object.keys(ED.metaDraft).length) saveMeta();
  closeTablePicker();
}, true);
window.addEventListener("beforeunload", (e) => {
  if (ED.dirty || ED.saving) { if (ED.dirty) saveSheet(); e.preventDefault(); e.returnValue = ""; }
});
window.addEventListener("online", showDocStatus);
window.addEventListener("offline", showDocStatus);

// Drag a page in the list to reorder it.
let draggedSheet = null;
document.addEventListener("dragstart", (e) => {
  const tab = e.target.closest?.("[data-sheet-tab]");
  if (!tab) return;
  draggedSheet = tab.dataset.sheetTab;
  e.dataTransfer.setData("application/x-blackbox-sheet", draggedSheet);
  e.dataTransfer.effectAllowed = "move";
});
document.addEventListener("dragover", (e) => {
  const tab = e.target.closest?.("[data-sheet-tab]");
  if (!tab || !draggedSheet) return;
  e.preventDefault();
  $$(".sheet-tab.drop-before").forEach((x) => x !== tab && x.classList.remove("drop-before"));
  tab.classList.add("drop-before");
});
document.addEventListener("drop", (e) => {
  const tab = e.target.closest?.("[data-sheet-tab]");
  if (!tab || !draggedSheet) return;
  e.preventDefault();
  const list = liveSheets(ED.id) || [];
  moveSheet(draggedSheet, list.findIndex((x) => x.id === tab.dataset.sheetTab));
});
document.addEventListener("dragend", () => { draggedSheet = null; $$(".sheet-tab.drop-before").forEach((x) => x.classList.remove("drop-before")); });
