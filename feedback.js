"use strict";

/* ---------- Player feedback ---------- */
// Feedback the team receives from players (Discord, Roblox, YouTube…) and enters by hand.
// Stored in projects/{pid}/feedback; can be turned into a task or a bug report.
let feedbackItems = [];
let fbLoaded = false;
let fbFilter = { q: "", status: "all", category: "all", source: "all", priority: "all", sort: "newest" };
let fbEditing = null;      // null | "new" | feedback id, shown only on the page it was opened from
let fbEditingRoute = "";
let fbForm = null;         // values of the form being edited
let fbPending = [];        // uploads in progress: { id, target ("form" | feedback id), name, kind, preview, state, error }
let fbConverting = null;   // feedback id being converted

const FEEDBACK_STATUS = {
  new: { label: "New", icon: "inbox", color: "blue" },
  analyzing: { label: "Analyzing", icon: "search", color: "orange" },
  planned: { label: "Planned", icon: "calendar", color: "purple" },
  done: { label: "Done", icon: "checkSmall", color: "green" },
  archived: { label: "Archived", icon: "archive", color: "gray" },
};
const FEEDBACK_CATEGORY = {
  suggestion: { label: "Suggestion", icon: "lightbulb", color: "purple" },
  bug: { label: "Bug", icon: "bug", color: "red" },
  balance: { label: "Balance", icon: "scale", color: "orange" },
  ui: { label: "Interface", icon: "layout", color: "blue" },
};
const FEEDBACK_SOURCES = {
  discord: { label: "Discord", icon: "chat" },
  roblox: { label: "Roblox", icon: "roblox" },
  twitter: { label: "Twitter/X", icon: "at" },
  youtube: { label: "YouTube", icon: "play" },
  email: { label: "Email", icon: "mail" },
  ingame: { label: "In-game", icon: "gamepad" },
  other: { label: "Other", icon: "comment" },
};
const FB_PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
// Firebase edition: images are stored inside the document (max 1 MB), so keep a margin.
const FB_INLINE_MAX = 850 * 1024;

ACT_TYPES["feedback.create"] = ["inbox", "green", "feedback"];
ACT_TYPES["feedback.update"] = ["edit", "blue", "feedback"];
ACT_TYPES["feedback.delete"] = ["trash", "red", "feedback"];
ACT_TYPES["feedback.convert"] = ["link", "purple", "feedback"];
if (!ACT_GROUPS.feedback) ACT_GROUPS.feedback = ["Feedback", "inbox"];

const fbItem = (id) => feedbackItems.find((f) => f.id === id) || null;
const fbWhen = (f) => f.receivedAt || f.createdAt || 0;
const fbDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const pad2 = (n) => String(n).padStart(2, "0");
const fbDateInput = (ms) => { const d = new Date(ms || Date.now()); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fbParseDate = (s) => { const t = Date.parse(`${s}T12:00:00`); return Number.isFinite(t) ? t : Date.now(); };
const fbInlineSize = (atts) => (atts || []).reduce((n, a) => n + (String(a.url || "").startsWith("data:") ? a.url.length : 0), 0);
const fbLinkedTask = (f) => (f?.taskId ? tasks.find((t) => t.id === f.taskId) || null : null);

const fbStatusPill = (s) => { const v = FEEDBACK_STATUS[s] || FEEDBACK_STATUS.new; return `<span class="fb-pill c-${v.color}">${icon(v.icon, 14, 2)}${v.label}</span>`; };
const fbCategoryBadge = (c) => { const v = FEEDBACK_CATEGORY[c] || FEEDBACK_CATEGORY.suggestion; return `<span class="fb-cat c-${v.color}">${icon(v.icon, 14)}${v.label}</span>`; };
const fbSource = (s) => { const v = FEEDBACK_SOURCES[s] || FEEDBACK_SOURCES.other; return `<span class="fb-src">${icon(v.icon, 14)}${v.label}</span>`; };
const fbOptions = (map, value) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === value ? "selected" : ""}>${esc(v.label)}</option>`).join("");

function fbFiltered() {
  const q = fbFilter.q.trim().toLowerCase();
  const list = feedbackItems.filter((f) => (fbFilter.status === "all" || f.status === fbFilter.status)
    && (fbFilter.category === "all" || f.category === fbFilter.category)
    && (fbFilter.source === "all" || f.source === fbFilter.source)
    && (fbFilter.priority === "all" || f.priority === fbFilter.priority)
    && (!q || `${f.title} ${f.desc} ${f.author} ${(f.tags || []).join(" ")}`.toLowerCase().includes(q)));
  const newest = (a, b) => fbWhen(b) - fbWhen(a) || (b.createdAt || 0) - (a.createdAt || 0);
  if (fbFilter.sort === "oldest") return list.sort((a, b) => -newest(a, b));
  if (fbFilter.sort === "priority") return list.sort((a, b) => (FB_PRIORITY_RANK[a.priority] ?? 9) - (FB_PRIORITY_RANK[b.priority] ?? 9) || newest(a, b));
  return list.sort(newest);
}
const fbFiltersActive = () => !!(fbFilter.q.trim() || ["status", "category", "source", "priority"].some((k) => fbFilter[k] !== "all"));

/* ---------- Views ---------- */
function viewFeedback() {
  const r = route();
  if (fbEditing && (location.hash !== fbEditingRoute || !can("edit"))) closeFeedbackForm(false);
  if (fbEditing) return viewFeedbackForm();
  if (r.arg) return viewFeedbackDetail(r.arg);
  return viewFeedbackList();
}

function viewFeedbackList() {
  const edit = can("edit");
  const count = (s) => feedbackItems.filter((f) => f.status === s).length;
  const tile = (key, label, n, ic, color) => `<button type="button" class="fb-stat ${fbFilter.status === key ? "on" : ""}" data-action="fb-filter-status" data-status="${key}" aria-pressed="${fbFilter.status === key}">
      <span class="act-badge c-${color}">${icon(ic, 16)}</span><span class="fb-stat-text"><span class="fb-stat-n">${n}</span><span class="fb-stat-l">${label}</span></span></button>`;
  const stats = `<div class="fb-stats" role="group" aria-label="Filter by status">${tile("all", "All", feedbackItems.length, "inbox", "gray")}${Object.entries(FEEDBACK_STATUS).map(([k, v]) => tile(k, v.label, count(k), v.icon, v.color)).join("")}</div>`;
  const sel = (id, key, all, map, label) => `<select id="${id}" aria-label="${label}" data-cs-class="fb-sel"><option value="all">${all}</option>${fbOptions(map, fbFilter[key])}</select>`;
  const list = fbFiltered();
  let body;
  if (!fbLoaded) body = `<div class="empty">${icon("spinner", 20)}<span>Loading feedback…</span></div>`;
  else if (!feedbackItems.length) {
    body = `<div class="empty big-empty fb-empty">${icon("inbox", 36)}<h3>No feedback yet</h3>
      <p class="muted">Collect what players say on Discord, Roblox, YouTube or by email in one place, then turn the best ideas into tasks and bugs.</p>
      ${edit ? `<button class="btn primary" data-action="fb-new">${icon("plus", 18, 2.2)}Add the first feedback</button>` : '<p class="muted small">Members of the team add feedback here.</p>'}</div>`;
  } else if (!list.length) {
    body = `<div class="empty big-empty fb-empty">${icon("search", 32)}<h3>No feedback matches</h3><p class="muted">Try another search or remove some filters.</p><button class="btn" data-action="fb-clear">${icon("x", 16)}Clear filters</button></div>`;
  } else {
    body = `<div class="fb-list">${list.map(fbCard).join("")}</div>`;
  }
  return `${header("Feedback", "", { actions: false })}
    ${stats}
    <section class="card fb-page">
      <div class="coll-toolbar fb-toolbar">
        <label class="search fb-search">${icon("search", 16)}<input id="fb-search" placeholder="Search title, text, player, tags" value="${esc(fbFilter.q)}" autocomplete="off" aria-label="Search feedback"></label>
        ${edit ? `<button class="btn primary" data-action="fb-new">${icon("plus", 18, 2.2)}New feedback</button>` : ""}
      </div>
      <div class="fb-filters">
        ${sel("fb-f-category", "category", "All categories", FEEDBACK_CATEGORY, "Category")}
        ${sel("fb-f-source", "source", "All sources", FEEDBACK_SOURCES, "Source")}
        ${sel("fb-f-priority", "priority", "All priorities", PRIORITY, "Priority")}
        <select id="fb-f-sort" aria-label="Sort" data-cs-class="fb-sel">${[["newest", "Newest first"], ["oldest", "Oldest first"], ["priority", "Priority"]].map(([k, l]) => `<option value="${k}" ${fbFilter.sort === k ? "selected" : ""}>Sort: ${l}</option>`).join("")}</select>
        ${fbFiltersActive() ? `<button type="button" class="link small fb-clear" data-action="fb-clear">${icon("x", 14)}Clear filters</button>` : ""}
        <span class="spacer"></span>
        ${fbLoaded && feedbackItems.length ? `<span class="muted small nowrap fb-count">${list.length} of ${feedbackItems.length}</span>` : ""}
      </div>
      ${body}
    </section>`;
}

function fbCard(f) {
  const n = (f.attachments || []).length;
  const linked = fbLinkedTask(f);
  return `<a class="fb-card" href="#feedback.${esc(f.id)}" data-fb="${esc(f.id)}">
    <div class="fb-card-main">
      <div class="fb-card-top">${fbCategoryBadge(f.category)}${priorityPill(f.priority || "medium")}</div>
      <div class="fb-title">${esc(f.title)}</div>
      ${f.desc ? `<div class="fb-desc">${esc(f.desc)}</div>` : ""}
      <div class="fb-meta">
        ${fbSource(f.source)}
        ${f.author ? `<span class="fb-author">${icon("user", 14)}${esc(f.author)}</span>` : ""}
        <span>${icon("calendar", 14)}${esc(fbDate(fbWhen(f)))}</span>
        ${n ? `<span title="${n} attachment${n === 1 ? "" : "s"}">${icon("paperclip", 14)}${n}</span>` : ""}
        ${linked ? `<span class="fb-linked">${icon(linked.type === "bug" ? "bug" : "link", 14)}${linked.type === "bug" ? "Bug" : "Task"}</span>` : ""}
        ${(f.tags || []).slice(0, 4).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("")}
      </div>
    </div>
    <div class="fb-card-side">${fbStatusPill(f.status)}</div>
  </a>`;
}

function fbPendingHtml(target) {
  const list = fbPending.filter((p) => p.target === target);
  if (!list.length) return "";
  return `<div class="fb-pending">${list.map((p) => `<div class="fb-pend ${p.state}">
      <span class="fb-pend-thumb">${p.preview ? (p.kind === "video" ? `<video src="${esc(p.preview)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(p.preview)}" alt="">`) : icon("file", 20)}</span>
      <span class="fb-pend-text"><b class="ellipsis">${esc(p.name)}</b><span class="small ${p.state === "failed" ? "danger-text" : "muted"}">${p.state === "failed" ? esc(p.error || "Upload failed") : `${icon("spinner", 12)} Uploading…`}</span></span>
      ${p.state === "failed" ? `<button type="button" class="icon-btn bare tiny" data-action="fb-remove-pending" data-id="${esc(p.id)}" title="Dismiss">${icon("x", 13)}</button>` : ""}
    </div>`).join("")}</div>`;
}

function viewFeedbackDetail(id) {
  const f = fbItem(id);
  if (!f) {
    return `${header("Feedback", "", { actions: false })}<section class="card"><div class="empty big-empty">${icon(fbLoaded ? "inbox" : "spinner", 32)}<h3>${fbLoaded ? "This feedback no longer exists" : "Loading feedback…"}</h3>${fbLoaded ? `<a class="link" href="#feedback">${icon("arrow", 15)}All feedback</a>` : ""}</div></section>`;
  }
  const edit = can("edit");
  const linked = fbLinkedTask(f);
  const lost = f.taskId && !linked;
  const busy = fbConverting === f.id;
  const history = activity.filter((a) => a.ref === `feedback:${f.id}`).slice(0, 8);
  const linkCard = linked
    ? `<div class="fb-link-card">${icon(linked.type === "bug" ? "bug" : "link", 18)}<span class="min0">Linked ${linked.type === "bug" ? "bug" : "task"}: <a class="link" href="${linked.type === "bug" ? `#bugs.${esc(linked.id)}` : "#tasks"}">${esc(linked.title)}</a></span>
        <span class="spacer"></span><a class="btn small" href="${linked.type === "bug" ? `#bugs.${esc(linked.id)}` : "#tasks"}">Open</a></div>`
    : edit
      ? `<div class="fb-convert">${lost ? `<span class="muted small">The linked task was deleted.</span>` : ""}
          <button class="btn small" data-action="fb-convert" data-type="task" data-id="${esc(f.id)}" ${busy ? "disabled" : ""}>${icon(busy ? "spinner" : "check", 15)}Convert to task</button>
          <button class="btn small" data-action="fb-convert" data-type="bug" data-id="${esc(f.id)}" ${busy ? "disabled" : ""}>${icon(busy ? "spinner" : "bug", 15)}Convert to bug report</button></div>`
      : "";
  return `${header(f.title, "Feedback", { actions: false })}
    <div class="fb-detail">
      <div class="col">
        <section class="card fb-main">
          <div class="card-body fb-body">
            <div class="row-gap">${fbCategoryBadge(f.category)}${priorityPill(f.priority || "medium")}${fbStatusPill(f.status)}${(f.tags || []).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>
            ${f.desc ? `<div class="fb-text">${esc(f.desc)}</div>` : '<p class="muted">No description.</p>'}
            <div class="fb-atts" ${edit ? 'data-drop="feedback-files"' : ""}>
              <div class="side-label">Attachments · ${(f.attachments || []).length}</div>
              ${attachmentsHtml(f.attachments) || (edit ? "" : '<p class="muted small">No attachments.</p>')}
              ${fbPendingHtml(f.id)}
              ${edit ? `<button type="button" class="dropzone fb-drop" data-pick="feedback-files" data-drop="feedback-files">${icon("upload", 22)}<b>Add screenshots or videos</b><span class="muted small">Drop files here or <span class="link">choose files</span></span></button>` : ""}
            </div>
            <div class="row-gap fb-actions">
              ${edit ? `<button class="btn small" data-action="fb-edit" data-id="${esc(f.id)}">${icon("edit", 15)}Edit</button>` : ""}
              ${canDelete(f.createdBy) ? `<button class="btn small danger" data-action="fb-delete" data-id="${esc(f.id)}">${icon("trash", 15)}Delete</button>` : ""}
              <span class="spacer"></span><a class="link small" href="#feedback">${icon("arrow", 14)}All feedback</a>
            </div>
          </div>
        </section>
        ${typeof commentsHtml === "function" ? `<section class="card fb-comments"><div class="card-head"><h2>Comments</h2></div><div class="card-body">${commentsHtml(`feedback:${f.id}`)}</div></section>` : ""}
      </div>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Details</h2></div>
          <div class="card-body">
            <dl class="fb-dl">
              <dt>Player</dt><dd>${f.author ? esc(f.author) : '<span class="muted">Unknown</span>'}</dd>
              <dt>Source</dt><dd>${fbSource(f.source)}</dd>
              <dt>Received</dt><dd>${esc(fbDate(fbWhen(f)))}</dd>
              <dt>Added by</dt><dd><span class="owner">${avatar(f.createdBy, 22)}<span class="ellipsis">${esc(memberName(f.createdBy))}</span></span></dd>
              ${f.updatedAt ? `<dt>Updated</dt><dd>${esc(timeAgo(f.updatedAt))}</dd>` : ""}
            </dl>
            <div class="side-label spaced-sm">Status</div>
            <div class="fb-status-pick" role="group" aria-label="Status">${Object.entries(FEEDBACK_STATUS).map(([k, v]) => `<button type="button" class="chip ${f.status === k ? "on" : ""}" data-action="fb-set-status" data-id="${esc(f.id)}" data-status="${k}" ${edit ? "" : "disabled"} aria-pressed="${f.status === k}">${icon(v.icon, 14)}${v.label}</button>`).join("")}</div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Task or bug</h2></div>
          <div class="card-body">${linkCard || '<p class="muted small">Not linked to a task yet.</p>'}</div>
        </section>
        ${history.length ? `<section class="card"><div class="card-head"><h2>History</h2></div><div class="card-body">${activityMini(history)}</div></section>` : ""}
      </div>
    </div>`;
}

function viewFeedbackForm() {
  const v = fbForm;
  const isNew = fbEditing === "new";
  const uploading = fbPending.some((p) => p.target === "form" && p.state === "uploading");
  const atts = v.attachments.map((a, i) => {
    const kind = mediaKind(a.type);
    const url = kind === "image" ? safeUrl(a.url) || mediaSrc(a.url) : mediaSrc(a.url);
    return `<div class="fb-att-edit"><span class="fb-pend-thumb">${url ? (kind === "video" ? `<video src="${esc(url)}" muted playsinline preload="metadata"></video>` : kind === "image" ? `<img src="${esc(url)}" alt="">` : icon("file", 20)) : icon(kind === "video" ? "video" : "file", 20)}</span>
      <span class="fb-pend-text"><b class="ellipsis">${esc(a.name)}</b><span class="muted small">${kind === "video" ? "Video" : kind === "image" ? "Image" : "File"}${a.size ? ` · ${formatSize(a.size)}` : ""}</span></span>
      <button type="button" class="icon-btn bare tiny" data-action="fb-remove-att" data-index="${i}" title="Remove">${icon("x", 13)}</button></div>`;
  }).join("");
  return `${header(isNew ? "New feedback" : "Edit feedback", "Feedback", { actions: false })}
    <form class="card fb-form" data-form="feedback" novalidate>
      <div class="card-body settings">
        <label>Title<input class="input" id="fb-in-title" name="title" required maxlength="120" value="${esc(v.title)}" placeholder="Let us trade duplicate dice" autocomplete="off"></label>
        <label>Description<textarea class="input" id="fb-in-desc" name="desc" rows="6" maxlength="4000" placeholder="What the player said, in their words">${esc(v.desc)}</textarea></label>
        <div class="fb-form-grid">
          <label>Player<input class="input" id="fb-in-author" name="author" maxlength="60" value="${esc(v.author)}" placeholder="Player name" autocomplete="off"></label>
          <label>Source<select id="fb-in-source" name="source">${fbOptions(FEEDBACK_SOURCES, v.source)}</select></label>
          <label>Received on<input class="input" type="date" id="fb-in-date" name="date" value="${esc(v.date)}"></label>
          <label>Category<select id="fb-in-category" name="category">${fbOptions(FEEDBACK_CATEGORY, v.category)}</select></label>
          <label>Priority<select id="fb-in-priority" name="priority">${fbOptions(PRIORITY, v.priority)}</select></label>
          <label>Status<select id="fb-in-status" name="status">${fbOptions(FEEDBACK_STATUS, v.status)}</select></label>
        </div>
        <label>Tags <span class="hint">comma separated, optional</span><input class="input" id="fb-in-tags" name="tags" maxlength="200" value="${esc(v.tags)}" placeholder="trading, inventory" autocomplete="off"></label>
        <div class="field">
          <span>Attachments <span class="hint">images and videos</span></span>
          ${atts ? `<div class="fb-pending">${atts}</div>` : ""}
          ${fbPendingHtml("form")}
          <button type="button" class="dropzone fb-drop" data-pick="feedback-files" data-drop="feedback-files">${icon("upload", 22)}<b>Add screenshots or videos</b><span class="muted small">Drop files here or <span class="link">choose files</span>${ARTIFACT ? " · up to 20 MB each" : " · videos up to 25 MB"}</span></button>
        </div>
      </div>
      <div class="dialog-actions fb-form-actions">
        ${uploading ? `<span class="muted small">${icon("spinner", 14)} Waiting for uploads to finish…</span>` : ""}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" data-action="fb-cancel">Cancel</button>
        <button type="submit" class="btn primary" id="fb-save" ${uploading ? "disabled" : ""}>${isNew ? "Add feedback" : "Save changes"}</button>
      </div>
    </form>`;
}

/* ---------- Editing ---------- */
function openFeedbackForm(id = null) {
  if (!can("edit")) return toast("Your role in this project can't do that.", true);
  const f = id ? fbItem(id) : null;
  if (id && !f) return;
  fbEditing = f ? f.id : "new";
  fbForm = {
    title: f?.title || "", desc: f?.desc || "", author: f?.author || "", source: f?.source || "discord",
    date: fbDateInput(f ? fbWhen(f) : Date.now()), category: f?.category || "suggestion", priority: f?.priority || "medium",
    status: f?.status || "new", tags: (f?.tags || []).join(", "), attachments: [...(f?.attachments || [])],
  };
  fbPending = fbPending.filter((p) => p.target !== "form");
  const want = f ? `#feedback.${f.id}` : "#feedback";
  fbEditingRoute = want;
  if (location.hash !== want) location.hash = want; else render();
  setTimeout(() => $("#fb-in-title")?.focus(), 50);
}
function closeFeedbackForm(rerender = true) {
  fbEditing = null;
  fbForm = null;
  fbEditingRoute = "";
  fbPending.filter((p) => p.target === "form" && p.preview).forEach((p) => URL.revokeObjectURL(p.preview));
  fbPending = fbPending.filter((p) => p.target !== "form");
  if (rerender) render();
}

function fbChanges(before, after) {
  const out = [];
  const fmt = {
    source: (v) => FEEDBACK_SOURCES[v]?.label, category: (v) => FEEDBACK_CATEGORY[v]?.label, priority: (v) => PRIORITY[v]?.label,
    status: (v) => FEEDBACK_STATUS[v]?.label, receivedAt: (v) => fbDate(v), tags: (v) => (v || []).join(", "),
    attachments: (v) => `${(v || []).length} file${(v || []).length === 1 ? "" : "s"}`,
  };
  const names = { title: "Title", desc: "Description", author: "Player", source: "Source", receivedAt: "Received", category: "Category", priority: "Priority", status: "Status", tags: "Tags", attachments: "Attachments" };
  for (const [k, label] of Object.entries(names)) {
    const f = fmt[k] || ((x) => x);
    const a = String(f(before[k]) ?? "");
    const b = String(f(after[k]) ?? "");
    if (k === "attachments" ? JSON.stringify((before[k] || []).map((x) => x.url)) === JSON.stringify((after[k] || []).map((x) => x.url)) : a === b) continue;
    out.push({ field: label, from: k === "desc" ? "" : a.slice(0, 80), to: k === "desc" ? "edited" : b.slice(0, 80) });
  }
  return out;
}

async function saveFeedbackForm() {
  if (!fbForm || !can("edit")) return;
  if (fbPending.some((p) => p.target === "form" && p.state === "uploading")) return toast("Wait for the uploads to finish.", true);
  const v = fbForm;
  const data = {
    title: v.title.trim().slice(0, 120), desc: v.desc.trim().slice(0, 4000), author: v.author.trim().slice(0, 60),
    source: FEEDBACK_SOURCES[v.source] ? v.source : "other", receivedAt: fbParseDate(v.date),
    category: FEEDBACK_CATEGORY[v.category] ? v.category : "suggestion", priority: PRIORITY[v.priority] ? v.priority : "medium",
    status: FEEDBACK_STATUS[v.status] ? v.status : "new", tags: splitList(v.tags), attachments: v.attachments, updatedAt: Date.now(),
  };
  if (!data.title) { toast("Give the feedback a title.", true); $("#fb-in-title")?.focus(); return; }
  if (fbInlineSize(data.attachments) > FB_INLINE_MAX) return toast("These images are too large to save together. Remove one or two.", true);
  if (fbEditing === "new") {
    const ref = await act(() => sub("feedback").add({ ...data, createdBy: user.uid, createdAt: Date.now() }), "Feedback added");
    if (!ref) return;
    log("feedback.create", "added feedback", data.title, "Feedback", { ref: `feedback:${ref.id}` });
    closeFeedbackForm(false);
    location.hash = `#feedback.${ref.id}`;
    render();
    return;
  }
  const id = fbEditing;
  const before = fbItem(id);
  if (!before) { closeFeedbackForm(); return toast("This feedback no longer exists.", true); }
  const changes = fbChanges(before, data);
  if (!changes.length) { closeFeedbackForm(); return; }
  if (await act(() => sub("feedback").doc(id).update(data), "Feedback saved")) {
    log("feedback.update", "updated feedback", data.title, "Feedback", { changes, ref: `feedback:${id}` });
    closeFeedbackForm();
  }
}

async function setFeedbackStatus(id, status) {
  const f = fbItem(id);
  if (!f || f.status === status || !FEEDBACK_STATUS[status] || !can("edit")) return;
  if (await act(() => sub("feedback").doc(id).update({ status, updatedAt: Date.now() }))) {
    log("feedback.update", `marked as ${FEEDBACK_STATUS[status].label.toLowerCase()}`, f.title, "Feedback", { changes: [{ field: "Status", from: FEEDBACK_STATUS[f.status]?.label || "", to: FEEDBACK_STATUS[status].label }], ref: `feedback:${id}` });
  }
}

async function deleteFeedback(id) {
  const f = fbItem(id);
  if (!f) return;
  if (!canDelete(f.createdBy)) return toast("Only the person who added it or an admin can delete it.", true);
  if (!(await ask({ title: `Delete "${f.title}"?`, text: f.taskId ? "The task or bug made from it stays." : "This removes it for the whole team.", ok: "Delete", danger: true }))) return;
  if (await act(() => sub("feedback").doc(id).delete(), "Feedback deleted")) {
    log("feedback.delete", "deleted feedback", f.title, "Feedback", { ref: `feedback:${id}` });
    if (route().name === "feedback" && route().arg === id) location.hash = "#feedback";
  }
}

/* ---------- Convert to a task or a bug report ---------- */
function fbSteps(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter((l) => /^(\d+[.)]|[-*•])\s+/.test(l));
  return lines.length >= 2 ? lines.map((l) => l.replace(/^(\d+[.)]|[-*•])\s+/, "")).map((l, i) => `${i + 1}. ${l}`).join("\n") : "";
}
async function convertFeedback(id, type) {
  const f = fbItem(id);
  if (!f || !can("edit") || fbConverting) return;
  const existing = fbLinkedTask(f);
  if (existing) { location.hash = existing.type === "bug" ? `#bugs.${existing.id}` : "#tasks"; return; }
  // The tasks list may still be loading: never create a second task for the same feedback.
  if (f.taskId) {
    const snap = await sub("tasks").doc(f.taskId).get().catch(() => null);
    if (snap?.exists) { location.hash = snap.data().type === "bug" ? `#bugs.${f.taskId}` : "#tasks"; return; }
  }
  const kind = type === "bug" ? "bug report" : "task";
  if (!(await ask({ title: `Create a ${kind}?`, text: `A ${kind} named "${f.title}" is added${type === "bug" ? " with the description and attachments" : ""}, linked to this feedback.`, ok: `Create ${kind}` }))) return;
  const by = [f.author, FEEDBACK_SOURCES[f.source]?.label].filter(Boolean).join(" on ");
  const summary = (f.desc || "").split("\n")[0].slice(0, 140);
  const base = {
    title: f.title.slice(0, 80), desc: summary || `Player feedback${by ? ` from ${by}` : ""}`, type, priority: f.priority || "medium", status: "todo", owner: "",
    feedbackId: id, links: [{ kind: "feedback", id }],
  };
  const bugFields = type === "bug" ? {
    steps: fbSteps(f.desc), expected: "", actual: f.desc || "", severity: f.priority === "critical" ? "blocker" : f.priority === "high" ? "major" : f.priority === "low" ? "trivial" : "minor",
    frequency: "sometimes", platform: "", device: "", gameVersion: "", reporter: user.uid, attachments: [...(f.attachments || [])],
  } : {};
  fbConverting = id;
  render();
  const taskId = await act(async () => {
    let newId;
    if (typeof createTaskFrom === "function") newId = await createTaskFrom({ ...base, ...bugFields });
    else {
      const order = Math.max(0, ...tasks.map((t) => t.order ?? 0)) + 1;
      const ref = await sub("tasks").add({ ...base, ...bugFields, order, createdBy: user.uid, createdAt: Date.now() });
      newId = ref.id;
      if (type === "bug") log("bug.report", "reported a new bug", "", "Bugs", { detail: base.title, ref: `task:${newId}` });
      else log("task.create", "created", base.title, "Tasks", { ref: `task:${newId}` });
    }
    if (!newId) throw fail("unavailable", `The ${kind} couldn't be created.`);
    const patchData = { taskId: newId, updatedAt: Date.now() };
    if (["new", "analyzing"].includes(fbItem(id)?.status || f.status)) patchData.status = "planned";
    await sub("feedback").doc(id).update(patchData);
    return newId;
  }, type === "bug" ? "Bug report created" : "Task created");
  fbConverting = null;
  if (taskId) log("feedback.convert", type === "bug" ? "turned feedback into a bug report" : "turned feedback into a task", f.title, "Feedback", { ref: `feedback:${id}` });
  render();
}

/* ---------- Attachments ---------- */
async function addFeedbackFiles(files) {
  const r = route();
  const target = fbEditing && fbForm ? "form" : r.name === "feedback" && fbItem(r.arg) ? r.arg : null;
  if (!target) return;
  const ok = files.filter((f) => ["image", "video"].includes(mediaKind(f.type)));
  if (ok.length < files.length) toast("Only images and videos can be attached.", true);
  await Promise.all(ok.map(async (file) => {
    const kind = mediaKind(file.type);
    const p = { id: Math.random().toString(36).slice(2), target, name: file.name, kind, preview: URL.createObjectURL(file), state: "uploading" };
    fbPending.push(p);
    render();
    const up = await act(async () => {
      const res = await storeFile(file, "feedback");
      const current = target === "form" ? fbForm?.attachments : fbItem(target)?.attachments;
      if (!current) throw fail("not-found", "This feedback is no longer open.");
      if (fbInlineSize([...current, res]) > FB_INLINE_MAX) throw fail("too_large", "This feedback can't hold more images. Remove one, or add the image to a comment.");
      if (target !== "form") await sub("feedback").doc(target).update({ attachments: [...current, res], updatedAt: Date.now() });
      return res;
    });
    if (up) {
      if (target === "form" && fbForm) fbForm.attachments.push(up);
      if (target !== "form") log("feedback.update", `attached ${file.name}`, fbItem(target)?.title || "", "Feedback", { ref: `feedback:${target}` });
      URL.revokeObjectURL(p.preview);
      fbPending = fbPending.filter((x) => x !== p);
    } else {
      p.state = "failed";
      p.error = "Couldn't upload this file.";
    }
    render();
  }));
}

FILE_TARGETS["feedback-files"] = (files) => addFeedbackFiles(files);
FILE_TARGET_PERMS["feedback-files"] = "edit";
PICK_MULTI.add("feedback-files");
PICK_ACCEPT["feedback-files"] = () => "image/*,video/*";

/* ---------- Events ---------- */
Object.assign(actions, {
  "fb-new": () => openFeedbackForm(null),
  "fb-edit": (el) => openFeedbackForm(el.dataset.id),
  "fb-cancel": () => closeFeedbackForm(),
  "fb-delete": (el) => deleteFeedback(el.dataset.id),
  "fb-convert": (el) => convertFeedback(el.dataset.id, el.dataset.type === "bug" ? "bug" : "task"),
  "fb-set-status": (el) => setFeedbackStatus(el.dataset.id, el.dataset.status),
  "fb-filter-status": (el) => { fbFilter.status = el.dataset.status; render(); },
  "fb-clear": () => { fbFilter = { ...fbFilter, q: "", status: "all", category: "all", source: "all", priority: "all" }; render(); },
  "fb-remove-att": (el) => { if (fbForm) { fbForm.attachments.splice(+el.dataset.index, 1); render(); } },
  "fb-remove-pending": (el) => {
    const p = fbPending.find((x) => x.id === el.dataset.id);
    if (p?.preview) URL.revokeObjectURL(p.preview);
    fbPending = fbPending.filter((x) => x !== p);
    render();
  },
});
Object.assign(ACTION_PERMS, { "fb-new": "edit", "fb-edit": "edit", "fb-convert": "edit", "fb-set-status": "edit", "fb-remove-att": "edit" });

const FB_FIELD = { "fb-in-title": "title", "fb-in-desc": "desc", "fb-in-author": "author", "fb-in-source": "source", "fb-in-date": "date", "fb-in-category": "category", "fb-in-priority": "priority", "fb-in-status": "status", "fb-in-tags": "tags" };
const FB_FILTER = { "fb-f-category": "category", "fb-f-source": "source", "fb-f-priority": "priority", "fb-f-sort": "sort" };
function fbFieldEvent(e) {
  const t = e.target;
  if (FB_FIELD[t.id] && fbForm) { fbForm[FB_FIELD[t.id]] = t.value; return; }
  if (t.id === "fb-search" && e.type === "input") { fbFilter.q = t.value; render(); return; }
  if (FB_FILTER[t.id] && e.type === "change") { fbFilter[FB_FILTER[t.id]] = t.value; render(); }
}
document.addEventListener("input", fbFieldEvent);
document.addEventListener("change", fbFieldEvent);
document.addEventListener("submit", (e) => {
  if (e.target.dataset?.form !== "feedback") return;
  e.preventDefault();
  saveFeedbackForm();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && fbEditing && e.target.closest?.(".fb-form") && !document.querySelector("dialog[open]") && (!popover.el || popover.el.hidden)) { e.preventDefault(); closeFeedbackForm(); }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.closest?.(".fb-form")) { e.preventDefault(); saveFeedbackForm(); }
});

function openFeedback(id) {
  if (!id) return;
  location.hash = `#feedback.${id}`;
}

/* ---------- Module plumbing ---------- */
registerView("feedback", viewFeedback);
onProject(() => listen(() => sub("feedback"), (snap) => {
  feedbackItems = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => fbWhen(b) - fbWhen(a));
  fbLoaded = true;
  scheduleRender();
}));
onProjectReset(() => {
  feedbackItems = [];
  fbLoaded = false;
  fbFilter = { q: "", status: "all", category: "all", source: "all", priority: "all", sort: "newest" };
  fbPending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
  fbPending = [];
  fbConverting = null;
  fbEditing = null; fbForm = null; fbEditingRoute = "";
});
PROJECT_SUBCOLLECTIONS.push("feedback");
