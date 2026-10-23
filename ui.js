"use strict";

/* ---------- Small helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
const splitList = (s) => [...new Set(String(s || "").split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 12);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only URLs the app itself produces may reach src, href or CSS: uploaded files, inline images, https.
// Stored data can be written by any member, so this runs at render time, never trusting the database.
function safeUrl(u) {
  const s = String(u || "").trim();
  if (/^\/_blob\/[A-Za-z0-9_.~-]+$/.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
  if (/^https:\/\/[^\s"'<>()\\]+$/i.test(s)) return s;
  return "";
}
const src = (u) => esc(safeUrl(u));

function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: d > 300 ? "numeric" : undefined });
}
const clockTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Runs fn over items with at most `limit` at a time (uploads in parallel without flooding).
async function mapLimit(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
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

/* ---------- Confirm / prompt dialog ---------- */
// In-page replacement for prompt()/confirm(), which sandboxed viewers block.
// Resolves to an array of field values, [] for a plain confirmation, or null if cancelled.
function ask({ title, text = "", fields = [], ok = "OK", danger = false }) {
  return new Promise((resolve) => {
    const d = $("#ask-dialog");
    const f = $("#ask-form");
    $("#ask-title").textContent = title;
    $("#ask-text").textContent = text;
    $("#ask-text").hidden = !text;
    $("#ask-fields").innerHTML = fields.map((fl, i) => fl.multiline
      ? `<label>${esc(fl.label)}<textarea id="ask-f${i}" name="f${i}" rows="3" maxlength="${fl.max || 400}" ${fl.optional ? "" : "required"}>${esc(fl.value || "")}</textarea></label>`
      : `<label>${esc(fl.label)}<input id="ask-f${i}" name="f${i}" type="${fl.type || "text"}" value="${esc(fl.value || "")}" maxlength="${fl.max || 80}" autocomplete="off" ${fl.optional ? "" : "required"}></label>`).join("");
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
    (f.querySelector("input, textarea") || okBtn).focus();
  });
}

/* ---------- Popover menu ---------- */
// One floating menu for the whole app. `key` names the anchor (data-menu-key) so the menu can
// follow it when a live update re-renders the page; `build` returns the items each time.
const popover = { el: null, anchorKey: null, build: null, pick: null, anchor: null };
function openPopover(anchor, build, pick, { focus } = {}) {
  closePopover();
  const el = $("#popover");
  // A modal dialog makes the rest of the page inert, so the menu has to live inside it.
  const host = anchor.closest("dialog") || document.body;
  if (el.parentElement !== host) host.appendChild(el);
  const items = build();
  el.innerHTML = items.map((it, i) => it.sep ? "<hr>" : `<button type="button" role="menuitem" data-pi="${i}" class="${it.danger ? "danger-text" : ""} ${it.selected ? "selected" : ""}" ${it.disabled ? "disabled" : ""}>
    ${it.img ? `<img class="pi-img" src="${src(it.img)}" alt="">` : it.icon ? icon(it.icon, 16) : ""}<span class="pi-label">${esc(it.label)}</span>${it.selected ? `<span class="pi-check">${icon("checkSmall", 15, 2.2)}</span>` : ""}</button>`).join("");
  el.hidden = false;
  Object.assign(popover, { el, anchorKey: anchor.dataset.menuKey || null, build, pick, anchor, items, openedAt: performance.now() });
  anchor.setAttribute("aria-expanded", "true");
  placePopover(anchor);
  const btns = $$("button:not([disabled])", el);
  (btns.find((b) => items[+b.dataset.pi].id === focus) || btns.find((b) => b.classList.contains("selected")) || btns[0])?.focus();
}
function placePopover(anchor) {
  const el = popover.el;
  const r = anchor.getBoundingClientRect();
  el.style.minWidth = `${Math.max(176, r.width)}px`;
  const mh = el.offsetHeight;
  const mw = el.offsetWidth;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8, r.left))}px`;
  if (anchor.dataset.menuAlign === "right" || r.left + mw > innerWidth - 8) el.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
}
function closePopover() {
  if (!popover.el || popover.el.hidden) return;
  popover.el.hidden = true;
  popover.anchor?.setAttribute("aria-expanded", "false");
  popover.anchor = null;
  popover.anchorKey = null;
}
// After a re-render: reopen on the new copy of the anchor, or close if it is gone.
function reanchorPopover(state) {
  if (!state) return;
  const anchor = state.key && document.querySelector(`[data-menu-key="${CSS.escape(state.key)}"]`);
  if (anchor) openPopover(anchor, state.build, state.pick, { focus: state.focus });
}
function popoverState() {
  if (!popover.el || popover.el.hidden || !popover.anchorKey) return null;
  return { key: popover.anchorKey, build: popover.build, pick: popover.pick, focus: popover.items?.[+document.activeElement?.dataset?.pi]?.id };
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("#popover [data-pi]");
  if (b) {
    const it = popover.items[+b.dataset.pi];
    const pick = popover.pick;
    const anchor = popover.anchor;
    closePopover();
    if (it && !it.disabled) pick(it, anchor);
    return;
  }
  if (popover.anchor && !e.target.closest("#popover") && !popover.anchor.contains(e.target)) closePopover();
});
document.addEventListener("keydown", (e) => {
  if (!popover.el || popover.el.hidden) return;
  const btns = $$("button:not([disabled])", popover.el);
  const i = btns.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const a = popover.anchor; closePopover(); a?.focus(); }
  if (e.key === "Tab") closePopover();
}, true);
window.addEventListener("resize", closePopover);
// Scrolling closes the menu, except the scroll the browser does to bring its button into view.
document.addEventListener("scroll", (e) => {
  if (popover.el?.contains(e.target) || performance.now() - (popover.openedAt || 0) < 250) return;
  closePopover();
}, true);

/* ---------- Styled selects ---------- */
// Keeps the native <select> (forms, values, change events) and draws a matching button + popover.
// A patched page can keep the same <select> but drop its button and markers, so this runs on every
// render and only binds each select's change listener once.
const csBound = new WeakSet();
function upgradeSelects(root = document) {
  // Buttons whose select is gone (or no longer next to them) are left over from a patch.
  for (const btn of $$(".cselect", root)) if (btn.previousElementSibling?.tagName !== "SELECT") btn.remove();
  for (const sel of $$("select", root)) {
    sel.classList.add("cs-native");
    if (sel.nextElementSibling?.classList.contains("cselect")) { refreshSelect(sel); continue; }
    sel.dataset.cs = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cselect ${sel.dataset.csClass || ""}`;
    btn.setAttribute("aria-haspopup", "listbox");
    if (sel.id) btn.id = `cs-${sel.id}`;
    btn.dataset.menuKey = `cs:${sel.id || sel.name || Math.random().toString(36).slice(2)}`;
    if (sel.getAttribute("aria-label")) btn.setAttribute("aria-label", sel.getAttribute("aria-label"));
    sel.after(btn);
    btn.addEventListener("click", () => {
      if (popover.anchor === btn) return closePopover();
      openPopover(btn, () => [...sel.options].map((o) => ({ id: o.value, label: o.textContent, img: o.dataset.img, selected: o.value === sel.value })), (it) => {
        sel.value = it.id;
        refreshSelect(sel);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
    if (!csBound.has(sel)) { csBound.add(sel); sel.addEventListener("change", () => refreshSelect(sel)); }
    refreshSelect(sel);
  }
}
function refreshSelect(sel) {
  const btn = sel.nextElementSibling;
  if (!btn?.classList.contains("cselect")) return;
  const o = sel.options[sel.selectedIndex];
  btn.innerHTML = `${o?.dataset.img ? `<img class="pi-img" src="${src(o.dataset.img)}" alt="">` : ""}<span class="cs-label">${esc(o ? o.textContent : "")}</span>${icon("chevron", 16)}`;
}
const refreshSelects = (root = document) => $$("select[data-cs]", root).forEach(refreshSelect);

/* ---------- Images fade in when loaded ---------- */
const markLoaded = (e) => { if (e.target.tagName === "IMG") e.target.classList.add("loaded"); };
document.addEventListener("load", markLoaded, true);
document.addEventListener("error", markLoaded, true);

/* ---------- Lightbox ---------- */
function openLightbox(url, caption = "") {
  if (!safeUrl(url)) return;
  const lb = $("#lightbox");
  lb.innerHTML = `<figure><img src="${src(url)}" alt="${esc(caption)}">${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>
    <div class="lb-actions"><button class="icon-btn round" data-download="${src(url)}" data-name="${esc(caption || "image")}" title="Download">${icon("download", 19)}</button><button class="icon-btn round lb-close" title="Close">${icon("x", 20)}</button></div>`;
  lb.hidden = false;
  lb.querySelector(".lb-close").focus();
}
document.addEventListener("click", (e) => {
  const lb = $("#lightbox");
  if (!lb || lb.hidden) return;
  if (e.target === lb || e.target.closest(".lb-close")) lb.hidden = true;
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#lightbox").hidden) $("#lightbox").hidden = true; });

/* ---------- Chat formatting (Discord-style markdown, safe) ---------- */
// `mention(id)` renders a <@id> token (a teammate mention) as HTML.
function formatMessage(text, { mention } = {}) {
  const blocks = [];
  const keep = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  // Pull code and links out first so nothing inside them gets formatted.
  let s = String(text || "").replace(/\u0000/g, "").replace(/```(?:[a-z0-9]*\n)?([\s\S]*?)```/gi, (_, code) => `\u0000${blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`) - 1}\u0000`);
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`));
  s = s.replace(/<@([A-Za-z0-9_-]+)>/g, (_, id) => keep(mention ? mention(id) : "@someone"));
  s = s.replace(/https?:\/\/[^\s<>"'`\u0000]+[^\s<>"'`\u0000.,:;)\]]/g, (url) => keep(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1<em>$2</em>");
  s = s.split("\n").map((line) => (line.startsWith("&gt; ") ? `<span class="md-quote">${line.slice(5)}</span>` : line)).join("\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/* ---------- Images ---------- */
function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This file isn't an image the browser can read."));
    img.src = src;
  });
}
// Resizes an image to fit `max` pixels (and crops to a square when asked), returning a Blob.
async function resizeImage(file, { max = 1600, square = false, quality = 0.85 } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
    if (square) { const side = Math.min(sw, sh); sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side; }
    const scale = Math.min(1, max / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const type = file.type === "image/png" || file.type === "image/svg+xml" ? "image/png" : "image/jpeg";
    let blob = await new Promise((r) => canvas.toBlob(r, type, quality));
    if (type === "image/png" && blob.size > 400 * 1024) blob = await new Promise((r) => canvas.toBlob(r, "image/webp", quality));
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function imageSize(file) {
  const url = URL.createObjectURL(file);
  try { const img = await loadImage(url); return { width: img.naturalWidth, height: img.naturalHeight }; } catch { return {}; } finally { URL.revokeObjectURL(url); }
}
const isImageType = (t) => /^image\//.test(t || "");
const isGif = (f) => f?.type === "image/gif" || /\.gif$/i.test(f?.name || "");

/* ---------- Drafts: typed text survives live re-renders ---------- */
const drafts = {};
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id && el.type !== "password" && el.closest("[data-drafts]")) drafts[el.id] = el.type === "checkbox" ? el.checked : el.value;
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id && el.type === "checkbox" && el.closest("[data-drafts]")) drafts[el.id] = el.checked;
});
function restoreDrafts(root) {
  for (const [id, value] of Object.entries(drafts)) {
    const el = root.querySelector(`#${CSS.escape(id)}`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = value;
    else if (el.value !== value) el.value = value;
  }
}
const clearAllDrafts = () => { for (const k of Object.keys(drafts)) delete drafts[k]; };
function clearDrafts(form) {
  for (const el of $$("[id]", form)) delete drafts[el.id];
}

/* ---------- Drop zones ---------- */
// Any element with data-drop="<name>" accepts dropped files; the app handles them in onDrop.
let dropDepth = 0;
function setupDropZones(onDrop) {
  const zoneOf = (e) => e.target.closest?.("[data-drop]");
  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    const z = zoneOf(e);
    $$(".drop-active").forEach((x) => x !== z && x.classList.remove("drop-active"));
    if (z) { z.classList.add("drop-active"); dropDepth++; }
  });
  document.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    const z = zoneOf(e);
    e.dataTransfer.dropEffect = z ? "copy" : "none";
  });
  document.addEventListener("dragleave", (e) => {
    const z = zoneOf(e);
    if (z && !z.contains(e.relatedTarget)) z.classList.remove("drop-active");
  });
  document.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    $$(".drop-active").forEach((x) => x.classList.remove("drop-active"));
    const z = zoneOf(e);
    if (z) onDrop(z.dataset.drop, [...e.dataTransfer.files], z);
  });
}
