"use strict";

/* ---------- Patch notes (Updates) ---------- */
let updates = [];
let editingUpdate = null; // id being edited, or "new"

const UPDATE_SECTIONS = {
  new: { label: "New", icon: "sparkle", color: "green" },
  improved: { label: "Improvements", icon: "arrowUp", color: "blue" },
  fixed: { label: "Bug fixes", icon: "wrench", color: "orange" },
  balance: { label: "Balance", icon: "scale", color: "purple" },
};
const updateDate = (u) => new Date(u.publishedAt || u.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const lines = (s) => String(s || "").split("\n").map((l) => l.replace(/^\s*[-•*]\s*/, "").trim()).filter(Boolean).slice(0, 60);
const inlineFormat = (s) => formatMessage(s, { mention: renderMention }).replace(/\n/g, " ");

function viewUpdates(id) {
  if (editingUpdate && can("manage")) return viewUpdateEditor();
  const shown = updates.filter((u) => u.status === "published" || can("manage"));
  if (id) {
    const u = updates.find((x) => x.id === id);
    if (u && (u.status === "published" || can("manage"))) return viewUpdate(u);
  }
  return `${header("Updates", "", { actions: false })}
    <section class="card updates-page">
      <div class="coll-toolbar">
        <div class="coll-title"><span class="coll-badge">${icon("rocket", 20)}</span><div class="min0"><div class="coll-h">Patch notes</div><div class="muted small">What changed in each update of ${esc(project().name)}</div></div></div>
        ${can("manage") ? `<button class="btn primary" data-action="new-update">${icon("plus", 18, 2.2)}New update</button>` : ""}
      </div>
      ${shown.length ? `<div class="update-list">${shown.map((u) => {
        const counts = Object.keys(UPDATE_SECTIONS).map((k) => [k, (u.sections?.[k] || []).length]).filter(([, n]) => n);
        return `<a class="update-card" href="#updates.${esc(u.id)}">
          ${safeUrl(u.cover) ? `<div class="update-cover"><img src="${src(u.cover)}" alt="" loading="lazy"></div>` : `<div class="update-cover blank">${icon("rocket", 30)}</div>`}
          <div class="update-body">
            <div class="row-gap">${u.version ? `<span class="tag-chip">${esc(u.version)}</span>` : ""}${u.status !== "published" ? '<span class="draft-chip">Draft</span>' : ""}<span class="muted small">${updateDate(u)}</span></div>
            <h3>${esc(u.title)}</h3>
            ${u.summary ? `<p class="muted">${esc(u.summary)}</p>` : ""}
            <div class="row-gap">${counts.map(([k, n]) => `<span class="sec-chip c-${UPDATE_SECTIONS[k].color}">${icon(UPDATE_SECTIONS[k].icon, 13)}${n} ${UPDATE_SECTIONS[k].label.toLowerCase()}</span>`).join("")}</div>
          </div></a>`;
      }).join("")}</div>` : `<div class="empty big-empty">${icon("rocket", 34)}<h3>No updates yet</h3><p class="muted">${can("manage") ? "Write your first patch notes. BLACKBOX can fill them from the tasks and bugs you completed." : "Patch notes appear here when an admin publishes them."}</p></div>`}
    </section>`;
}

function viewUpdate(u) {
  return `${header(u.title, "Updates", { actions: false })}
    <article class="card patch">
      ${safeUrl(u.cover) ? `<div class="patch-cover"><img src="${src(u.cover)}" alt=""></div>` : ""}
      <div class="patch-head">
        <div class="row-gap">${u.version ? `<span class="tag-chip">${esc(u.version)}</span>` : ""}${u.status !== "published" ? '<span class="draft-chip">Draft</span>' : ""}<span class="muted">${updateDate(u)}</span><span class="muted">· by ${esc(memberName(u.createdBy))}</span></div>
        ${u.summary ? `<p class="lede">${esc(u.summary)}</p>` : ""}
        ${can("manage") ? `<div class="row-gap spaced-sm">
          <button class="btn small" data-action="edit-update" data-update="${esc(u.id)}">${icon("edit", 15)}Edit</button>
          ${u.status === "published" ? `<button class="btn small" data-action="unpublish-update" data-update="${esc(u.id)}">Back to draft</button>` : `<button class="btn primary small" data-action="publish-update" data-update="${esc(u.id)}">${icon("rocket", 15)}Publish</button>`}
          <button class="btn danger small" data-action="delete-update" data-update="${esc(u.id)}">${icon("trash", 15)}Delete</button></div>` : ""}
      </div>
      <div class="patch-sections">${Object.entries(UPDATE_SECTIONS).map(([k, sec]) => {
        const its = u.sections?.[k] || [];
        if (!its.length) return "";
        return `<section class="patch-sec"><h3 class="c-text-${sec.color}"><span class="act-badge c-${sec.color}">${icon(sec.icon, 16)}</span>${sec.label}</h3><ul>${its.map((l) => `<li>${inlineFormat(l)}</li>`).join("")}</ul></section>`;
      }).join("") || '<div class="empty">This update has no notes yet.</div>'}</div>
      <div class="patch-foot"><a class="link" href="#updates">${icon("arrow", 15)}All updates</a></div>
    </article>`;
}

function viewUpdateEditor() {
  const u = editingUpdate === "new" ? { title: "", version: "", summary: "", sections: {}, cover: "" } : updates.find((x) => x.id === editingUpdate) || {};
  return `${header(editingUpdate === "new" ? "New update" : "Edit update", "Updates", { actions: false })}
    <form class="card update-editor" data-form="update" data-drafts>
      <div class="card-body settings">
        <div class="update-editor-top">
          <button type="button" class="brand-pick thumb-pick update-cover-pick" data-pick="update-cover" data-drop="update-cover" title="Cover image">${safeUrl(updateCoverDraft ?? u.cover) ? `<img src="${src(updateCoverDraft ?? u.cover)}" alt="">` : `<span class="muted">${icon("images", 24)}<span>Cover image (optional)</span></span>`}</button>
          <div class="settings">
            <label>Title<input class="input" id="upd-title" name="title" required maxlength="80" value="${esc(u.title)}" placeholder="UPDATE 2: Quests"></label>
            <label>Version <span class="hint">optional</span><input class="input" id="upd-version" name="version" maxlength="20" value="${esc(u.version)}" placeholder="v1.2"></label>
            <label>Summary<textarea class="input" id="upd-summary" name="summary" rows="2" maxlength="300" placeholder="One or two sentences for players">${esc(u.summary)}</textarea></label>
          </div>
        </div>
        <div class="row-gap"><button type="button" class="btn" data-action="fill-update">${icon("sparkle", 16)}Fill from completed work</button><span class="muted small">Adds tasks completed and bugs fixed since the last published update.</span></div>
        <div class="update-sec-grid">${Object.entries(UPDATE_SECTIONS).map(([k, sec]) => `<label><span class="sec-label"><span class="act-badge c-${sec.color}">${icon(sec.icon, 14)}</span>${sec.label} <span class="hint">one per line</span></span>
          <textarea class="input" id="upd-${k}" name="${k}" rows="6" maxlength="4000">${esc((u.sections?.[k] || []).join("\n"))}</textarea></label>`).join("")}</div>
        <div class="row-gap">
          <button class="btn" name="intent" value="draft">${icon("save", 16)}Save draft</button>
          <button class="btn primary" name="intent" value="publish">${icon("rocket", 16)}${u.status === "published" ? "Save" : "Publish"}</button>
          <button type="button" class="btn ghost" data-action="cancel-update">Cancel</button>
        </div>
      </div>
    </form>`;
}

let updateCoverDraft = null; // URL of a newly picked cover, until the update is saved

function fillUpdateFromWork() {
  const lastPub = updates.filter((u) => u.status === "published").reduce((m, u) => Math.max(m, u.publishedAt || 0), 0);
  const recent = tasks.filter((t) => t.status === "done" && (t.updatedAt || t.createdAt || 0) > lastPub);
  const add = (id, titles) => {
    const el = $(`#upd-${id}`);
    const have = new Set(lines(el.value));
    const next = [...lines(el.value), ...titles.filter((x) => !have.has(x))];
    el.value = next.join("\n");
    drafts[el.id] = el.value;
  };
  add("new", recent.filter((t) => t.type === "task").map((t) => t.title));
  add("fixed", recent.filter((t) => t.type === "bug").map((t) => t.title));
  toast(recent.length ? `Added ${recent.length} completed item${recent.length === 1 ? "" : "s"}` : "Nothing completed since the last update.");
}

async function saveUpdate(form, intent) {
  const val = (n) => (form.elements[n]?.value || "").trim();
  const title = val("title");
  if (!title) return toast("Give the update a title.", true);
  const prev = editingUpdate === "new" ? null : updates.find((x) => x.id === editingUpdate);
  const publishing = intent === "publish" && prev?.status !== "published";
  const data = {
    title, version: val("version"), summary: val("summary"),
    sections: Object.fromEntries(Object.keys(UPDATE_SECTIONS).map((k) => [k, lines(val(k))])),
    cover: updateCoverDraft ?? prev?.cover ?? "",
    status: intent === "publish" ? "published" : prev?.status === "published" ? "published" : "draft",
    updatedAt: Date.now(),
  };
  if (publishing) data.publishedAt = Date.now();
  const ref = await act(async () => {
    if (prev) { await sub("updates").doc(prev.id).update(data); return prev.id; }
    const r = await sub("updates").add({ ...data, createdBy: user.uid, createdAt: Date.now() });
    return r.id;
  }, publishing ? "Update published" : "Saved");
  if (!ref) return;
  clearDrafts(form);
  editingUpdate = null;
  updateCoverDraft = null;
  log(publishing ? "update.publish" : prev ? "update.edit" : "update.create", publishing ? "published" : prev ? "edited" : "drafted", title, "Updates");
  if (publishing) for (const id of project().memberIds) notify(id, "update", title, `#updates.${ref}`);
  location.hash = `#updates.${ref}`;
  render();
}

async function setUpdateStatus(id, status) {
  const u = updates.find((x) => x.id === id);
  if (!u) return;
  const data = { status, updatedAt: Date.now() };
  if (status === "published") data.publishedAt = Date.now();
  if (!(await act(() => sub("updates").doc(id).update(data), status === "published" ? "Update published" : "Moved back to drafts"))) return;
  log(status === "published" ? "update.publish" : "update.edit", status === "published" ? "published" : "unpublished", u.title, "Updates");
  if (status === "published") for (const m of project().memberIds) notify(m, "update", u.title, `#updates.${id}`);
}
