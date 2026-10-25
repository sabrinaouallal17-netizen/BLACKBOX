"use strict";

/* ---------- Bugs: report form, detail page, links, history and comments ---------- */
// Bugs are tasks with type "bug" (projects/{pid}/tasks). They use the same status keys as tasks,
// shown as Open / In progress / To test / Resolved. Comments (projects/{pid}/comments) are shared
// with feedback: commentsHtml("task:<id>") or commentsHtml("feedback:<id>").

const BUG_STATUS = {
  todo: { label: "Open", icon: "alert" },
  progress: { label: "In progress", icon: "wrench" },
  review: { label: "To test", icon: "eye" },
  done: { label: "Resolved", icon: "circleCheck" },
};
const bugStatusLabel = (s) => BUG_STATUS[s]?.label || STATUS[s]?.label || String(s || "");
const BUG_SEVERITY = {
  blocker: { label: "Blocker", icon: "alert" },
  major: { label: "Major", icon: "chevronsUp" },
  minor: { label: "Minor", icon: "minus" },
  trivial: { label: "Trivial", icon: "chevronsDown" },
};
const BUG_FREQUENCY = {
  always: { label: "Always" }, often: { label: "Often" }, sometimes: { label: "Sometimes" }, rare: { label: "Rare" },
};
const BUG_KEYS = ["steps", "expected", "actual", "severity", "frequency", "platform", "device", "gameVersion", "reporter"];
const BUG_FIELD_NAMES = { steps: "Steps", expected: "Expected result", actual: "Actual result", severity: "Severity", frequency: "Frequency", platform: "Platform", device: "Device", gameVersion: "Game version", reporter: "Reporter" };
const LINK_KINDS = {
  task: { label: "Task", icon: "file" },
  bug: { label: "Bug", icon: "bug" },
  feedback: { label: "Feedback", icon: "inbox" },
  update: { label: "Update", icon: "history" },
};

Object.assign(ACT_TYPES, {
  "bug.reopen": ["reopen", "orange", "bugs"],
  "bug.comment": ["comment", "blue", "bugs"],
  "task.comment": ["comment", "blue", "tasks"],
  "bug.link": ["link", "purple", "bugs"],
});

let comments = [];          // every comment of the open project, oldest first
let bugForm = { id: null, kept: [], pending: [], busy: false, ro: false };
const cmPending = {};       // comment target -> files waiting to be sent [{ id, file, preview, kind }]
const cmSending = {};       // comment target -> true while sending
let cmEditing = null;       // id of the comment being edited
let bugHist = { key: null, list: [], unsub: null };
let linkPicker = null;      // id of the bug whose "Add link" picker is open
let linkQuery = "";
let bugsOpenedAt = 0;

PROJECT_SUBCOLLECTIONS.push("comments");
onProject(() => {
  bugsOpenedAt = Date.now();
  setTimeout(scheduleRender, 4000); // ends the "Loading…" state of a bug page in an empty project
  return listen(() => sub("comments").orderBy("at"), (snap) => {
    comments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    scheduleRender();
  });
});
onProjectReset(() => {
  comments = [];
  cmEditing = null;
  linkPicker = null;
  linkQuery = "";
  for (const k of Object.keys(cmPending)) { cmPending[k].forEach((f) => f.preview && URL.revokeObjectURL(f.preview)); delete cmPending[k]; }
  stopBugHistory();
});

/* ---------- Small fragments ---------- */
const severityBadge = (s, small = false) => BUG_SEVERITY[s]
  ? `<span class="sev sev-${esc(s)} ${small ? "small" : ""}" title="Severity: ${BUG_SEVERITY[s].label}">${icon(BUG_SEVERITY[s].icon, small ? 12 : 14, 2.2)}${BUG_SEVERITY[s].label}</span>` : "";
const frequencyBadge = (f) => BUG_FREQUENCY[f] ? `<span class="freq" title="Frequency">${icon("repeat", 14)}${BUG_FREQUENCY[f].label}</span>` : "";
const envHint = (t) => [t.platform, t.device, t.gameVersion ? `v${String(t.gameVersion).replace(/^v/i, "")}` : ""].filter(Boolean).join(" · ");
const commentCount = (target) => comments.filter((c) => c.target === target).length;

// Extra line under a bug's title in the list: severity, environment, comments.
function bugRowMeta(t) {
  const n = commentCount(`task:${t.id}`);
  const env = envHint(t);
  const bits = [severityBadge(t.severity, true), env ? `<span class="bug-env-hint ellipsis">${icon("monitor", 13)}${esc(env)}</span>` : "", n ? `<span class="bug-cm-count">${icon("comment", 13)}${n}</span>` : "", (t.attachments || []).length ? `<span class="bug-cm-count">${icon("paperclip", 13)}${t.attachments.length}</span>` : ""].filter(Boolean);
  return bits.length ? `<div class="bug-row-meta">${bits.join("")}</div>` : "";
}

const openBug = (id) => { location.hash = `#bugs.${id}`; };

/* ---------- Creating a task or bug from elsewhere (feedback) ---------- */
async function createTaskFrom(o = {}) {
  if (!currentId || !can("edit")) { toast("Your role in this project can't do that.", true); return null; }
  const type = o.type === "bug" ? "bug" : "task";
  const links = (Array.isArray(o.links) ? o.links : []).filter((l) => l && LINK_KINDS[l.kind] && l.id);
  if (o.feedbackId && !links.some((l) => l.kind === "feedback" && l.id === o.feedbackId)) links.push({ kind: "feedback", id: o.feedbackId });
  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  const data = {
    title: str(o.title, 80) || "Untitled",
    desc: str(o.desc, 2000),
    type,
    priority: PRIORITY[o.priority] ? o.priority : "medium",
    status: "todo",
    owner: o.owner && project()?.memberIds?.includes(o.owner) ? o.owner : "",
    order: Math.max(0, ...tasks.map((t) => t.order ?? 0)) + 1,
    links,
    createdBy: user.uid,
    createdAt: Date.now(),
  };
  if (o.feedbackId) data.feedbackId = o.feedbackId;
  if (Array.isArray(o.attachments) && o.attachments.length) data.attachments = o.attachments.slice(0, 20);
  if (type === "bug") {
    Object.assign(data, {
      steps: str(o.steps, 3000), expected: str(o.expected, 1000), actual: str(o.actual, 1000),
      severity: BUG_SEVERITY[o.severity] ? o.severity : "major",
      frequency: BUG_FREQUENCY[o.frequency] ? o.frequency : "sometimes",
      platform: str(o.platform, 40), device: str(o.device, 60), gameVersion: str(o.gameVersion, 30),
      reporter: o.reporter || user.uid,
      attachments: data.attachments || [],
    });
  }
  const ref = await act(() => sub("tasks").add(data));
  if (!ref) return null;
  const extra = { ref: `task:${ref.id}`, ...(o.feedbackId ? { detail: "from player feedback" } : {}) };
  if (type === "bug") log("bug.report", "reported a new bug", "", "Bugs", { ...extra, detail: data.title });
  else log("task.create", "created", data.title, "Tasks", extra);
  if (data.owner) notify(data.owner, "assign", data.title, type === "bug" ? `#bugs.${ref.id}` : "#tasks");
  return ref.id;
}

/* ---------- Bug fields in the task dialog ---------- */
function bugFormOpen(t, v, ro) {
  const f = taskForm;
  const p = project();
  bugForm.pending.forEach((x) => x.preview && URL.revokeObjectURL(x.preview));
  bugForm = { id: t?.id || null, kept: [...(t?.attachments || [])], pending: [], busy: false, ro };
  f.elements.steps.value = v.steps || "";
  f.elements.expected.value = v.expected || "";
  f.elements.actual.value = v.actual || "";
  f.elements.severity.value = BUG_SEVERITY[v.severity] ? v.severity : "major";
  f.elements.frequency.value = BUG_FREQUENCY[v.frequency] ? v.frequency : "sometimes";
  f.elements.platform.value = v.platform ?? (!t && p.platforms?.length === 1 ? p.platforms[0] : "");
  f.elements.device.value = v.device || "";
  f.elements.gameVersion.value = v.gameVersion || "";
  const reporter = v.reporter || t?.createdBy || user.uid;
  const people = [...new Set([...p.memberIds, reporter])];
  $("#bug-reporter").innerHTML = people.map((id) => `<option value="${esc(id)}">${esc(memberName(id))}${id === user.uid ? " (you)" : ""}</option>`).join("");
  $("#bug-reporter").value = reporter;
  $("#bug-platforms").innerHTML = (p.platforms || []).map((x) => `<option value="${esc(x)}"></option>`).join("");
  syncBugForm(v.type);
}
function syncBugForm(type) {
  const bug = type === "bug";
  $$(".bug-only", taskForm).forEach((el) => { el.hidden = !bug; });
  taskDialog.classList.toggle("wide-dialog", bug);
  taskDialog.classList.toggle("bug-dialog", bug);
  $("#task-owner-label").textContent = bug ? "Responsible for the fix" : "Owner";
  $("#task-owner").options[0] && ($("#task-owner").options[0].textContent = "Unassigned");
  for (const o of taskForm.elements.status.options) o.textContent = statusLabel(o.value, type);
  const t = bugForm.id;
  $("#task-dialog-title").textContent = bugForm.ro ? (bug ? "Bug" : "Task") : t ? (bug ? "Edit bug" : "Edit task") : bug ? "Report a bug" : "New task";
  renderBugAtts();
  refreshSelects(taskForm);
}
function attThumb(a, preview) {
  const kind = mediaKind(a.type);
  const url = preview || (kind === "image" ? mediaSrc(a.url) : "");
  if (kind === "image" && url) return `<img src="${esc(url)}" alt="">`;
  if (kind === "video" && preview) return `<video src="${esc(preview)}" muted playsinline preload="metadata"></video>`;
  return icon(kind === "video" ? "video" : kind === "audio" ? "mic" : "file", 20);
}
function renderBugAtts() {
  const box = $("#bug-atts");
  if (!box) return;
  const ro = bugForm.ro;
  const busy = bugForm.busy;
  const kept = bugForm.kept.map((a, i) => `<div class="bug-att"><span class="bug-att-thumb">${attThumb(a)}</span><span class="bug-att-text"><b class="ellipsis">${esc(a.name || "file")}</b><span class="muted small">${formatSize(a.size || 0)}</span></span>
      ${ro || busy ? "" : `<button type="button" class="icon-btn bare tiny" data-bug-att-remove="kept:${i}" title="Remove attachment">${icon("x", 14)}</button>`}</div>`);
  const pend = bugForm.pending.map((f) => `<div class="bug-att pending"><span class="bug-att-thumb">${attThumb({ type: f.file.type }, f.preview)}</span><span class="bug-att-text"><b class="ellipsis">${esc(f.file.name)}</b><span class="muted small">${busy ? `${icon("spinner", 12)} Uploading…` : `${formatSize(f.file.size)} · uploads when you save`}</span></span>
      ${busy ? "" : `<button type="button" class="icon-btn bare tiny" data-bug-att-remove="pending:${esc(f.id)}" title="Remove">${icon("x", 14)}</button>`}</div>`);
  const list = [...kept, ...pend];
  box.innerHTML = `${list.length ? `<div class="bug-att-list">${list.join("")}</div>` : ro ? '<p class="muted small">No attachments.</p>' : ""}
    ${ro ? "" : `<button type="button" class="bug-drop" data-drop="bug-files" data-pick="bug-files" ${busy ? "disabled" : ""}>${icon("upload", 20)}<span>Drop screenshots, videos or files here, or <span class="link">browse</span></span></button>`}`;
}
const newPending = (file) => {
  const kind = mediaKind(file.type);
  return { id: Math.random().toString(36).slice(2), file, kind, preview: kind === "image" || kind === "video" ? URL.createObjectURL(file) : "" };
};
FILE_TARGETS["bug-files"] = (files) => {
  if (!taskDialog.open) return;
  const room = 20 - bugForm.kept.length - bugForm.pending.length;
  if (room <= 0) return toast("A bug can have up to 20 attachments.", true);
  bugForm.pending.push(...files.slice(0, room).map(newPending));
  if (files.length > room) toast("A bug can have up to 20 attachments.", true);
  renderBugAtts();
};
FILE_TARGET_PERMS["bug-files"] = "edit";
PICK_MULTI.add("bug-files");
PICK_ACCEPT["bug-files"] = () => "";

// Called by the task form before saving: completes or strips bug fields and uploads new attachments.
async function bugFormData(data, editId) {
  const before = editId ? tasks.find((x) => x.id === editId) || {} : {};
  if (data.status === "done" && before.status !== "done") data.resolvedAt = Date.now();
  if (data.type !== "bug") {
    for (const k of BUG_KEYS) delete data[k];
    return true;
  }
  for (const k of BUG_KEYS) data[k] = String(data[k] ?? "").trim();
  if (!BUG_SEVERITY[data.severity]) data.severity = "major";
  if (!BUG_FREQUENCY[data.frequency]) data.frequency = "sometimes";
  if (!data.reporter) data.reporter = before.reporter || user.uid;
  if (!editId) data.links = [];
  if (!bugForm.pending.length) { data.attachments = bugForm.kept.slice(); return true; }
  const btn = taskForm.querySelector('button[type="submit"]');
  bugForm.busy = true;
  btn.disabled = true;
  btn.textContent = "Uploading…";
  renderBugAtts();
  const ups = await act(() => mapLimit(bugForm.pending, 2, (p) => storeFile(p.file, "bug")));
  bugForm.busy = false;
  btn.disabled = false;
  btn.textContent = "Save";
  if (!ups) { renderBugAtts(); return false; }
  bugForm.pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
  bugForm.pending = [];
  data.attachments = [...bugForm.kept, ...ups];
  return true;
}
// Changes to bug fields, for the activity log and the bug's history.
function bugChanges(before, after) {
  if (after.type !== "bug") return [];
  const short = (s) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > 70 ? `${s.slice(0, 69)}…` : s; };
  const lab = { severity: (v) => BUG_SEVERITY[v]?.label || "", frequency: (v) => BUG_FREQUENCY[v]?.label || "", reporter: (v) => (v ? memberName(v) : "") };
  const out = [];
  for (const [k, name] of Object.entries(BUG_FIELD_NAMES)) {
    if (!(k in after)) continue;
    if (k === "reporter" && !before.reporter && after.reporter === before.createdBy) continue;
    if ((before[k] || "") === (after[k] || "")) continue;
    if ((k === "severity" || k === "frequency") && !before[k] && before.createdAt) continue; // older bug getting defaults
    const f = lab[k] || short;
    out.push({ field: name, from: f(before[k]) || "", to: f(after[k]) || "" });
  }
  if (after.attachments) {
    const a = (before.attachments || []).map((x) => x.url).join("|");
    const b = after.attachments.map((x) => x.url).join("|");
    const n = (x) => `${x} file${x === 1 ? "" : "s"}`;
    if (a !== b) out.push({ field: "Attachments", from: n((before.attachments || []).length), to: n(after.attachments.length) });
  }
  return out;
}

/* ---------- Status changes ---------- */
async function setBugStatus(id, status) {
  const t = tasks.find((x) => x.id === id);
  if (!t || t.status === status || !BUG_STATUS[status]) return;
  if (!can("edit")) return toast("Your role in this project can't do that.", true);
  const now = Date.now();
  const reopened = t.status === "done";
  const patch = { status, updatedAt: now };
  if (status === "done") patch.resolvedAt = now;
  if (reopened) patch.reopenedAt = now;
  const changes = [{ field: "Status", from: bugStatusLabel(t.status), to: bugStatusLabel(status) }];
  if (!(await act(() => sub("tasks").doc(id).update(patch)))) return;
  const done = status === "done";
  log(done ? "bug.fixed" : reopened ? "bug.reopen" : "bug.update", done ? "resolved" : reopened ? "reopened" : `moved to ${bugStatusLabel(status)}`, t.title, "Bugs", { changes, ref: `task:${id}` });
  if (reopened && t.owner) notify(t.owner, "assign", `${t.title} (reopened)`, `#bugs.${id}`);
}

/* ---------- History (activity entries for this bug) ---------- */
function stopBugHistory() {
  bugHist.unsub?.();
  bugHist = { key: null, list: [], unsub: null };
}
function bugHistory(t) {
  const ref = `task:${t.id}`;
  const key = `${currentId}:${ref}`;
  if (bugHist.key !== key) {
    stopBugHistory();
    bugHist.key = key;
    bugHist.unsub = listen(() => sub("activity").where("ref", "==", ref), (snap) => {
      bugHist.list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    });
  }
  const seen = new Set();
  // Older entries were written before activity had refs: match them by title.
  const older = activity.filter((a) => !a.ref && (a.where === "Bugs" || a.where === "Tasks") && (a.target === t.title || a.detail === t.title));
  return [...bugHist.list, ...activity.filter((a) => a.ref === ref), ...older]
    .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}
window.addEventListener("hashchange", () => {
  const r = route();
  if (!(r.name === "bugs" && r.arg && bugHist.key?.endsWith(`task:${r.arg}`))) stopBugHistory();
  if (!(r.name === "bugs" && r.arg === linkPicker)) { linkPicker = null; linkQuery = ""; }
  cmEditing = null;
});

/* ---------- Links ---------- */
function linkTarget(kind, id) {
  if (kind === "task" || kind === "bug") {
    const t = tasks.find((x) => x.id === id);
    return t ? { title: t.title, sub: `${t.type === "bug" ? "Bug" : "Task"} · ${statusLabel(t.status, t.type)}`, kind: t.type === "bug" ? "bug" : "task" } : null;
  }
  if (kind === "feedback") {
    const f = typeof feedbackItems !== "undefined" ? feedbackItems.find((x) => x.id === id) : null;
    const st = f && typeof FEEDBACK_STATUS !== "undefined" ? FEEDBACK_STATUS[f.status]?.label || f.status : f?.status;
    return f ? { title: f.title, sub: `Feedback${st ? ` · ${st}` : ""}${f.author ? ` · ${f.author}` : ""}`, kind } : null;
  }
  if (kind === "update") {
    const u = updates.find((x) => x.id === id);
    return u ? { title: u.title || u.version || "Update", sub: `Update${u.version ? ` · ${u.version}` : ""}${u.status === "draft" ? " · draft" : ""}`, kind } : null;
  }
  return null;
}
function linkRow(l, removable) {
  const info = linkTarget(l.kind, l.id);
  const k = LINK_KINDS[info?.kind || l.kind] || LINK_KINDS.task;
  const key = `${esc(l.kind)}:${esc(l.id)}`;
  return `<li class="blink ${info ? "" : "missing"}">
    <button type="button" class="blink-open" data-open-link="${key}" ${info ? "" : "disabled"}><span class="blink-ic k-${esc(info?.kind || l.kind)}">${icon(k.icon, 16)}</span>
      <span class="blink-text"><b class="ellipsis">${esc(info ? info.title : `Deleted ${k.label.toLowerCase()}`)}</b><span class="muted small ellipsis">${esc(info ? info.sub : "No longer available")}</span></span></button>
    ${removable && can("edit") ? `<button type="button" class="icon-btn bare tiny" data-unlink="${key}" title="Remove link">${icon("unlink", 15)}</button>` : ""}</li>`;
}
function linkCandidates(t) {
  const taken = new Set((t.links || []).map((l) => `${l.kind}:${l.id}`));
  const q = linkQuery.trim().toLowerCase();
  const out = [];
  for (const x of tasks) if (x.id !== t.id) out.push({ kind: x.type === "bug" ? "bug" : "task", id: x.id, title: x.title, sub: statusLabel(x.status, x.type) });
  if (typeof feedbackItems !== "undefined") for (const f of feedbackItems) out.push({ kind: "feedback", id: f.id, title: f.title, sub: f.author || "" });
  for (const u of updates) if (u.status === "published" || can("manage")) out.push({ kind: "update", id: u.id, title: u.title || u.version || "Update", sub: u.version || "" });
  return out.filter((c) => !taken.has(`${c.kind}:${c.id}`) && (!q || `${c.title} ${c.sub}`.toLowerCase().includes(q))).slice(0, 10);
}
async function saveLinks(t, links, verb, target) {
  const ok = await act(() => sub("tasks").doc(t.id).update({ links, updatedAt: Date.now() }));
  if (ok) log("bug.link", verb, t.title, t.type === "bug" ? "Bugs" : "Tasks", { ref: `task:${t.id}`, detail: target });
  return ok;
}
function openLink(kind, id) {
  if (kind === "bug" || kind === "task") {
    const t = tasks.find((x) => x.id === id);
    if (t?.type === "bug") return openBug(id);
    return openTask(id);
  }
  if (kind === "feedback") {
    if (typeof openFeedback === "function") return openFeedback(id);
    location.hash = `#feedback.${id}`;
    return;
  }
  if (kind === "update") location.hash = `#updates.${id}`;
}
function linksCard(t) {
  const own = [...(t.links || [])];
  if (t.feedbackId && !own.some((l) => l.kind === "feedback" && l.id === t.feedbackId)) own.push({ kind: "feedback", id: t.feedbackId, fixed: true });
  const back = tasks.filter((x) => x.id !== t.id && (x.links || []).some((l) => (l.kind === "bug" || l.kind === "task") && l.id === t.id) && !own.some((l) => l.id === x.id));
  const fromFeedback = typeof feedbackItems !== "undefined" ? feedbackItems.filter((f) => f.taskId === t.id && !own.some((l) => l.id === f.id)) : [];
  const picker = linkPicker === t.id ? `<div class="link-picker" role="dialog" aria-label="Add a link">
      <div class="lp-search">${icon("search", 16)}<input id="bug-link-q" value="${esc(linkQuery)}" placeholder="Search tasks, bugs, feedback, updates…" autocomplete="off" maxlength="80"></div>
      <div class="lp-results">${linkCandidates(t).map((c) => `<button type="button" data-link-add="${esc(c.kind)}:${esc(c.id)}"><span class="blink-ic k-${c.kind}">${icon(LINK_KINDS[c.kind].icon, 15)}</span><span class="blink-text"><b class="ellipsis">${esc(c.title)}</b><span class="muted small ellipsis">${LINK_KINDS[c.kind].label}${c.sub ? ` · ${esc(c.sub)}` : ""}</span></span></button>`).join("") || `<p class="muted small lp-empty">${linkQuery ? "Nothing matches your search." : "Nothing to link yet."}</p>`}</div>
    </div>` : "";
  const rows = [...own.map((l) => linkRow(l, !l.fixed)), ...fromFeedback.map((f) => linkRow({ kind: "feedback", id: f.id }, false))];
  return `<section class="card bug-links">
    <div class="card-head"><h2>${icon("link", 18)}Links</h2>${can("edit") ? `<div class="lp-anchor"><button type="button" class="btn small ${linkPicker === t.id ? "on" : ""}" data-action="bug-link-open" data-bug="${esc(t.id)}">${icon("plus", 15)}Add link</button>${picker}</div>` : ""}</div>
    <div class="card-body">
      ${rows.length ? `<ul class="blinks">${rows.join("")}</ul>` : '<p class="muted small">Link related tasks, player feedback or the update that fixes it.</p>'}
      ${back.length ? `<div class="side-label">Linked from</div><ul class="blinks">${back.map((x) => linkRow({ kind: x.type === "bug" ? "bug" : "task", id: x.id }, false)).join("")}</ul>` : ""}
    </div></section>`;
}

/* ---------- Comments (bugs, tasks and feedback) ---------- */
const cmKey = (target) => String(target).replace(/[^A-Za-z0-9_-]/g, "-");
const cmColor = (uid) => `hsl(${hash(uid || "none") % 360} 75% 74%)`;
function commentsHtml(target) {
  const list = comments.filter((c) => c.target === target);
  const key = cmKey(target);
  const pend = cmPending[target] || [];
  const sending = !!cmSending[target];
  const canWrite = can("chat");
  const rows = list.map((c) => {
    const mine = c.uid === user.uid;
    const editing = cmEditing === c.id;
    const who = nameOf(c.uid, c.name);
    const body = editing
      ? `<form class="cm-edit" data-cm-edit="${esc(c.id)}"><textarea id="cm-edit-text" rows="2" maxlength="4000">${esc(detokenizeMentions(c.text))}</textarea><div class="muted small">Enter to save · Shift+Enter for a new line · Esc to cancel</div></form>`
      : `${c.text ? `<div class="cm-text">${formatMessage(c.text, { mention: renderMention })}${c.editedAt ? ' <span class="edited">(edited)</span>' : ""}</div>` : ""}${attachmentsHtml(c.attachments)}`;
    const actions = editing ? "" : `${mine ? `<button type="button" class="icon-btn bare tiny" data-cm-edit-start="${esc(c.id)}" title="Edit comment">${icon("edit", 14)}</button>` : ""}${mine || can("manage") ? `<button type="button" class="icon-btn bare tiny danger-text" data-cm-delete="${esc(c.id)}" title="Delete comment">${icon("trash", 14)}</button>` : ""}`;
    return `<li class="cm ${mentionedIds(c.text).includes(user.uid) ? "mentioned" : ""}" data-cm-id="${esc(c.id)}">${avatar(c.uid, 34, who)}
      <div class="cm-main"><div class="cm-head"><b style="color:${cmColor(c.uid)}">${esc(who)}</b><span class="cm-time" title="${esc(new Date(c.at).toLocaleString())}">${timeAgo(c.at)}</span><span class="spacer"></span><span class="cm-actions">${actions}</span></div>${body}</div></li>`;
  }).join("");
  const pending = pend.length ? `<div class="cm-pending">${pend.map((f) => `<div class="bug-att pending"><span class="bug-att-thumb">${attThumb({ type: f.file.type }, f.preview)}</span><span class="bug-att-text"><b class="ellipsis">${esc(f.file.name)}</b><span class="muted small">${sending ? "Uploading…" : formatSize(f.file.size)}</span></span>${sending ? "" : `<button type="button" class="icon-btn bare tiny" data-cm-remove-pending="${esc(target)}|${esc(f.id)}" title="Remove">${icon("x", 13)}</button>`}</div>`).join("")}</div>` : "";
  const composer = canWrite ? `<form class="cm-composer" data-comment-form="${esc(target)}" data-drafts data-drop="comment-files" data-target="${esc(target)}">
      ${pending}
      <div class="cm-row">${avatar(user.uid, 32)}
        <textarea id="cm-text-${key}" name="text" rows="1" maxlength="4000" placeholder="Write a comment… type @Name to mention someone" ${sending ? "readonly" : ""}></textarea>
        <button type="button" class="icon-btn bare" data-pick="comment-files" data-target="${esc(target)}" title="Attach files">${icon("paperclip", 18)}</button>
        <button type="submit" class="btn primary small cm-send" ${sending ? "disabled" : ""} title="Send">${sending ? icon("spinner", 16) : icon("send", 16)}</button>
      </div>
      <div class="muted small cm-hint">Enter to send · Shift+Enter for a new line · **bold** *italic* \`code\`</div>
    </form>` : '<p class="muted small">You can read comments here. Ask the owner for edit access to comment.</p>';
  return `<div class="comments" data-comments="${esc(target)}">
    ${rows ? `<ul class="cm-list">${rows}</ul>` : '<div class="cm-empty">No comments yet. Start the discussion.</div>'}
    ${composer}</div>`;
}
FILE_TARGETS["comment-files"] = (files, opts = {}) => {
  const target = opts.el?.dataset.target || opts.el?.closest?.("[data-target]")?.dataset.target;
  if (!target) return;
  const list = cmPending[target] || (cmPending[target] = []);
  const room = 10 - list.length;
  if (room <= 0) return toast("Up to 10 files per comment.", true);
  list.push(...files.slice(0, room).map(newPending));
  render();
};
FILE_TARGET_PERMS["comment-files"] = "chat";
PICK_MULTI.add("comment-files");
PICK_ACCEPT["comment-files"] = () => "";

function commentLink(target) {
  const [kind, id] = String(target).split(":");
  if (kind === "feedback") return `#feedback.${id}`;
  const t = tasks.find((x) => x.id === id);
  return t?.type === "bug" ? `#bugs.${id}` : "#tasks";
}
async function sendComment(form) {
  const target = form.dataset.commentForm;
  const ta = form.querySelector("textarea");
  const raw = (ta?.value || "").trim();
  const pend = cmPending[target] || [];
  if ((!raw && !pend.length) || cmSending[target]) return;
  if (!can("chat")) return toast("Your role in this project can't do that.", true);
  const taId = ta.id;
  const text = tokenizeMentions(raw);
  cmSending[target] = true;
  render();
  const ok = await act(async () => {
    const attachments = pend.length ? await mapLimit(pend, 2, (p) => storeFile(p.file, "comment")) : [];
    const doc = { target, text, uid: user.uid, name: storedName(), at: Date.now() };
    if (attachments.length) doc.attachments = attachments;
    await sub("comments").add(doc);
  });
  cmSending[target] = false;
  if (ok) {
    delete drafts[taId];
    const el = document.getElementById(taId);
    if (el) el.value = "";
    pend.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
    cmPending[target] = [];
    const [kind, id] = target.split(":");
    const t = kind === "task" ? tasks.find((x) => x.id === id) : null;
    const plain = detokenizeMentions(text);
    if (t) log(t.type === "bug" ? "bug.comment" : "task.comment", "commented on", t.title, t.type === "bug" ? "Bugs" : "Tasks", { ref: target, detail: plain.slice(0, 140) || "(attachment)" });
    for (const uid of mentionedIds(text)) notify(uid, "mention", plain.slice(0, 120), commentLink(target));
  }
  render();
  document.getElementById(taId)?.focus();
}
async function saveCommentEdit(id, value) {
  const c = comments.find((x) => x.id === id);
  cmEditing = null;
  delete drafts["cm-edit-text"];
  const next = tokenizeMentions(String(value || "").trim(), mentionedIds(c?.text));
  if (!c || next === (c.text || "") || (!next && !c.attachments?.length)) return render();
  await act(() => sub("comments").doc(id).update({ text: next, editedAt: Date.now() }));
  render();
}
async function deleteComment(id) {
  const c = comments.find((x) => x.id === id);
  if (!c) return;
  const ok = await ask({ title: "Delete this comment?", text: "It's removed for everyone.", ok: "Delete", danger: true });
  if (ok) await act(() => sub("comments").doc(id).delete(), "Comment deleted");
}

/* ---------- Bug detail page ---------- */
function stepsList(steps) {
  const lines = String(steps || "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^(\d+\s*[.):-]|[-*•])\s*/, ""));
  return lines.length ? `<ol class="bug-steps">${lines.map((l) => `<li>${formatMessage(l)}</li>`).join("")}</ol>` : "";
}
function personChip(uid, empty) {
  return uid ? `<span class="bug-person">${avatar(uid, 26)}<span class="ellipsis">${esc(memberName(uid))}</span></span>` : `<span class="muted">${empty}</span>`;
}
function viewBugDetail(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) {
    const loading = !tasks.length && Date.now() - bugsOpenedAt < 4000;
    return `${header("Bugs", "", { actions: false })}<section class="card"><div class="big-empty bug-missing">${icon(loading ? "spinner" : "bug", 34)}<h3>${loading ? "Loading bug…" : "This bug doesn't exist anymore"}</h3>${loading ? "" : '<p class="muted">It may have been deleted. </p><a class="btn" href="#bugs">Back to bugs</a>'}</div></section>`;
  }
  if (t.type !== "bug") return `${header("Bugs", "", { actions: false })}<section class="card"><div class="big-empty bug-missing">${icon("file", 34)}<h3>${esc(t.title)} is a task</h3><p class="muted">Tasks open in their own dialog.</p><button class="btn" data-task="${esc(t.id)}">Open task</button></div></section>`;
  const edit = can("edit");
  const keys = Object.keys(BUG_STATUS);
  const at = keys.indexOf(t.status);
  const stepper = `<ol class="bug-stepper" aria-label="Status">${keys.map((k, i) => `<li class="${i < at ? "past" : i === at ? "current" : ""} st-${k}">
      <button type="button" data-bug-status="${k}" data-bug="${esc(t.id)}" ${edit && i !== at ? "" : "disabled"} ${i === at ? 'aria-current="step"' : ""} title="${edit && i !== at ? `Move to ${BUG_STATUS[k].label}` : BUG_STATUS[k].label}">
        <span class="step-dot">${icon(i < at ? "checkSmall" : BUG_STATUS[k].icon, 15, 2.2)}</span><span class="step-label">${BUG_STATUS[k].label}</span></button></li>`).join("")}</ol>`;
  const env = [["Platform", t.platform ? `${platformIcon(t.platform, 15)}${esc(platformLabel(t.platform))}` : ""], ["Device", esc(t.device || "")], ["Game version", esc(t.gameVersion || "")]];
  const hist = bugHistory(t);
  const target = `task:${t.id}`;
  const nComments = commentCount(target);
  return `${header(t.title, "Bugs", { actions: false })}
    <div class="bug-page">
      <div class="bug-topbar"><a class="link" href="#bugs">${icon("arrow", 15)}<span>All bugs</span></a><span class="spacer"></span>
        ${edit && t.status === "done" ? `<button class="btn small" data-action="bug-reopen" data-bug="${esc(t.id)}">${icon("reopen", 15)}Reopen</button>` : ""}
        ${edit ? `<button class="btn small" data-action="bug-edit" data-bug="${esc(t.id)}">${icon("edit", 15)}Edit</button>` : ""}
        ${canDelete(t.createdBy) ? `<button class="btn small danger" data-action="bug-delete" data-bug="${esc(t.id)}">${icon("trash", 15)}Delete</button>` : ""}</div>
      <section class="card bug-hero">
        <div class="bug-badges">${statusPill(t.status, "bug")}${severityBadge(t.severity)}${priorityPill(t.priority)}${frequencyBadge(t.frequency)}</div>
        ${stepper}
        <div class="bug-people">
          <div><span class="side-label">Reported by</span>${personChip(t.reporter || t.createdBy, "Unknown")}</div>
          <div><span class="side-label">Responsible for the fix</span>${personChip(t.owner, "Unassigned")}</div>
          <div><span class="side-label">Reported</span><span title="${esc(new Date(t.createdAt || 0).toLocaleString())}">${t.createdAt ? timeAgo(t.createdAt) : "—"}</span></div>
          ${t.resolvedAt && t.status === "done" ? `<div><span class="side-label">Resolved</span><span class="ok-text">${timeAgo(t.resolvedAt)}</span></div>` : ""}
          ${t.reopenedAt && t.status !== "done" ? `<div><span class="side-label">Reopened</span><span class="warn-text">${timeAgo(t.reopenedAt)}</span></div>` : ""}
        </div>
      </section>
      <div class="bug-grid">
        <div class="bug-col">
          <section class="card"><div class="card-head"><h2>Description</h2></div><div class="card-body">${t.desc ? `<div class="bug-text">${formatMessage(t.desc)}</div>` : '<p class="muted">No description.</p>'}</div></section>
          <section class="card"><div class="card-head"><h2>${icon("listOrdered", 18)}Steps to reproduce</h2></div><div class="card-body">${stepsList(t.steps) || '<p class="muted">No steps written yet.</p>'}</div></section>
          <section class="card"><div class="card-body bug-ea">
            <div class="ea expected"><div class="ea-head">${icon("target", 16)}Expected result</div>${t.expected ? `<div class="bug-text">${formatMessage(t.expected)}</div>` : '<p class="muted small">Not specified.</p>'}</div>
            <div class="ea actual"><div class="ea-head">${icon("alert", 16)}Actual result</div>${t.actual ? `<div class="bug-text">${formatMessage(t.actual)}</div>` : '<p class="muted small">Not specified.</p>'}</div>
          </div></section>
          <section class="card bug-files-card" ${edit ? `data-drop="bug-add-files" data-bug="${esc(t.id)}"` : ""}>
            <div class="card-head"><h2>${icon("paperclip", 18)}Attachments <span class="muted">${(t.attachments || []).length || ""}</span></h2>${edit ? `<button class="btn small" data-pick="bug-add-files" data-bug="${esc(t.id)}">${icon("upload", 15)}Add files</button>` : ""}</div>
            <div class="card-body">${(t.attachments || []).length ? attachmentsHtml(t.attachments) : `<p class="muted small">${edit ? "No attachments yet. Drop screenshots, videos or logs here." : "No attachments."}</p>`}</div>
          </section>
          <section class="card bug-comments"><div class="card-head"><h2>${icon("comment", 18)}Comments <span class="muted">${nComments || ""}</span></h2></div><div class="card-body">${commentsHtml(target)}</div></section>
        </div>
        <div class="bug-col side">
          <section class="card"><div class="card-head"><h2>${icon("monitor", 18)}Environment</h2></div><div class="card-body"><dl class="bug-env">${env.map(([k, v]) => `<div><dt>${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd></div>`).join("")}</dl></div></section>
          ${linksCard(t)}
          <section class="card"><div class="card-head"><h2>${icon("history", 18)}History</h2></div><div class="card-body">${hist.length ? `<ul class="feed bug-history">${hist.map((a) => `<li>${avatar(a.uid, 30, nameOf(a.uid, a.name))}${actBadge(a, 14)}<div class="feed-text"><div class="txt">${actText(a)}</div>${a.detail && !a.changes?.length ? `<div class="sub detail">${esc(a.detail)}</div>` : ""}${changesList(a)}<div class="sub" title="${esc(new Date(a.at).toLocaleString())}">${timeAgo(a.at)}</div></div></li>`).join("")}</ul>` : '<p class="muted small">No changes recorded yet.</p>'}</div></section>
        </div>
      </div>
    </div>`;
}
registerView("bugs", () => (route().arg ? viewBugDetail(route().arg) : viewTaskList("bug")));

// Files dropped on a bug's page are added to it right away.
FILE_TARGETS["bug-add-files"] = async (files, opts = {}) => {
  const id = opts.el?.dataset.bug || route().arg;
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const room = 20 - (t.attachments || []).length;
  if (room <= 0) return toast("A bug can have up to 20 attachments.", true);
  const ups = await act(() => mapLimit(files.slice(0, room), 2, (f) => storeFile(f, "bug")));
  if (!ups) return;
  const fresh = tasks.find((x) => x.id === id) || t;
  const next = [...(fresh.attachments || []), ...ups];
  if (await act(() => sub("tasks").doc(id).update({ attachments: next, updatedAt: Date.now() }), ups.length === 1 ? "File added" : `${ups.length} files added`)) {
    log("bug.update", "updated", t.title, "Bugs", { ref: `task:${id}`, changes: [{ field: "Attachments", from: `${(fresh.attachments || []).length}`, to: `${next.length} files` }] });
  }
};
FILE_TARGET_PERMS["bug-add-files"] = "edit";
PICK_MULTI.add("bug-add-files");
PICK_ACCEPT["bug-add-files"] = () => "";

async function deleteBug(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const ok = await ask({ title: `Delete "${t.title}"?`, text: "This removes the bug and its comments for the whole team.", ok: "Delete", danger: true });
  if (!ok) return;
  if (!(await act(() => sub("tasks").doc(id).delete(), "Bug deleted"))) return;
  log("bug.delete", "deleted", t.title, "Bugs", { ref: `task:${id}` });
  location.hash = "#bugs";
  const mine = comments.filter((c) => c.target === `task:${id}` && (c.uid === user.uid || can("manage")));
  for (let i = 0; i < mine.length; i += 400) {
    const batch = db.batch();
    mine.slice(i, i + 400).forEach((c) => batch.delete(sub("comments").doc(c.id)));
    await batch.commit().catch((e) => console.error("BLACKBOX: comment cleanup", e));
  }
}

/* ---------- Actions and events ---------- */
Object.assign(actions, {
  "bug-edit": (el) => openTask(el.dataset.bug),
  "bug-reopen": (el) => setBugStatus(el.dataset.bug, "todo"),
  "bug-delete": (el) => deleteBug(el.dataset.bug),
  "bug-link-open": (el) => {
    linkPicker = linkPicker === el.dataset.bug ? null : el.dataset.bug;
    linkQuery = "";
    render();
    if (linkPicker) $("#bug-link-q")?.focus();
  },
});
Object.assign(ACTION_PERMS, { "bug-edit": "edit", "bug-reopen": "edit", "bug-delete": "edit", "bug-link-open": "edit" });

document.addEventListener("change", (e) => {
  if (e.target.id === "task-type") syncBugForm(e.target.value);
});
document.addEventListener("click", (e) => {
  if (!user) return;
  if (linkPicker && !e.target.closest(".link-picker, [data-action=bug-link-open]")) { linkPicker = null; linkQuery = ""; render(); }
  const el = e.target.closest("[data-bug-att-remove],[data-bug-status],[data-open-link],[data-unlink],[data-link-add],[data-cm-edit-start],[data-cm-delete],[data-cm-remove-pending]");
  if (!el) return;
  const d = el.dataset;
  if (d.bugAttRemove) {
    const [kind, v] = d.bugAttRemove.split(":");
    if (kind === "kept") bugForm.kept.splice(+v, 1);
    else {
      const f = bugForm.pending.find((x) => x.id === v);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      bugForm.pending = bugForm.pending.filter((x) => x !== f);
    }
    return renderBugAtts();
  }
  if (d.bugStatus) return setBugStatus(d.bug, d.bugStatus);
  if (d.openLink) { const [k, id] = d.openLink.split(":"); return openLink(k, id); }
  const t = tasks.find((x) => x.id === route().arg);
  if (d.unlink && t) {
    if (!can("edit")) return toast("Your role in this project can't do that.", true);
    const [k, id] = d.unlink.split(":");
    const info = linkTarget(k, id);
    return saveLinks(t, (t.links || []).filter((l) => !(l.kind === k && l.id === id)), "removed a link from", info?.title || "");
  }
  if (d.linkAdd && t) {
    if (!can("edit")) return toast("Your role in this project can't do that.", true);
    const [k, id] = d.linkAdd.split(":");
    linkPicker = null;
    linkQuery = "";
    const info = linkTarget(k, id);
    return saveLinks(t, [...(t.links || []).filter((l) => !(l.kind === k && l.id === id)), { kind: k, id }], "linked", `${LINK_KINDS[info?.kind || k]?.label || "Item"}: ${info?.title || ""}`);
  }
  if (d.cmEditStart) { cmEditing = d.cmEditStart; render(); const ta = $("#cm-edit-text"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } return; }
  if (d.cmDelete) return deleteComment(d.cmDelete);
  if (d.cmRemovePending) {
    const [target, id] = d.cmRemovePending.split("|");
    const f = (cmPending[target] || []).find((x) => x.id === id);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    cmPending[target] = (cmPending[target] || []).filter((x) => x !== f);
    return render();
  }
});
document.addEventListener("submit", (e) => {
  const f = e.target;
  if (f.dataset?.commentForm) { e.preventDefault(); sendComment(f); }
  else if (f.dataset?.cmEdit) { e.preventDefault(); saveCommentEdit(f.dataset.cmEdit, $("#cm-edit-text")?.value); }
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "bug-link-q") { linkQuery = t.value; render(); }
  if (t.id?.startsWith("cm-text-") || t.id === "cm-edit-text") { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 220)}px`; }
});
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.id?.startsWith("cm-text-") && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendComment(t.form); }
  if (t.id === "cm-edit-text") {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveCommentEdit(t.form.dataset.cmEdit, t.value); }
    if (e.key === "Escape") { e.preventDefault(); cmEditing = null; delete drafts["cm-edit-text"]; render(); }
  }
  if (t.id === "bug-link-q" && e.key === "Escape") { e.preventDefault(); linkPicker = null; linkQuery = ""; render(); }
  if (t.id === "bug-link-q" && e.key === "Enter") { e.preventDefault(); $(".lp-results button")?.click(); }
});
taskDialog.addEventListener("close", () => {
  bugForm.pending.forEach((x) => x.preview && URL.revokeObjectURL(x.preview));
  bugForm.pending = [];
});
