"use strict";

/* ---------- Notifications ---------- */
// Stored per project (projects/<id>/notifications) with the recipient in `to`; each person listens
// to their own across every project they belong to.
let notifs = {};                  // project id -> notifications for me
const notifUnsubs = new Map();
let notifOpen = false;

function watchNotifications() {
  const uid = user.uid;
  for (const [pid, unsub] of notifUnsubs) if (!projects[pid]) { unsub(); notifUnsubs.delete(pid); delete notifs[pid]; }
  for (const pid of Object.keys(projects)) {
    if (notifUnsubs.has(pid)) continue;
    let first = true;
    notifUnsubs.set(pid, projectsCol().doc(pid).collection("notifications").where("to", "==", uid).onSnapshot((snap) => {
      const before = new Set((notifs[pid] || []).map((n) => n.id));
      notifs[pid] = snap.docs.map((d) => ({ id: d.id, pid, ...d.data() }));
      if (!first) {
        const fresh = notifs[pid].filter((n) => !before.has(n.id) && !n.read);
        if (fresh.length) toast(notifPlain(fresh[0]));
      }
      first = false;
      scheduleRender();
    }, (e) => console.error("BLACKBOX: notifications listener", e)));
  }
}
function stopNotifications() {
  notifUnsubs.forEach((u) => u());
  notifUnsubs.clear();
  notifs = {};
  notifOpen = false;
}
const allNotifs = () => Object.values(notifs).flat().sort((a, b) => b.at - a.at);
const unreadCount = () => allNotifs().filter((n) => !n.read).length;

async function notify(to, type, text, link, pid = currentId) {
  if (!to || !user || to === user.uid || !projects[pid]?.memberIds?.includes(to)) return;
  try {
    await projectsCol().doc(pid).collection("notifications").add({ to, from: user.uid, fromName: storedName(), type, text: String(text || "").slice(0, 200), link: link || "", at: Date.now(), read: false });
  } catch (e) {
    console.error("BLACKBOX: notify failed", e);
  }
}
const NOTIF_ICONS = { mention: ["at", "purple"], assign: ["check", "blue"], update: ["rocket", "green"], role: ["shield", "orange"] };
// Same sentence as notifText, as plain text (for the toast).
function notifPlain(n) {
  const who = nameOf(n.from, n.fromName);
  const proj = projects[n.pid]?.name || "a project";
  return { mention: `${who} mentioned you in ${proj}: “${n.text}”`, assign: `${who} assigned you ${n.text} in ${proj}`, update: `${who} published ${n.text} in ${proj}`, role: `${who} made you ${n.text} in ${proj}` }[n.type] || `${who}: ${n.text}`;
}
function notifText(n) {
  const who = `<b>${esc(nameOf(n.from, n.fromName))}</b>`;
  const proj = esc(projects[n.pid]?.name || "a project");
  if (n.type === "mention") return `${who} mentioned you in ${proj}: “${esc(n.text)}”`;
  if (n.type === "assign") return `${who} assigned you <b>${esc(n.text)}</b> in ${proj}`;
  if (n.type === "update") return `${who} published <b>${esc(n.text)}</b> in ${proj}`;
  if (n.type === "role") return `${who} made you ${esc(n.text)} in ${proj}`;
  return `${who}: ${esc(n.text)}`;
}
function renderNotifPanel() {
  const bell = $("#bell");
  if (!bell) return;
  const unread = unreadCount();
  const fresh = whatsNewUnseen();
  $$(".bell").forEach((b) => { b.classList.toggle("has-dot", unread > 0 || fresh); b.setAttribute("aria-expanded", String(notifOpen)); });
  bell.title = unread ? `Notifications (${unread} unread)` : "Notifications";
  const panel = $("#notif-panel");
  panel.hidden = !notifOpen;
  if (!notifOpen) return;
  const list = allNotifs().slice(0, 60);
  patch(panel, `<div class="np-head"><b>Notifications</b>${unread ? `<span class="muted small">${unread} unread</span>` : ""}<span class="spacer"></span>${unread ? '<button class="link small" data-action="read-all">Mark all as read</button>' : ""}</div>
    ${list.length ? `<ul class="np-list">${list.map((n) => {
      const [ic, c] = NOTIF_ICONS[n.type] || ["mail", "blue"];
      return `<li><button class="np-item ${n.read ? "" : "unread"}" data-notif="${esc(n.pid)}/${esc(n.id)}">
        ${avatar(n.from, 34, nameOf(n.from, n.fromName))}<span class="act-badge c-${c}">${icon(ic, 14)}</span>
        <span class="np-text"><span>${notifText(n)}</span><span class="muted small">${timeAgo(n.at)}</span></span></button></li>`;
    }).join("")}</ul>` : `<div class="empty">${icon("bell", 26)}<p>You're all caught up.</p></div>`}
    <button class="np-foot ${fresh ? "fresh" : ""}" data-action="whats-new">${icon("sparkle", 15)}<span>What's new in BLACKBOX <b>v${APP_VERSION}</b></span>${fresh ? '<span class="dot"></span>' : ""}</button>`);
}
async function openNotif(key) {
  const [pid, id] = key.split("/");
  const n = (notifs[pid] || []).find((x) => x.id === id);
  if (!n) return;
  notifOpen = false;
  if (!n.read) projectsCol().doc(pid).collection("notifications").doc(id).update({ read: true }).catch((e) => console.error("BLACKBOX: mark read", e));
  if (pid !== currentId) selectProject(pid);
  location.hash = n.link || "#overview";
  render();
}
async function markAllRead() {
  const unread = allNotifs().filter((n) => !n.read);
  await act(async () => {
    for (const n of unread) await projectsCol().doc(n.pid).collection("notifications").doc(n.id).update({ read: true });
  });
}

/* ---------- Mentions ---------- */
// In stored text a mention is <@uid>; people type and read it as @Name.
function mentionables() {
  const p = project();
  return (p?.memberIds || []).map((id) => ({ id, name: memberName(id) })).filter((m) => m.name && m.name !== "Someone");
}
// `prefer` lists ids already mentioned (when editing), so an @Name keeps pointing at the same person.
function tokenizeMentions(text, prefer = []) {
  const people = mentionables().sort((a, b) => (prefer.includes(b.id) - prefer.includes(a.id)) || b.name.length - a.name.length);
  // Code stays as typed: mentions are only read outside `code` and ```blocks```.
  return String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, i) => {
    if (i % 2) return part;
    let out = part;
    for (const m of people) {
      const re = new RegExp(`@${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "giu");
      out = out.replace(re, `<@${m.id}>`);
    }
    return out;
  }).join("");
}
const detokenizeMentions = (text) => String(text || "").replace(/<@([A-Za-z0-9_-]+)>/g, (_, id) => `@${memberName(id)}`);
// Mentions outside code spans (a <@id> typed inside code is shown as text, not a mention).
const mentionedIds = (text) => [...new Set([...String(text || "").replace(/```[\s\S]*?```|`[^`\n]+`/g, "").matchAll(/<@([A-Za-z0-9_-]+)>/g)].map((m) => m[1]))];
const renderMention = (id) => `<span class="mention ${id === user?.uid ? "me" : ""}">@${esc(memberName(id))}</span>`;

// Autocomplete: typing @ in the composer lists teammates; arrows/Enter/Tab pick, Escape closes.
let mentionState = null; // { start, query, index, items }
function updateMentionPicker(el) {
  const caret = el.selectionStart;
  const before = el.value.slice(0, caret);
  const m = before.match(/(^|\s)@([^\s@]{0,30})$/);
  if (!m) return closeMentionPicker();
  const query = m[2].toLowerCase();
  const items = mentionables().filter((x) => x.id !== user.uid && x.name.toLowerCase().startsWith(query)).slice(0, 8);
  if (!items.length) return closeMentionPicker();
  mentionState = { start: caret - m[2].length - 1, query, index: Math.min(mentionState?.index || 0, items.length - 1), items };
  drawMentionPicker(el);
}
function drawMentionPicker(el) {
  const box = $("#mention-picker");
  const r = el.getBoundingClientRect();
  box.innerHTML = mentionState.items.map((x, i) => `<button type="button" class="${i === mentionState.index ? "active" : ""}" data-mention-pick="${i}">${avatar(x.id, 24)}<span class="ellipsis">${esc(x.name)}</span></button>`).join("");
  box.hidden = false;
  box.style.left = `${Math.max(8, r.left)}px`;
  box.style.bottom = `${innerHeight - r.top + 6}px`;
}
function closeMentionPicker() {
  mentionState = null;
  const box = $("#mention-picker");
  if (box) box.hidden = true;
}
function pickMention(i) {
  const el = $("#chat-text");
  if (!mentionState || !el) return;
  const x = mentionState.items[i];
  const caret = el.selectionStart;
  el.value = `${el.value.slice(0, mentionState.start)}@${x.name} ${el.value.slice(caret)}`;
  const pos = mentionState.start + x.name.length + 2;
  el.setSelectionRange(pos, pos);
  drafts[el.id] = el.value;
  closeMentionPicker();
  el.focus();
}
// Returns true when the key was used by the picker.
function mentionKey(e) {
  if (!mentionState) return false;
  const n = mentionState.items.length;
  if (e.key === "ArrowDown") mentionState.index = (mentionState.index + 1) % n;
  else if (e.key === "ArrowUp") mentionState.index = (mentionState.index - 1 + n) % n;
  else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionState.index); return true; }
  else if (e.key === "Escape") { closeMentionPicker(); return true; }
  else return false;
  e.preventDefault();
  drawMentionPicker(e.target);
  return true;
}
