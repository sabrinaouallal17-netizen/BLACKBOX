"use strict";

/* ---------- Presence ---------- */
// Profiles carry lastSeen (refreshed every minute while the app is open) and away (tab hidden or
// no input for 5 minutes). Online: seen in the last 2.5 minutes and not away; then offline.
const PRESENCE_FRESH = 150000;
const IDLE_AFTER = 5 * 60000;
const PRESENCE_LABEL = { online: "Online", away: "Away", offline: "Offline" };
let lastInput = Date.now();
let presenceSent = { at: 0, away: null };

const amAway = () => document.visibilityState === "hidden" || Date.now() - lastInput > IDLE_AFTER;
function sendPresence(force = false) {
  if (!user || !db) return;
  const away = amAway();
  const now = Date.now();
  if (!force && presenceSent.away === away && now - presenceSent.at < 55000 && profiles[user.uid]?.lastSeen) return;
  presenceSent = { at: now, away };
  db.collection("profiles").doc(user.uid).set({ lastSeen: now, away }, { merge: true }).catch((e) => console.error("BLACKBOX: presence", e));
}
function presenceOf(uid) {
  if (uid === user?.uid) return amAway() ? "away" : "online";
  const p = profiles[uid];
  if (!p?.lastSeen || Date.now() - p.lastSeen > PRESENCE_FRESH) return "offline";
  return p.away ? "away" : "online";
}
const presenceDot = (uid) => `<i class="pres pres-${presenceOf(uid)}" title="${PRESENCE_LABEL[presenceOf(uid)]}"></i>`;
const avatarP = (uid, size = 36, name) => `<span class="pres-wrap">${avatar(uid, size, name)}${presenceDot(uid)}</span>`;

setInterval(() => {
  if (!user) return;
  sendPresence();
  // Statuses age without any data change: refresh the pages that show them.
  if (["chat", "team"].includes(route().name)) scheduleRender();
}, 15000);
for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  document.addEventListener(ev, () => {
    const wasAway = Date.now() - lastInput > IDLE_AFTER;
    lastInput = Date.now();
    if (wasAway) sendPresence(true);
  }, { passive: true, capture: true });
}
document.addEventListener("visibilitychange", () => sendPresence(true));
window.addEventListener("pagehide", () => {
  if (user && db) db.collection("profiles").doc(user.uid).set({ lastSeen: Date.now() - PRESENCE_FRESH, away: true }, { merge: true }).catch(() => {});
});

// Chat sidebar: members grouped by status, like Discord.
function membersHtml(p) {
  const groups = { online: [], away: [], offline: [] };
  for (const id of p.memberIds) groups[presenceOf(id)].push(id);
  return Object.entries(groups).filter(([, ids]) => ids.length).map(([k, ids]) => `<div class="side-label pres-label">${PRESENCE_LABEL[k]} — ${ids.length}</div>
    <ul class="pres-group ${k}">${ids.sort((a, b) => memberName(a).localeCompare(memberName(b))).map((id) => `<li>${avatarP(id, 32)}<div class="who"><div class="name ellipsis">${esc(memberName(id))}</div><div class="sub ellipsis">${esc(profiles[id]?.title || ROLES[roleOf(id)].label)}</div></div></li>`).join("")}</ul>`).join("");
}

/* ---------- Typing indicator ---------- */
// One document per person (projects/<id>/typing/<uid>), rewritten at most every 3 seconds while typing
// and removed on send. Indicators older than 6 seconds are ignored.
const TYPING_TTL = 6000;
let typingDocs = {};
let typingSentAt = 0;
let typingChannel = null;
let typingTick = null;

onProject(() => listen(() => sub("typing"), (snap) => {
  typingDocs = {};
  snap.forEach((d) => { typingDocs[d.id] = d.data(); });
  if (typersNow().length && !typingTick) {
    typingTick = setInterval(() => {
      if (!typersNow().length) { clearInterval(typingTick); typingTick = null; }
      if (route().name === "chat") scheduleRender();
    }, 1500);
  }
  if (route().name === "chat") scheduleRender();
}));
function typersNow() {
  const now = Date.now();
  return Object.entries(typingDocs).filter(([uid, t]) => uid !== user?.uid && t.channel === channelId && now - t.at < TYPING_TTL && project()?.memberIds?.includes(uid)).map(([uid]) => uid);
}
function typingHtml() {
  const ids = typersNow();
  const n = ids.map((id) => `<b>${esc(memberName(id))}</b>`);
  const text = ids.length === 1 ? `${n[0]} is typing…`
    : ids.length === 2 ? `${n[0]} and ${n[1]} are typing…`
    : ids.length === 3 ? `${n[0]}, ${n[1]} and ${n[2]} are typing…`
    : "Several people are typing…";
  return `<div class="typing-line ${ids.length ? "on" : ""}" aria-live="polite">${ids.length ? `<span class="typing-dots"><i></i><i></i><i></i></span><span class="ellipsis">${text}</span>` : ""}</div>`;
}
function noteTyping(el) {
  if (!user || !currentId || !can("chat") || BB_READONLY()) return;
  if (!el.value.trim()) return stopTyping();
  const now = Date.now();
  if (typingChannel === channelId && now - typingSentAt < 3000) return;
  typingSentAt = now;
  typingChannel = channelId;
  sub("typing").doc(user.uid).set({ channel: channelId, at: now, name: storedName() }).catch((e) => console.error("BLACKBOX: typing", e));
}
function stopTyping() {
  if (!typingSentAt || !currentId || !user) return;
  typingSentAt = 0;
  typingChannel = null;
  sub("typing").doc(user.uid).delete().catch((e) => console.error("BLACKBOX: typing", e));
}
document.addEventListener("input", (e) => { if (e.target.id === "chat-text") noteTyping(e.target); });
document.addEventListener("focusout", (e) => { if (e.target.id === "chat-text") stopTyping(); });
window.addEventListener("hashchange", () => stopTyping());

/* ---------- Reactions ---------- */
// Stored on the message as reactions: { key: [uid, …] }; keys are plain names so they work as field paths.
const REACTIONS = {
  like: "👍", heart: "❤️", laugh: "😂", wow: "😮", sad: "😢", angry: "😡", fire: "🔥", party: "🎉",
  clap: "👏", eyes: "👀", check: "✅", cross: "❌", hundred: "💯", pray: "🙏", rocket: "🚀", think: "🤔",
  skull: "💀", star: "⭐", love: "😍", cool: "😎", bug: "🐛", game: "🎮", trophy: "🏆", gem: "💎",
};
const REACTION_KEYS = Object.keys(REACTIONS);
function whoReacted(ids) {
  const names = ids.map((id) => (id === user?.uid ? "You" : memberName(id)));
  if (names.length <= 3) return names.join(names.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, " and $1");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} other${names.length - 3 === 1 ? "" : "s"}`;
}
function reactionsHtml(m) {
  const list = REACTION_KEYS.map((k) => [k, m.reactions?.[k]]).filter(([, ids]) => Array.isArray(ids) && ids.length);
  if (!list.length) return "";
  return `<div class="reactions">${list.map(([k, ids]) => {
    const mine = ids.includes(user.uid);
    return `<button type="button" class="react-chip ${mine ? "mine" : ""}" data-react="${esc(m.id)}" data-key="${k}" aria-pressed="${mine}" aria-label="${REACTIONS[k]} ${ids.length}: ${esc(whoReacted(ids))}">
      <span class="emoji">${REACTIONS[k]}</span><span class="n">${ids.length}</span>
      <span class="react-who" role="tooltip"><span class="big">${REACTIONS[k]}</span><span>${esc(whoReacted(ids))} reacted</span></span></button>`;
  }).join("")}${can("chat") ? `<button type="button" class="react-chip react-add" data-react-pick="${esc(m.id)}" title="Add reaction" aria-label="Add reaction">${icon("smile", 16)}</button>` : ""}</div>`;
}
async function toggleReaction(id, key) {
  if (!can("chat")) return toast("Your role in this project can't do that.", true);
  const m = messages.find((x) => x.id === id) || pinned.find((x) => x.id === id);
  if (!m || !REACTIONS[key]) return;
  const mine = (m.reactions?.[key] || []).includes(user.uid);
  await act(() => msgCol().doc(id).update({ [`reactions.${key}`]: mine ? FV().arrayRemove(user.uid) : FV().arrayUnion(user.uid) }));
}
// Emoji picker floating next to the button that opened it.
let reactPickFor = null;
function openReactPicker(btn) {
  let box = $("#react-picker");
  if (!box) {
    box = document.createElement("div");
    box.id = "react-picker";
    box.className = "react-picker";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Add reaction");
    document.body.appendChild(box);
  }
  reactPickFor = btn.dataset.reactPick;
  box.innerHTML = REACTION_KEYS.map((k) => `<button type="button" data-react-choose="${k}" title=":${k}:">${REACTIONS[k]}</button>`).join("");
  box.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  box.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : Math.min(innerHeight - h - 8, r.bottom + 8)}px`;
  box.querySelector("button")?.focus({ preventScroll: true });
}
function closeReactPicker() {
  const box = $("#react-picker");
  if (box) box.hidden = true;
  reactPickFor = null;
}

/* ---------- Pinned messages ---------- */
let pinned = [];
let pinsKey = "";
let pinsUnsub = null;
let pinsOpen = false;
let flashMsg = null;
// Pinned messages of the open channel, listened to separately (they can be older than the loaded ones).
function ensurePins() {
  const key = `${currentId}:${channelId}`;
  if (key === pinsKey) return;
  pinsUnsub?.();
  pinsKey = key;
  pinned = [];
  const cid = channelId;
  pinsUnsub = listen(() => msgCol(cid).where("pinned", "==", true), (snap) => {
    pinned = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
    scheduleRender();
  });
}
function pinsButton() {
  ensurePins();
  return `<button type="button" class="icon-btn bare pins-btn ${pinsOpen ? "on" : ""}" data-action="toggle-pins" title="Pinned messages" aria-expanded="${pinsOpen}">${icon("pin", 18)}${pinned.length ? `<span class="pins-count">${pinned.length}</span>` : ""}</button>`;
}
function pinsPanel() {
  if (!pinsOpen) return "";
  return `<div class="pins-panel" role="dialog" aria-label="Pinned messages">
    <div class="pins-head">${icon("pin", 17)}<b>Pinned messages</b><span class="spacer"></span><button type="button" class="icon-btn bare" data-action="toggle-pins" title="Close">${icon("x", 16)}</button></div>
    ${pinned.length ? `<ul class="pins-list">${pinned.map((m) => `<li class="pin-item">
      ${avatar(m.uid, 32, nameOf(m.uid, m.name))}
      <div class="pin-body">
        <div class="msg-head"><b style="color:${nameColor(m.uid)}">${esc(nameOf(m.uid, m.name))}</b><span class="msg-time">${msgTime(m.at)}</span></div>
        ${m.text ? `<div class="msg-text">${formatMessage(m.text, { mention: renderMention })}</div>` : ""}
        ${m.attachments?.length ? `<div class="muted small">${icon("paperclip", 13)} ${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}</div>` : ""}
        <div class="pin-meta muted small">Pinned by ${esc(memberName(m.pinnedBy))} · ${timeAgo(m.pinnedAt)}</div>
      </div>
      <div class="pin-actions"><button type="button" class="btn small" data-jump-msg="${esc(m.id)}">Jump</button>
        ${can("edit") ? `<button type="button" class="icon-btn bare" data-pin-msg="${esc(m.id)}" title="Unpin">${icon("x", 15)}</button>` : ""}</div>
    </li>`).join("")}</ul>` : `<div class="empty pins-empty">${icon("pin", 26)}<p>No pinned messages in #${esc(channel().name)} yet.</p><p class="muted small">Hover a message and click the pin to keep it here for everyone.</p></div>`}
  </div>`;
}
const pinnedMark = (m) => (m.pinned ? `<div class="pinned-mark">${icon("pin", 13)}Pinned${m.pinnedBy ? ` by ${esc(memberName(m.pinnedBy))}` : ""}</div>` : "");
async function togglePin(id) {
  if (!can("edit")) return toast("Your role in this project can't pin messages.", true);
  const m = messages.find((x) => x.id === id) || pinned.find((x) => x.id === id);
  if (!m) return;
  const on = !m.pinned;
  const ok = await act(() => msgCol().doc(id).update(on ? { pinned: true, pinnedBy: user.uid, pinnedAt: Date.now() } : { pinned: false, pinnedBy: "", pinnedAt: 0 }), on ? "Message pinned" : "Message unpinned");
  if (ok) log("message.pin", on ? "pinned a message in" : "unpinned a message in", `#${channel().name}`, "Chat", { detail: detokenizeMentions(m.text || "").slice(0, 120) });
}
ACT_TYPES["message.pin"] = ["pin", "purple", "project"];
// Scrolls to a loaded message and highlights it for a moment.
function jumpToMessage(id) {
  const el = document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  if (!el) return toast("This message is older than the ones loaded in the chat.", true);
  pinsOpen = false;
  flashMsg = id;
  render();
  document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => { if (flashMsg === id) { flashMsg = null; scheduleRender(); } }, 1800);
}
// Hover actions added to each message (react, pin).
function chatMsgActions(m) {
  return `${can("chat") ? `<button class="icon-btn bare" data-react-pick="${esc(m.id)}" title="Add reaction">${icon("smile", 15)}</button>` : ""}${can("edit") ? `<button class="icon-btn bare ${m.pinned ? "on" : ""}" data-pin-msg="${esc(m.id)}" title="${m.pinned ? "Unpin" : "Pin"}">${icon("pin", 15)}</button>` : ""}`;
}

/* ---------- Voice messages ---------- */
// Record with the microphone, listen back, then send it like any attachment (with its duration and
// waveform peaks). Recording stops by itself after 5 minutes.
const VOICE_MAX = 300;
let voice = null; // { state: "recording" | "preview", … }

async function startVoice() {
  if (voice) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return toast("Voice messages aren't supported in this browser.", true);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.error("BLACKBOX: microphone", e);
    return toast(e.name === "NotAllowedError" || e.name === "SecurityError" ? "Microphone access is blocked. Allow it for this site in your browser settings, then try again."
      : e.name === "NotFoundError" ? "No microphone found. Plug one in and try again." : "The microphone couldn't start.", true);
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
  let rec;
  try {
    rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined);
  } catch (e) {
    console.error("BLACKBOX: recorder", e);
    stream.getTracks().forEach((t) => t.stop());
    return toast("Voice messages aren't supported in this browser.", true);
  }
  const v = { state: "recording", rec, stream, chunks: [], start: Date.now(), samples: [], type: rec.mimeType || type || "audio/webm" };
  voice = v;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    Object.assign(v, { ctx, analyser: an, buf: new Uint8Array(an.fftSize) });
  } catch (e) {
    console.error("BLACKBOX: audio level meter", e); // the recording still works, with a flat waveform
  }
  rec.ondataavailable = (e) => { if (e.data.size) v.chunks.push(e.data); };
  rec.onstop = () => finishVoice(v);
  rec.start(250);
  v.timer = setInterval(() => tickVoice(v), 100);
  render();
}
function voiceLevel(v) {
  if (!v.analyser) return 0.15;
  v.analyser.getByteTimeDomainData(v.buf);
  let sum = 0;
  for (const x of v.buf) sum += ((x - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / v.buf.length) * 4);
}
function tickVoice(v) {
  if (voice !== v || v.state !== "recording") return;
  v.samples.push(voiceLevel(v));
  const secs = (Date.now() - v.start) / 1000;
  const t = $("#voice-timer");
  if (t) t.textContent = fmtDuration(secs);
  const bars = $("#voice-live");
  if (bars) bars.innerHTML = v.samples.slice(-48).map((s) => `<i style="height:${Math.max(10, Math.round(s * 100))}%"></i>`).join("");
  if (secs >= VOICE_MAX) stopVoice();
}
function stopVoice() {
  if (voice?.state !== "recording") return;
  clearInterval(voice.timer);
  voice.duration = (Date.now() - voice.start) / 1000;
  voice.rec.stop();
}
function finishVoice(v) {
  v.stream.getTracks().forEach((t) => t.stop());
  v.ctx?.close().catch(() => {});
  if (voice !== v) return; // cancelled
  if (v.duration < 0.8 || !v.chunks.length) {
    voice = null;
    render();
    return toast("That recording was too short.", true);
  }
  v.blob = new Blob(v.chunks, { type: v.type.split(";")[0] });
  v.url = URL.createObjectURL(v.blob);
  // 40 peaks from 1 to 9, drawn as the waveform for everyone.
  const n = 40;
  const per = v.samples.length / n;
  const peaks = Array.from({ length: n }, (_, i) => Math.max(...v.samples.slice(Math.floor(i * per), Math.max(Math.floor(i * per) + 1, Math.floor((i + 1) * per))), 0));
  const top = Math.max(...peaks, 0.05);
  v.peaks = peaks.map((p) => Math.max(1, Math.round((p / top) * 9)));
  v.state = "preview";
  render();
}
function cancelVoice() {
  const v = voice;
  voice = null;
  if (!v) return;
  clearInterval(v.timer);
  if (v.state === "recording") { try { v.rec.stop(); } catch { /* already stopped */ } }
  if (v.url) URL.revokeObjectURL(v.url);
  render();
}
function sendVoice() {
  const v = voice;
  if (!v || v.state !== "preview") return;
  voice = null;
  const ext = v.blob.type.includes("mp4") ? "m4a" : v.blob.type.includes("ogg") ? "ogg" : "webm";
  const file = new File([v.blob], `voice-message.${ext}`, { type: v.blob.type });
  const extra = { duration: Math.round(v.duration * 10) / 10, peaks: v.peaks };
  URL.revokeObjectURL(v.url);
  const entry = { id: `out-${Math.random().toString(36).slice(2)}`, pid: currentId, channel: channelId, text: "", files: [{ id: "voice", file, kind: "audio", preview: "", extra }], at: Date.now(), state: "sending", posted: 0 };
  outbox.push(entry);
  render();
  scrollChatDown();
  processOutbox(entry);
}
// Replaces the composer row while recording or listening back.
function voiceComposer() {
  if (!voice) return "";
  if (voice.state === "recording") {
    return `<div class="voice-rec recording">
      <button type="button" class="icon-btn bare danger-text" data-action="voice-cancel" title="Cancel recording">${icon("trash", 18)}</button>
      <span class="rec-dot" aria-hidden="true"></span>
      <div class="voice-live-wrap" data-keep="voice-live:${voice.start}"><span id="voice-timer" class="voice-timer">0:00</span><div id="voice-live" class="voice-live" aria-hidden="true"></div></div>
      <span class="muted small rec-max">max ${fmtDuration(VOICE_MAX)}</span>
      <button type="button" class="btn primary" data-action="voice-stop" title="Stop recording">${icon("stop", 16)}Stop</button>
    </div>`;
  }
  return `<div class="voice-rec preview">
    <button type="button" class="icon-btn bare danger-text" data-action="voice-cancel" title="Delete recording">${icon("trash", 18)}</button>
    <div class="voice" data-voice data-keep="voice-preview:${esc(voice.url)}">
      <button type="button" class="voice-play" data-voice-play title="Play">${icon("play", 16)}</button>
      <div class="voice-wave" data-voice-seek>${voice.peaks.map((p) => `<i style="height:${Math.max(18, p * 11)}%"></i>`).join("")}</div>
      <span class="voice-time" data-total="${fmtDuration(voice.duration)}" data-dur="${voice.duration}">${fmtDuration(voice.duration)}</span>
      <audio preload="auto" src="${esc(voice.url)}"></audio>
    </div>
    <button type="button" class="btn primary" data-action="voice-send" title="Send voice message">${icon("send", 16)}Send</button>
  </div>`;
}
const voiceButton = () => `<button type="button" class="icon-btn bare round-sm mic-btn" data-action="voice-start" title="Record a voice message">${icon("mic", 19)}</button>`;

/* ---------- Media players ---------- */
// Voice players: play/pause, waveform progress (click to seek), elapsed time. Media events don't
// bubble, so they are caught at the document during capture.
let playingAudio = null;
function voiceDuration(box, a) {
  return Number.isFinite(a.duration) && a.duration > 0 ? a.duration : +box.querySelector(".voice-time")?.dataset.dur || 0;
}
function paintVoice(a, ev) {
  const box = a.closest(".voice");
  if (!box) return;
  const dur = voiceDuration(box, a);
  if (ev === "ended") a.currentTime = 0;
  const playing = !a.paused && !a.ended;
  const p = dur ? Math.min(1, a.currentTime / dur) : 0;
  box.classList.toggle("playing", playing);
  const btn = box.querySelector("[data-voice-play]");
  if (btn) { btn.innerHTML = icon(playing ? "pause" : "play", 16); btn.title = playing ? "Pause" : "Play"; }
  const bars = box.querySelectorAll(".voice-wave i");
  bars.forEach((b, i) => b.classList.toggle("on", (i + 0.5) / bars.length <= p));
  const t = box.querySelector(".voice-time");
  if (t) t.textContent = playing || a.currentTime > 0 ? fmtDuration(a.currentTime) : t.dataset.total;
}
for (const ev of ["play", "pause", "ended", "timeupdate"]) {
  document.addEventListener(ev, (e) => {
    if (e.target.tagName !== "AUDIO" && e.target.tagName !== "VIDEO") return;
    if (ev === "play") {
      // One thing plays at a time.
      document.querySelectorAll("audio, video").forEach((m) => { if (m !== e.target && !m.paused) m.pause(); });
      if (e.target.tagName === "AUDIO") playingAudio = e.target;
    }
    if (e.target.tagName === "AUDIO") paintVoice(e.target, ev);
  }, true);
}
document.addEventListener("error", (e) => {
  if (e.target.tagName === "AUDIO" && e.target.closest(".voice")) console.error("BLACKBOX: voice message can't play", e.target.error);
}, true);

/* ---------- Events ---------- */
document.addEventListener("click", (e) => {
  if (!user) return;
  if (reactPickFor && !e.target.closest("#react-picker, [data-react-pick]")) closeReactPicker();
  const t = e.target.closest("[data-voice-play],[data-voice-seek],[data-react],[data-react-pick],[data-react-choose],[data-pin-msg],[data-jump-msg]");
  if (!t) return;
  const d = t.dataset;
  if (d.voicePlay !== undefined) {
    const a = t.closest(".voice")?.querySelector("audio");
    if (!a) return;
    if (a.paused) a.play().catch((err) => { console.error("BLACKBOX: voice play", err); toast("This voice message can't be played in this browser.", true); });
    else a.pause();
    return;
  }
  if (d.voiceSeek !== undefined) {
    const box = t.closest(".voice");
    const a = box?.querySelector("audio");
    const dur = a && voiceDuration(box, a);
    if (!dur) return;
    const r = t.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
    paintVoice(a);
    return;
  }
  if (d.react) return toggleReaction(d.react, d.key);
  if (d.reactPick) { e.stopPropagation(); return reactPickFor === d.reactPick ? closeReactPicker() : openReactPicker(t); }
  if (d.reactChoose) { const id = reactPickFor; closeReactPicker(); if (id) toggleReaction(id, d.reactChoose); return; }
  if (d.pinMsg) return togglePin(d.pinMsg);
  if (d.jumpMsg) return jumpToMessage(d.jumpMsg);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && reactPickFor) { closeReactPicker(); return; }
  if (e.key === "Escape" && pinsOpen && route().name === "chat") { pinsOpen = false; render(); }
});
document.addEventListener("scroll", (e) => { if (reactPickFor && e.target.id === "chat-log") closeReactPicker(); }, true);

Object.assign(actions, {
  "toggle-pins": () => { pinsOpen = !pinsOpen; render(); },
  "voice-start": () => startVoice(),
  "voice-stop": () => stopVoice(),
  "voice-cancel": () => cancelVoice(),
  "voice-send": () => sendVoice(),
});
Object.assign(ACTION_PERMS, { "voice-start": "chat", "voice-send": "chat" });

onProjectReset(() => {
  typingDocs = {};
  typingSentAt = 0;
  typingChannel = null;
  pinsUnsub?.();
  pinsUnsub = null;
  pinsKey = "";
  pinned = [];
  pinsOpen = false;
  closeReactPicker();
  if (voice) cancelVoice();
});
window.addEventListener("hashchange", () => {
  pinsOpen = false;
  closeReactPicker();
  if (voice && route().name !== "chat") cancelVoice();
});
