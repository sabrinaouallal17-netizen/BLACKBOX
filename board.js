"use strict";

/* ---------- Kanban board ---------- */
const boardMode = (type) => storeGet(`blackbox:board:${type}`) === "board";

function viewBoard(type, list) {
  const editable = can("edit");
  return `<div class="board" data-board-type="${type}">${Object.entries(STATUS).map(([status, s]) => {
    const col = list.filter((t) => t.status === status);
    lists[`col-${status}`] = col.map((t) => t.id);
    return `<section class="kcol" data-kcol="${status}">
      <header class="kcol-head"><span class="pill s-${status}">${icon(s.icon, 14, 2)}${s.label}</span><span class="muted small">${col.length}</span><span class="spacer"></span>
        ${editable ? `<button class="icon-btn bare" data-action="new-task" data-status="${status}" title="Add to ${s.label}">${icon("plus", 16)}</button>` : ""}</header>
      <div class="kcol-body">${col.map((t) => `<article class="kcard ${editable ? "draggable" : ""}" data-kcard="${esc(t.id)}" tabindex="0">
          <div class="kcard-top">${priorityPill(t.priority)}<span class="spacer"></span>
            <button class="icon-btn bare" data-task-menu="${esc(t.id)}" data-list="col-${status}" data-menu-key="task:col-${status}:${esc(t.id)}" aria-haspopup="menu" title="Actions">${icon("dots", 18)}</button></div>
          <div class="kcard-title">${esc(t.title)}</div>
          ${t.desc ? `<div class="kcard-desc">${esc(t.desc)}</div>` : ""}
          <div class="kcard-foot">${t.type === "bug" ? `<span class="muted small kcard-kind">${icon("bug", 14)}Bug</span>` : ""}<span class="spacer"></span>${t.owner ? avatar(t.owner, 26) : '<span class="muted small">Unassigned</span>'}</div>
        </article>`).join("") || `<div class="kcol-empty">${editable ? "Drop cards here" : "Nothing here"}</div>`}</div>
    </section>`;
  }).join("")}</div>`;
}

// Pointer-based drag: works with a mouse right away and with a finger after a short press.
let drag = null;
let suppressClick = false;

document.addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".kcard.draggable");
  if (!card || e.button > 0 || e.target.closest("button, a, input")) return;
  drag = { card, id: card.dataset.kcard, x: e.clientX, y: e.clientY, pointerId: e.pointerId, active: false, armed: e.pointerType !== "touch" };
  if (e.pointerType === "touch") drag.timer = setTimeout(() => { if (drag && !drag.active) { drag.armed = true; startDrag(e.clientX, e.clientY); } }, 260);
});
document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
  if (!drag.active) {
    if (!drag.armed) { if (dist > 8) cancelDrag(); return; } // a finger moving early is a scroll
    if (dist < 6) return;
    startDrag(e.clientX, e.clientY);
  }
  moveDrag(e.clientX, e.clientY);
});
document.addEventListener("touchmove", (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
document.addEventListener("pointerup", (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(e.clientX, e.clientY); });
document.addEventListener("pointercancel", () => cancelDrag());
document.addEventListener("click", (e) => {
  if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); return; }
  const card = e.target.closest("[data-kcard]");
  if (card && !e.target.closest("button")) openTask(card.dataset.kcard);
}, true);

function startDrag(x, y) {
  drag.active = true;
  renderBlocked = true;
  closePopover();
  const r = drag.card.getBoundingClientRect();
  drag.dx = x - r.left;
  drag.dy = y - r.top;
  drag.ghost = drag.card.cloneNode(true);
  drag.ghost.classList.add("kghost");
  drag.ghost.style.width = `${r.width}px`;
  document.body.appendChild(drag.ghost);
  drag.placeholder = document.createElement("div");
  drag.placeholder.className = "kplaceholder";
  drag.placeholder.style.height = `${r.height}px`;
  drag.card.after(drag.placeholder);
  drag.card.classList.add("kdragging");
  document.body.classList.add("is-dragging");
}
function moveDrag(x, y) {
  drag.ghost.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px) rotate(2deg)`;
  const under = document.elementFromPoint(x, y);
  const body = under?.closest(".kcol")?.querySelector(".kcol-body");
  $$(".kcol.over").forEach((c) => c !== body?.parentElement && c.classList.remove("over"));
  if (!body) return;
  body.parentElement.classList.add("over");
  const cards = $$(".kcard:not(.kdragging)", body);
  const next = cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  if (next) body.insertBefore(drag.placeholder, next); else body.appendChild(drag.placeholder);
  body.querySelector(".kcol-empty")?.remove();
}
async function endDrag() {
  clearTimeout(drag?.timer);
  if (!drag?.active) { drag = null; return; }
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  const { id, placeholder } = drag;
  const col = placeholder.closest(".kcol");
  const status = col?.dataset.kcol;
  // Neighbours of the drop position, ignoring the card being moved.
  const siblings = [...placeholder.parentElement.children].filter((c) => c === placeholder || (c.matches(".kcard") && !c.classList.contains("kdragging")));
  const at = siblings.indexOf(placeholder);
  const prevId = siblings[at - 1]?.dataset.kcard;
  const nextId = siblings[at + 1]?.dataset.kcard;
  cleanupDrag();
  if (status) await dropTask(id, status, prevId, nextId);
}
function cancelDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  if (drag.active) cleanupDrag(); else drag = null;
}
function cleanupDrag() {
  drag.ghost?.remove();
  drag.placeholder?.remove();
  drag.card.classList.remove("kdragging");
  $$(".kcol.over").forEach((c) => c.classList.remove("over"));
  document.body.classList.remove("is-dragging");
  drag = null;
  renderBlocked = false;
  if (renderPending) { renderPending = false; render(); }
}

async function dropTask(id, status, prevId, nextId) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const prev = tasks.find((x) => x.id === prevId);
  const next = tasks.find((x) => x.id === nextId);
  let order;
  if (prev && next && (next.order ?? 0) - (prev.order ?? 0) > 1e-6) order = ((prev.order ?? 0) + (next.order ?? 0)) / 2;
  else if (prev && !next) order = (prev.order ?? 0) + 1;
  else if (next && !prev) order = (next.order ?? 0) - 1;
  else if (!prev && !next) order = t.order ?? 0;
  else {
    // Neighbours share an order (older tasks): number the column again, putting the card between them.
    const col = tasks.filter((x) => x.status === status && x.id !== id && x.type === t.type).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const at = col.findIndex((x) => x.id === next.id);
    col.splice(at, 0, t);
    const batch = db.batch();
    col.forEach((x, k) => { if (x.id !== id && (x.order ?? 0) !== k + 1) { batch.update(sub("tasks").doc(x.id), { order: k + 1 }); x.order = k + 1; } });
    await act(() => batch.commit());
    order = at + 1;
  }
  if (status === t.status && order === t.order) return;
  const changes = status !== t.status ? [{ field: "Status", from: STATUS[t.status]?.label || t.status, to: STATUS[status].label }] : [];
  // Show the move right away; the listener confirms it.
  Object.assign(t, { status, order });
  tasks.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  render();
  const ok = await act(() => sub("tasks").doc(id).update({ status, order, updatedAt: Date.now() }));
  if (ok && changes.length) {
    const done = status === "done";
    const type = t.type === "bug" ? (done ? "bug.fixed" : "bug.update") : (done ? "task.complete" : "task.update");
    log(type, done ? (t.type === "bug" ? "fixed" : "completed") : `moved to ${STATUS[status].label}`, t.title, t.type === "bug" ? "Bugs" : "Tasks", { changes });
  }
}
