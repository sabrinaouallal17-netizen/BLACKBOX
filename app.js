"use strict";

/* ---------- Setup ---------- */
// The Artifact edition (artifact/backend.js) provides a Firebase-compatible layer over claude.ai accounts.
const ARTIFACT = !!window.BLACKBOX_ARTIFACT;
// ?emulator in the URL points the app at the local Firebase emulators (used for development and tests).
const USE_EMULATOR = !ARTIFACT && new URLSearchParams(location.search).has("emulator");
const FB_CONFIG = ARTIFACT ? {} : USE_EMULATOR
  ? { apiKey: "demo-key", authDomain: "demo-blackbox.firebaseapp.com", projectId: "demo-blackbox" }
  : window.FIREBASE_CONFIG;
let auth = null;
let db = null;

/* ---------- State ---------- */
let user = null;          // signed-in account
let projects = {};        // id -> project data, live
let invites = [];         // projects inviting me, live (Firebase edition)
let profiles = {};        // uid -> profile (photo, name, title, contact email), live
let currentId = null;
let tasks = [];
let activity = [];
let messages = [];
let items = [];           // collection items of the current project
let assets = [];
let lists = {};           // table key -> ordered task ids, used by Up/Down
let taskFilter = { status: "all", owner: "all" };
let activityFilter = { type: "all", who: "all" };
let assetFilter = { kind: "all", q: "" };
let itemQuery = "";
let activityLimit = 100;
let unsubProjects = [];
let unsubCurrent = [];
let unsubActivity = null;
let subscribedId = null;  // project whose subcollections are being listened to
let deletingId = null;    // project being deleted; its settings page shows progress
let chatPending = [];     // files waiting to be sent: { id, file, preview }
let editingMsg = null;
let gifOpen = false;
let outbox = [];          // messages being sent: shown right away with local previews
let channelId = "general"; // channel whose messages are loaded
let unsubMessages = null;
let channelLatest = {};   // channel id -> time of its newest message (for unread dots)
const channelUnsubs = new Map();
let assetFolder = "";     // open folder in Assets ("" = top level)
let pendingWrites = 0;
let saveFailed = false;

const project = () => projects[currentId] || null;
function me() {
  if (!user) return null;
  const prof = profiles[user.uid] || {};
  return {
    uid: user.uid,
    name: prof.name || user.displayName || (user.email || "").split("@")[0] || "You",
    email: (user.email || "").toLowerCase(),
  };
}
// Name written into shared rows. The Artifact edition stores only account ids and resolves names when rendering.
const storedName = () => (ARTIFACT ? "" : me().name);
const isOwner = () => project()?.ownerId === user?.uid;

/* ---------- Roles and permissions ---------- */
const ROLES = {
  owner: { label: "Owner", rank: 3, text: "Everything, including deleting the project and removing people." },
  admin: { label: "Admin", rank: 2, text: "Project settings, channels, patch notes, roles and invitations; can delete anything." },
  member: { label: "Member", rank: 1, text: "Tasks, bugs, collections, assets and chat; deletes their own things." },
  viewer: { label: "Viewer", rank: 0, text: "Reads everything and chats; can't change project data." },
};
// Minimum role for each kind of action.
const PERMS = { chat: 0, edit: 1, manage: 2, removeMembers: 3 };
function roleOf(uid, p = project()) {
  if (!p || !uid) return "viewer";
  if (p.ownerId === uid) return "owner";
  return ROLES[p.roles?.[uid]] ? p.roles[uid] : "member";
}
function can(perm, p = project()) {
  if (ARTIFACT && BB.canWrite === false) return false;
  return ROLES[roleOf(user?.uid, p)].rank >= PERMS[perm];
}
// Members delete what they created; admins and the owner delete anything.
const canDelete = (creator) => can("manage") || (can("edit") && creator === user?.uid);

/* ---------- Saving ---------- */
function setSaveState() {
  const el = $("#save-status");
  if (!el) return;
  const offline = !navigator.onLine;
  const [cls, ic, text] = pendingWrites ? ["saving", "spinner", "Saving…"]
    : offline ? ["offline", "cloudOff", "Offline: changes sync when you're back"]
    : saveFailed ? ["failed", "cloudOff", "Last change wasn't saved"]
    : ["saved", "cloud", "All changes saved"];
  el.className = `save-status ${cls}`;
  el.innerHTML = `${icon(ic, 15)}<span>${text}</span>`;
}
window.addEventListener("online", setSaveState);
window.addEventListener("offline", setSaveState);

// Runs a write, shows that it is saving, and reports failures instead of failing silently.
async function act(fn, okMsg) {
  pendingWrites++;
  setSaveState();
  try {
    const r = await fn();
    saveFailed = false;
    if (okMsg) toast(okMsg);
    return r ?? true;
  } catch (e) {
    console.error("BLACKBOX:", e);
    saveFailed = true;
    toast(friendlyError(e), true);
    return null;
  } finally {
    pendingWrites--;
    setSaveState();
  }
}

function friendlyError(e) {
  const map = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/wrong-password": "Wrong password.",
    "auth/user-not-found": "No account with this email.",
    "auth/email-already-in-use": "An account already uses this email. Sign in instead.",
    "auth/weak-password": "Use at least 6 characters for the password.",
    "auth/invalid-email": "This email address doesn't look right.",
    "auth/missing-password": "Enter your password.",
    "auth/requires-recent-login": "For security, sign out and back in, then try again.",
    "auth/popup-blocked": "Your browser blocked the Google window. Allow pop-ups for this site and try again.",
    "auth/account-exists-with-different-credential": "This email already has a BLACKBOX account. Sign in with your password first.",
    "auth/unauthorized-domain": "This website isn't allowed to sign in yet. Add it in Firebase → Authentication → Settings → Authorized domains.",
    "auth/operation-not-allowed": "This sign-in method isn't turned on yet in Firebase (Authentication → Sign-in method).",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/network-request-failed": "No connection to the server. Check your internet.",
    "permission-denied": "You don't have access to do that.",
    unavailable: "The server can't be reached right now. Changes will sync when you're back online.",
    invalid_argument: "You can't change this workspace. Ask the owner to share it with you as Editor.",
    quota_exceeded: "The workspace is full. Delete old files, tasks or messages to make room.",
    revoked: "Your access to this page changed. Reload the page.",
    "not-found": "This item no longer exists.",
    too_large: e?.message,
    unsupported: e?.message,
    no_uploads: "You can't upload files here. Ask the owner to share the page with you as Editor.",
  };
  return map[e?.code] || e?.message || "Something went wrong.";
}
const fail = (code, message) => Object.assign(new Error(message), { code });

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
const ASSET_KINDS = {
  image: { label: "Images", one: "Image", icon: "image" },
  thumbnail: { label: "Thumbnails", one: "Thumbnail", icon: "images" },
  icon: { label: "Icons", one: "Icon", icon: "star" },
  gif: { label: "GIFs", one: "GIF", icon: "gif" },
  other: { label: "Other files", one: "File", icon: "file" },
};

/* ---------- People ---------- */
const PIXEL_PATTERNS = [
  ["..X..X..", ".XX..XX.", ".XXXXXX.", "XXoXXoXX", "XXXXXXXX", ".XXooXX.", "..XXXX..", "..X..X.."],
  ["..XXXX..", ".XXXXXX.", "XoXXXXoX", "XXXooXXX", ".XXXXXX.", "XX.XX.XX", "X..XX..X", "..X..X.."],
  ["...XX...", "..XXXX..", ".XoXXoX.", "XXXXXXXX", "X.XXXX.X", "..XooX..", ".XX..XX.", "XX....XX"],
  ["X......X", ".XXXXXX.", "XXoXXoXX", "XXXXXXXX", "XX.oo.XX", ".XXXXXX.", ".X.XX.X.", "X......X"],
];
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function memberName(uid) {
  if (!uid) return "Someone";
  if (profiles[uid]?.name) return profiles[uid].name;
  if (user && uid === user.uid) return me().name;
  if (ARTIFACT) {
    BB.want([uid]);
    return BB.name(uid) || project()?.members?.[uid]?.name || "Someone";
  }
  return project()?.members?.[uid]?.name || "Former member";
}
// Name for a row that stored its author's name at write time (activity, chat).
const nameOf = (uid, stored) => (ARTIFACT || profiles[uid]?.name ? memberName(uid) : stored || memberName(uid));
function memberEmail(uid) {
  return profiles[uid]?.email || (ARTIFACT ? BB.email(uid) : project()?.members?.[uid]?.email) || "";
}
function avatar(uid, size = 36, name = memberName(uid)) {
  const h = hash(uid || "none");
  const hue = h % 360;
  const ring = `box-shadow:0 0 0 1.5px hsl(${hue} 80% 65% / .35)`;
  const photo = profiles[uid]?.avatar;
  if (photo) return `<span class="avatar photo" style="width:${size}px;height:${size}px;${ring}" title="${esc(name)}"><img src="${src(photo)}" alt=""></span>`;
  const color = `hsl(${hue} 80% 65%)`;
  const accent = `hsl(${hue} 60% 22%)`;
  let rects = "";
  PIXEL_PATTERNS[h % PIXEL_PATTERNS.length].forEach((row, y) => [...row].forEach((c, x) => {
    if (c === "X") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
    if (c === "o") rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${accent}"/>`;
  }));
  const inner = Math.round(size * 0.62);
  return `<span class="avatar" style="width:${size}px;height:${size}px;${ring}" title="${esc(name)}"><svg width="${inner}" height="${inner}" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects}</svg></span>`;
}

function folderArt(seed) {
  const hue = hash(seed) % 360;
  return `<svg viewBox="0 0 92 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="92" height="92" fill="hsl(${hue} 30% 14%)"/><path d="M28 34a3 3 0 0 1 3-3h10l5 5h15a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H31a3 3 0 0 1-3-3z" fill="hsl(${hue} 55% 30%)" stroke="hsl(${hue} 70% 70%)" stroke-width="2.5"/></svg>`;
}
const gameIcon = (p, size = 40) => p.icon
  ? `<img class="game-icon" src="${src(p.icon)}" alt="" style="width:${size}px;height:${size}px">`
  : `<span class="game-icon blank" style="width:${size}px;height:${size}px">${icon("gamepad", Math.round(size * 0.5))}</span>`;

/* ---------- Files ---------- */
const FILE_RULES = {
  avatar: { max: 256, square: true },
  icon: { max: 256, square: true },
  thumbnail: { max: 1280 },
  item: { max: 1200 },
  chat: { max: 1280 },
  asset: { max: 1920 },
};
// Turns a picked file into a URL saved with the data. Artifact: the page's own file storage.
// Firebase: a compressed image stored inline (a Firestore document holds at most 1 MB).
async function storeFile(file, purpose, pid = currentId) {
  const rule = FILE_RULES[purpose] || FILE_RULES.chat;
  const image = isImageType(file.type);
  const gif = isGif(file);
  if (ARTIFACT) {
    if (!image && !MEDIA_PURPOSES.has(purpose) && purpose !== "asset") throw fail("unsupported", "Choose an image file.");
    if (file.size > 20 * 1048576) throw fail("too_large", `${file.name} is larger than 20 MB.`);
    let blob = file, width, height;
    if (image && !gif && rule.square) ({ blob, width, height } = await resizeImage(file, rule));
    // Big photos in chat or collections are resized first: much faster to send and to load.
    else if (image && !gif && ["chat", "item"].includes(purpose) && file.size > 1.5 * 1048576) ({ blob, width, height } = await resizeImage(file, { max: 2560, quality: 0.9 }));
    else if (image) ({ width, height } = await imageSize(file));
    const up = await BB.upload(blob);
    return { url: up.url, name: file.name, type: blob.type || file.type, size: up.sizeBytes || blob.size, width, height };
  }
  if (image && file.size > 15 * 1048576) throw fail("too_large", `${file.name} is larger than 15 MB.`);
  if (!image) {
    if (!MEDIA_PURPOSES.has(purpose)) throw fail("unsupported", "Choose an image file.");
    return storeChunked(file, pid);
  }
  if (gif && !rule.square && purpose !== "thumbnail") {
    if (file.size > 600 * 1024) throw fail("too_large", `${file.name} is over 600 KB. Use a smaller GIF.`);
    const { width, height } = await imageSize(file);
    return { url: await readAsDataURL(file), name: file.name, type: "image/gif", size: file.size, width, height };
  }
  const limit = purpose === "avatar" || purpose === "icon" ? 90 * 1024 : 320 * 1024;
  let { max } = rule;
  let quality = 0.85;
  for (let i = 0; i < 4; i++) {
    const { blob, width, height } = await resizeImage(file, { ...rule, max, quality });
    if (blob.size <= limit || i === 3) return { url: await readAsDataURL(blob), name: file.name, type: blob.type, size: blob.size, width, height };
    max = Math.round(max * 0.8);
    quality -= 0.1;
  }
}

// Videos, voice messages and other files. Firebase (without paid Storage) keeps them in the project's
// `files` collection, split into chunks of raw bytes under 1 MB; the stored URL is bbfile:<project>/<id>.
// The Artifact edition uploads them like images (above).
const MEDIA_PURPOSES = new Set(["chat", "feedback", "bug", "doc", "comment"]);
const MEDIA_MAX = { video: 25, audio: 10, other: 10 }; // MB, Firebase edition
const mediaKind = (type) => (/^video\//.test(type || "") ? "video" : /^audio\//.test(type || "") ? "audio" : isImageType(type) ? "image" : "other");
const CHUNK_BYTES = 900 * 1024;
async function storeChunked(file, pid = currentId) {
  const kind = mediaKind(file.type);
  const max = MEDIA_MAX[kind] || MEDIA_MAX.other;
  if (file.size > max * 1048576) throw fail("too_large", `${file.name} is larger than ${max} MB.`);
  const n = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  const ref = projectsCol().doc(pid).collection("files").doc();
  await ref.set({ uid: user.uid, name: String(file.name || "file").slice(0, 120), type: file.type || "application/octet-stream", size: file.size, chunks: n, at: Date.now() });
  await mapLimit([...Array(n).keys()], 4, async (i) => {
    const bytes = new Uint8Array(await file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
    await ref.collection("chunks").doc(String(i)).set({ i, data: firebase.firestore.Blob.fromUint8Array(bytes) });
  });
  const out = { url: `bbfile:${pid}/${ref.id}`, name: file.name, type: file.type || "application/octet-stream", size: file.size };
  if (kind === "video") Object.assign(out, await videoInfo(file));
  return out;
}
// Width, height and duration of a video file, read locally before upload.
function videoInfo(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (info) => { URL.revokeObjectURL(url); resolve(info); };
    v.preload = "metadata";
    v.onloadedmetadata = () => done({ width: v.videoWidth || 0, height: v.videoHeight || 0, duration: Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : 0 });
    v.onerror = () => done({});
    setTimeout(() => done({}), 4000);
    v.src = url;
  });
}
const isStoredFile = (u) => /^bbfile:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(String(u || ""));
const mediaUrls = new Map();   // bbfile url -> local object URL once loaded
const mediaFailed = new Set();
const mediaLoading = new Set();
async function loadStoredFile(u) {
  const [pid, id] = u.slice(7).split("/");
  const ref = projectsCol().doc(pid).collection("files").doc(id);
  const meta = await ref.get();
  if (!meta.exists) throw fail("not-found", "This file was deleted.");
  const snap = await ref.collection("chunks").get();
  const parts = snap.docs.map((d) => d.data()).sort((a, b) => a.i - b.i).map((c) => c.data.toUint8Array());
  return URL.createObjectURL(new Blob(parts, { type: meta.data().type }));
}
// URL to put in src for any stored file. Chunked files load in the background, then the page re-renders.
function mediaSrc(u) {
  if (!isStoredFile(u)) return safeUrl(u);
  if (mediaUrls.has(u)) return mediaUrls.get(u);
  if (!mediaLoading.has(u) && !mediaFailed.has(u)) {
    mediaLoading.add(u);
    loadStoredFile(u).then((url) => mediaUrls.set(u, url))
      .catch((e) => { console.error("BLACKBOX: file load", u, e); mediaFailed.add(u); })
      .finally(() => { mediaLoading.delete(u); scheduleRender(); });
  }
  return "";
}
const msrc = (u) => esc(mediaSrc(u));
const mediaState = (u) => (mediaSrc(u) ? "ready" : mediaFailed.has(u) ? "failed" : "loading");
async function resolveMedia(u) {
  if (!isStoredFile(u)) return safeUrl(u);
  if (!mediaUrls.has(u)) mediaUrls.set(u, await loadStoredFile(u));
  return mediaUrls.get(u);
}
const fmtDuration = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/* ---------- Data layer ---------- */
const projectsCol = () => db.collection("projects");
const sub = (name) => projectsCol().doc(currentId).collection(name);
const updateProject = (data) => projectsCol().doc(currentId).update(data);
const FV = () => firebase.firestore.FieldValue;

/* ---------- Modules ---------- */
// Feature files (feedback.js, analytics.js, bugs.js, search.js, chat.js…) plug in here instead of
// editing the core: their pages, project listeners, file drop targets and data to delete.
const MODULE_VIEWS = {};            // route name -> () => html
const PROJECT_HOOKS = [];           // fn(projectId) when a project opens; may return unsubscribe function(s)
const PROJECT_RESETS = [];          // fn() clearing a module's state when switching projects
const PROJECT_SUBCOLLECTIONS = [];  // extra subcollection names deleted with a project
const PROJECT_CLEANUPS = [];        // async fn(projectRef) deleting nested data before a project goes
const FILE_TARGETS = {};            // drop/pick target -> fn(files, opts); permission in FILE_TARGET_PERMS
const FILE_TARGET_PERMS = {};       // target -> "chat" | "edit" | "manage" (default "edit")
const registerView = (name, fn) => { MODULE_VIEWS[name] = fn; };
const onProject = (fn) => PROJECT_HOOKS.push(fn);
const onProjectReset = (fn) => PROJECT_RESETS.push(fn);

// Activity types: icon, color and filter group, like an audit log.
const ACT_TYPES = {
  "task.create": ["plus", "green", "tasks"], "task.update": ["edit", "blue", "tasks"], "task.complete": ["circleCheck", "green", "tasks"],
  "task.delete": ["trash", "red", "tasks"], "task.move": ["arrowsUpDown", "gray", "tasks"],
  "bug.report": ["bug", "red", "bugs"], "bug.update": ["edit", "blue", "bugs"], "bug.fixed": ["circleCheck", "green", "bugs"], "bug.delete": ["trash", "red", "bugs"],
  "member.join": ["userPlus", "green", "team"], "member.leave": ["userMinus", "orange", "team"], "member.remove": ["userX", "red", "team"], "member.invite": ["mail", "blue", "team"],
  "project.create": ["rocket", "purple", "project"], "project.settings": ["sliders", "blue", "project"], "project.branding": ["image", "purple", "project"],
  "release.update": ["flag", "blue", "project"], "release.check": ["flag", "green", "project"],
  "collection.create": ["folderPlus", "green", "collections"], "collection.update": ["folder", "blue", "collections"], "collection.delete": ["trash", "red", "collections"],
  "item.add": ["plus", "green", "collections"], "item.update": ["edit", "blue", "collections"], "item.delete": ["trash", "red", "collections"],
  "asset.upload": ["upload", "purple", "assets"], "asset.update": ["edit", "blue", "assets"], "asset.delete": ["trash", "red", "assets"],
  "asset.move": ["folder", "gray", "assets"], "folder.create": ["folderPlus", "green", "assets"], "folder.update": ["folder", "blue", "assets"], "folder.delete": ["trash", "red", "assets"],
  "member.role": ["shield", "orange", "team"],
  "channel.create": ["hash", "green", "project"], "channel.update": ["hash", "blue", "project"], "channel.delete": ["trash", "red", "project"],
  "update.create": ["rocket", "blue", "project"], "update.edit": ["edit", "blue", "project"], "update.publish": ["rocket", "green", "project"], "update.delete": ["trash", "red", "project"],
};
const ACT_GROUPS = { all: ["All activity", "pulse"], tasks: ["Tasks", "check"], bugs: ["Bugs", "bug"], team: ["Team", "users"], collections: ["Collections", "folder"], assets: ["Assets", "images"], project: ["Project", "sliders"] };
function activityType(a) {
  if (a.type && ACT_TYPES[a.type]) return a.type;
  const v = a.verb || "";
  if (v.startsWith("completed")) return a.where === "Bugs" ? "bug.fixed" : "task.complete";
  if (v.startsWith("reported")) return "bug.report";
  if (v.startsWith("deleted collection")) return "collection.delete";
  if (v.startsWith("created collection")) return "collection.create";
  if (v.startsWith("deleted")) return a.where === "Bugs" ? "bug.delete" : "task.delete";
  if (v.startsWith("created")) return "task.create";
  if (v.startsWith("joined")) return "member.join";
  if (v.startsWith("left")) return "member.leave";
  if (v.startsWith("removed")) return "member.remove";
  if (v.startsWith("invited")) return "member.invite";
  if (v.startsWith("added")) return "item.add";
  if (v.includes("settings")) return "project.settings";
  return a.where === "Bugs" ? "bug.update" : "task.update";
}

function log(type, verb, target = "", where = "", extra = {}) {
  if (!currentId) return;
  const m = me();
  sub("activity").add({ uid: m.uid, name: storedName(), type, verb, target, where, detail: "", changes: [], ...extra, at: Date.now() })
    .catch((e) => console.error("BLACKBOX: activity log failed", e));
}

function watchProjects() {
  unsubProjects.forEach((u) => u());
  const m = me();
  let gotFirst = false;
  let emailsSynced = false;
  unsubProjects = [
    // Everyone the Artifact is shared with works in the same workspace, so it lists every project.
    (ARTIFACT ? projectsCol() : projectsCol().where("memberIds", "array-contains", m.uid)).onSnapshot((snap) => {
      projects = {};
      snap.forEach((d) => { projects[d.id] = d.data(); });
      gotFirst = true;
      if (!ARTIFACT && !emailsSynced) { emailsSynced = true; syncMemberEmails(); }
      watchProfiles([m.uid, ...Object.values(projects).flatMap((p) => p.memberIds || [])]);
      watchNotifications();
      if (!projects[currentId]) selectProject(pickDefaultProject());
      else if (subscribedId !== currentId) selectProject(currentId);
      else {
        watchChannels();
        if (!channelsOf().some((c) => c.id === channelId)) listenChannel("general");
        if (updatesFor !== can("manage")) listenUpdates();
        scheduleRender();
      }
    }, (e) => { console.error("BLACKBOX: projects listener", e); toast(friendlyError(e), true); }),
  ];
  watchProfiles([m.uid]);
  if (!ARTIFACT) {
    unsubProjects.push(projectsCol().where("invitedEmails", "array-contains", m.email).onSnapshot((snap) => {
      invites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (gotFirst) scheduleRender();
    }, (e) => console.error("BLACKBOX: invites listener", e)));
  }
}
// Profiles of the people you work with only (one listener each), not every account.
const profileUnsubs = new Map();
function watchProfiles(ids) {
  const want = new Set(ids.filter(Boolean));
  for (const [id, unsub] of profileUnsubs) if (!want.has(id)) { unsub(); profileUnsubs.delete(id); delete profiles[id]; }
  for (const id of want) {
    if (profileUnsubs.has(id)) continue;
    profileUnsubs.set(id, db.collection("profiles").doc(id).onSnapshot((d) => {
      if (d.exists) profiles[id] = d.data(); else delete profiles[id];
      scheduleRender();
    }, (e) => console.error("BLACKBOX: profile listener", e)));
  }
}

// After a sign-in email change, keep the address teammates see up to date.
function syncMemberEmails() {
  const m = me();
  for (const [id, p] of Object.entries(projects)) {
    if (p.members?.[m.uid] && p.members[m.uid].email !== m.email) {
      projectsCol().doc(id).update({ [`members.${m.uid}.email`]: m.email }).catch((e) => console.error("BLACKBOX: email sync", e));
    }
  }
}

function pickDefaultProject() {
  const saved = storeGet("blackbox:project");
  if (saved && projects[saved]) return saved;
  const ids = Object.keys(projects).sort((a, b) => (projects[b].createdAt || 0) - (projects[a].createdAt || 0));
  return ids[0] || null;
}

// Listens to a query of the current project. Right after creating a project or accepting an
// invitation, the server may not have the membership yet and refuses once: retry a few times.
function listen(makeQuery, onData) {
  const id = currentId;
  let inner = null;
  let stopped = false;
  let tries = 0;
  const start = () => {
    inner = makeQuery().onSnapshot(onData, (e) => {
      if (stopped || currentId !== id) return;
      if (e.code === "permission-denied" && tries++ < 5) {
        setTimeout(() => { if (!stopped) start(); }, 500 * tries);
        return;
      }
      console.error("BLACKBOX: project listener", e);
      toast(friendlyError(e), true);
    });
  };
  start();
  return () => { stopped = true; inner?.(); };
}

function listenActivity() {
  unsubActivity?.();
  unsubActivity = listen(() => sub("activity").orderBy("at", "desc").limit(activityLimit), (snap) => {
    activity = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    scheduleRender();
  });
}

/* ---------- Channels ---------- */
function channelsOf(p = project()) {
  const list = (p?.channels || []).filter((c) => c && c.id);
  return list.some((c) => c.id === "general") ? list : [{ id: "general", name: "general", topic: "" }, ...list];
}
const channel = (id = channelId) => channelsOf().find((c) => c.id === id) || channelsOf()[0];
// #general keeps the original messages collection; other channels have their own.
const msgCol = (cid = channelId) => (cid === "general" ? sub("messages") : sub("channels").doc(cid).collection("messages"));
const readKey = (cid) => `blackbox:read:${currentId}:${cid}`;
function isUnread(cid) {
  const latest = channelLatest[cid];
  return !!latest && latest.uid !== user.uid && latest.at > +(storeGet(readKey(cid)) || 0);
}
function markChannelRead(cid = channelId) {
  const last = messages[messages.length - 1];
  if (last && +(storeGet(readKey(cid)) || 0) < last.at) storeSet(readKey(cid), String(last.at));
}
function listenChannel(cid) {
  if (unsubMessages && cid === channelId) return;
  unsubMessages?.();
  channelId = cid;
  messages = [];
  editingMsg = null;
  unsubMessages = listen(() => msgCol(cid).orderBy("at").limitToLast(300), (snap) => {
    const atBottom = isChatAtBottom();
    const before = messages.length;
    messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const last = messages[messages.length - 1];
    if (!atBottom && messages.length > before && before && last?.uid !== user.uid) chatNewBelow = true;
    if (last) channelLatest[cid] = { at: last.at, uid: last.uid };
    if (route().name === "chat" && document.visibilityState === "visible") markChannelRead(cid);
    render();
    if (atBottom) scrollChatDown();
  });
}
// The newest message of every other channel, for the unread dots.
function watchChannels() {
  const ids = new Set(channelsOf().map((c) => c.id));
  for (const [cid, unsub] of channelUnsubs) if (!ids.has(cid)) { unsub(); channelUnsubs.delete(cid); }
  for (const cid of ids) {
    if (channelUnsubs.has(cid)) continue;
    channelUnsubs.set(cid, listen(() => msgCol(cid).orderBy("at").limitToLast(1), (snap) => {
      const last = snap.docs[0]?.data();
      if (last) channelLatest[cid] = { at: last.at, uid: last.uid };
      scheduleRender();
    }));
  }
}

// Admins load every update (drafts too); others only published ones, which is all the rules let them read.
let unsubUpdates = null;
let updatesFor = null;
function listenUpdates() {
  unsubUpdates?.();
  updatesFor = can("manage");
  const q = updatesFor ? sub("updates") : sub("updates").where("status", "==", "published");
  unsubUpdates = listen(() => q, (snap) => {
    updates = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0));
    scheduleRender();
  });
}

function selectProject(id) {
  unsubUpdates?.(); unsubUpdates = null;
  unsubCurrent.forEach((u) => u());
  unsubActivity?.();
  unsubMessages?.();
  channelUnsubs.forEach((u) => u());
  channelUnsubs.clear();
  unsubCurrent = [];
  unsubActivity = null;
  unsubMessages = null;
  channelLatest = {};
  outbox = outbox.filter((o) => projects[o.pid]); // unsent messages of other projects wait for their return
  assetFolder = "";
  tasks = []; activity = []; messages = []; items = []; assets = []; updates = [];
  taskFilter = { status: "all", owner: "all" };
  activityFilter = { type: "all", who: "all" };
  assetFilter = { kind: "all", q: "" };
  itemQuery = "";
  activityLimit = 100;
  chatPending = []; editingMsg = null;
  clearAllDrafts(); // unsaved text belongs to the project it was typed in
  PROJECT_RESETS.forEach((fn) => fn());
  currentId = id;
  subscribedId = id;
  if (id) storeSet("blackbox:project", id);
  if (!id) return render();
  unsubCurrent = [
    listen(() => sub("tasks"), (snap) => {
      tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      scheduleRender();
    }),
    listen(() => sub("items"), (snap) => {
      items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      scheduleRender();
      migrateLegacyItems();
    }),
    listen(() => sub("assets").orderBy("at", "desc"), (snap) => {
      assets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      scheduleRender();
    }),
  ];
  for (const hook of PROJECT_HOOKS) unsubCurrent.push(...[].concat(hook(id) || []).filter((u) => typeof u === "function"));
  listenActivity();
  listenUpdates();
  listenChannel(route().name === "chat" && channelsOf().some((c) => c.id === route().arg) ? route().arg : "general");
  watchChannels();
  render();
}

// Collections used to keep their items as a list of names inside the project. Move any such
// names to the items collection once, so they show up in the new grid and list views.
let migrating = false;
async function migrateLegacyItems() {
  const p = project();
  if (migrating || !p || !can("edit") || !(p.collections || []).some((c) => Array.isArray(c.items) && c.items.length)) return;
  migrating = true;
  await act(async () => {
    let t = Date.now();
    // Fixed ids: if two people migrate at once, or a retry repeats it, each item is written once.
    for (const c of p.collections) for (const [i, name] of (c.items || []).entries()) {
      await sub("items").doc(`legacy-${c.id}-${i}`).set({ collectionId: c.id, name: String(name).slice(0, 60), desc: "", image: "", createdBy: user.uid, createdAt: t++ });
    }
    // Strip the old lists from the collections as they are now, keeping edits made meanwhile.
    await updateProject({ collections: (project()?.collections || []).map(({ items: _old, ...c }) => c) });
  });
  migrating = false;
}
const BB_READONLY = () => ARTIFACT && BB.canWrite === false;

async function createProject(name) {
  const m = me();
  const ref = await projectsCol().add({
    name,
    description: "",
    tags: [],
    platforms: [],
    icon: "",
    thumbnail: "",
    ownerId: m.uid,
    memberIds: [m.uid],
    members: { [m.uid]: { name: storedName(), email: ARTIFACT ? "" : m.email } },
    invitedEmails: [],
    release: { name: "UPDATE 1", due: "", items: [] },
    collections: [],
    createdAt: Date.now(),
  });
  storeSet("blackbox:project", ref.id);
  location.hash = "#project";
  if (projects[ref.id]) selectProject(ref.id);
  else currentId = ref.id; // the projects listener selects it when the snapshot arrives
  ref.collection("activity").add({ uid: m.uid, name: storedName(), type: "project.create", verb: "created the project", target: name, where: "", detail: "", changes: [], at: Date.now() })
    .catch((e) => console.error("BLACKBOX: activity log failed", e));
  return ref.id;
}

async function deleteProjectData(id) {
  const ref = projectsCol().doc(id);
  for (const fn of PROJECT_CLEANUPS) await fn(ref);
  // Chunks of stored files first: they live under each file.
  for (const f of (await ref.collection("files").get()).docs) {
    const chunks = await f.ref.collection("chunks").get();
    for (const c of chunks.docs) await c.ref.delete();
  }
  const cols = ["tasks", "activity", "messages", "items", "assets", "updates", "notifications", "files", ...PROJECT_SUBCOLLECTIONS].map((n) => ref.collection(n));
  for (const c of channelsOf(projects[id])) if (c.id !== "general") cols.push(ref.collection("channels").doc(c.id).collection("messages"));
  for (const col of cols) {
    const snap = await col.get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await ref.delete();
}

/* ---------- Shared fragments ---------- */
const priorityPill = (p) => `<span class="pill p-${esc(p)}">${icon(PRIORITY[p]?.icon || "minus", 16, 2)}${PRIORITY[p]?.label || esc(p)}</span>`;
// Bugs show the same status keys as Open / In progress / To test / Resolved (bugs.js).
const statusLabel = (s, type) => (type === "bug" && typeof bugStatusLabel === "function" ? bugStatusLabel(s) : STATUS[s]?.label || s);
const statusPill = (s, type) => `<span class="pill s-${esc(s)}">${icon(STATUS[s]?.icon || "circle", 16, 2)}${esc(statusLabel(s, type))}</span>`;

function taskRow(t, key) {
  return `<tr data-task="${esc(t.id)}" class="${t.status === "done" ? "task-done" : ""}">
    <td><div class="task-cell">${icon(t.type === "bug" ? "bug" : "file", 22, 1.6)}<div class="task-text"><div class="task-title">${esc(t.title)}</div>${t.type === "bug" && typeof bugRowMeta === "function" ? bugRowMeta(t) : ""}${t.desc ? `<div class="task-desc">${esc(t.desc)}</div>` : ""}</div></div></td>
    <td>${priorityPill(t.priority)}</td>
    <td>${statusPill(t.status, t.type)}</td>
    <td>${t.owner ? `<div class="owner">${avatar(t.owner, 36)}<span class="ellipsis">${esc(memberName(t.owner))}</span></div>` : '<span class="muted">Unassigned</span>'}</td>
    <td class="menu-cell"><button class="icon-btn bare" data-task-menu="${esc(t.id)}" data-list="${key}" data-menu-key="task:${key}:${esc(t.id)}" aria-haspopup="menu" aria-expanded="false" title="Actions">${icon("dots", 20)}</button></td>
  </tr>`;
}
function taskTable(list, key, emptyText) {
  lists[key] = list.map((t) => t.id);
  if (!list.length) return `<div class="empty">${emptyText}</div>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Owner</th><th><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${list.map((t) => taskRow(t, key)).join("")}</tbody></table></div>`;
}

function metaChips(p) {
  return `<div class="meta"><span class="proj">${esc(p.name)}</span>${(p.platforms || []).map((x) => `<span class="plat-chip" title="${esc(platformLabel(x))}">${platformIcon(x, 14)}${esc(platformLabel(x))}</span>`).join("")}${(p.tags || []).map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>`;
}
function headerActions(p) {
  return `<div class="actions">
    <a class="avatar-stack" href="#team" title="Team">${p.memberIds.slice(0, 6).map((id) => avatar(id, 38)).join("")}</a>
    <a class="icon-btn round" href="#team" title="Team">${icon("users", 17)}</a>
    ${can("edit") ? `<button class="btn primary" data-action="new-task">${icon("plus", 20, 2.2)}New task</button>` : ""}
  </div>`;
}
// Overview gets the full game header; other pages get a compact one so their content has room.
function header(title, crumb, { full = false, actions = true } = {}) {
  const p = project();
  if (!full) {
    return `<div class="head compact">
      <div class="head-text"><div class="crumbs">${gameIcon(p, 22)}<span>${esc(p.name)}</span><span>/</span><b>${esc(crumb || title)}</b></div><h1>${esc(title)}</h1></div>
      ${actions ? headerActions(p) : ""}</div>`;
  }
  return `${p.thumbnail ? `<div class="banner" style="background-image:url('${src(p.thumbnail)}')"></div>` : ""}
    <div class="crumbs">Workspace <span>/</span> <b>${esc(p.name)}</b></div>
    <div class="head ${p.thumbnail ? "over-banner" : ""}">
      ${gameIcon(p, 72)}
      <div class="head-text">
        <h1>${esc(title)}</h1>
        ${metaChips(p)}
        ${p.description ? `<p class="lede">${esc(p.description)}</p>` : '<p class="lede muted">No description yet. <a class="link" href="#project">Add one</a></p>'}
      </div>
      ${headerActions(p)}
    </div>`;
}

function actText(a) {
  return `<b>${esc(nameOf(a.uid, a.name))}</b> ${esc(a.verb)}${a.target ? ` <b>${esc(a.target)}</b>` : ""}`;
}
function actBadge(a, size = 18) {
  const [ic, color] = ACT_TYPES[activityType(a)] || ["edit", "blue"];
  return `<span class="act-badge c-${color}">${icon(ic, size)}</span>`;
}
function changesList(a) {
  if (!a.changes?.length) return "";
  return `<ul class="changes">${a.changes.map((c) => `<li><span class="ch-field">${esc(c.field)}</span>${c.from ? `<span class="ch-from">${esc(c.from)}</span>${icon("arrow", 13)}` : ""}<span class="ch-to">${esc(c.to || "empty")}</span></li>`).join("")}</ul>`;
}
function activityMini(list) {
  if (!list.length) return '<div class="empty">Nothing has happened yet. Create a task to get started.</div>';
  return `<ul class="feed">${list.map((a) => `<li>
      ${avatar(a.uid, 36, nameOf(a.uid, a.name))}${actBadge(a, 16)}
      <div class="feed-text"><div class="txt">${actText(a)}</div>
      ${a.detail ? `<div class="sub detail">${esc(a.detail)}</div>` : ""}
      <div class="sub">${a.where ? `in ${esc(a.where)} · ` : ""}${timeAgo(a.at)}</div></div></li>`).join("")}</ul>`;
}

/* ---------- Views ---------- */
function viewOverview() {
  const p = project();
  const count = (fn) => tasks.filter(fn).length;
  const stats = [
    { label: "To do", value: count((t) => t.type === "task" && t.status === "todo"), unit: "tasks", icon: "file", cls: "b-gray", href: "#tasks" },
    { label: "In progress", value: count((t) => t.type === "task" && (t.status === "progress" || t.status === "review")), unit: "tasks", icon: "refresh", cls: "b-purple", href: "#tasks" },
    { label: "Open bugs", value: count((t) => t.type === "bug" && t.status !== "done"), unit: "issues", icon: "bug", cls: "b-red", href: "#bugs" },
    { label: "Completed", value: count((t) => t.status === "done"), unit: "tasks", icon: "checkBig", cls: "b-green", href: "#tasks" },
  ];
  const priority = tasks.filter((t) => t.type === "task" && t.status !== "done").slice(0, 5);
  const colls = p.collections || [];

  return `${header("Project overview", "", { full: true })}
    <section class="stats">${stats.map((s) => `<a class="stat" href="${s.href}">
      <div class="badge ${s.cls}">${icon(s.icon, 28, 1.7)}</div>
      <div><div class="label">${s.label}</div><div class="value">${s.value}<span class="unit">${s.unit}</span></div></div></a>`).join("")}
    </section>
    <div class="grid">
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Priority tasks</h2><a class="link" href="#tasks">View all tasks ${icon("arrow", 16)}</a></div>
          ${taskTable(priority, "priority", 'No open tasks. <button class="link" data-action="new-task">Create a task</button>')}
        </section>
        <section class="card">
          <div class="card-head"><h2>Project collections</h2><button class="link" data-action="new-collection">New collection ${icon("plus", 16)}</button></div>
          <div class="card-body">${colls.length ? `<div class="collections">${colls.map((c) => {
            const its = items.filter((x) => x.collectionId === c.id);
            const cover = its.find((x) => x.image)?.image;
            return `<a class="coll" href="#collection.${esc(c.id)}"><div class="coll-cover">${cover ? `<img src="${src(cover)}" alt="" loading="lazy">` : folderArt(c.id)}</div>
              <div class="coll-text"><div class="name ellipsis">${esc(c.name)}</div>${c.desc ? `<div class="desc">${esc(c.desc)}</div>` : ""}<div class="n">${its.length} item${its.length === 1 ? "" : "s"}</div></div></a>`;
          }).join("")}</div>` : '<div class="empty">Group assets like characters, maps or icons into collections.</div>'}</div>
        </section>
      </div>
      <div class="col">
        ${releaseCard()}
        <section class="card">
          <div class="card-head"><h2>Recent activity</h2><a class="link" href="#activity">View all ${icon("arrow", 16)}</a></div>
          <div class="card-body">${activityMini(activity.slice(0, 4))}</div>
        </section>
      </div>
    </div>`;
}

function releaseCard(full = false) {
  const r = project().release || { name: "UPDATE 1", due: "", items: [] };
  const done = r.items.filter((i) => i.done).length;
  const pct = r.items.length ? Math.round((done / r.items.length) * 100) : 0;
  return `<section class="card">
    <div class="card-head"><h2>Next release</h2><button class="icon-btn bare" data-action="edit-release" title="Edit release">${icon("edit", 18)}</button></div>
    <div class="card-body">
      <div class="release-top"><span class="release-name">${esc(r.name)}</span>${r.due ? `<span class="due">${icon("calendar", 18)}Due ${esc(r.due)}</span>` : ""}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
      <div class="progress-row"><span>${done} of ${r.items.length} items complete</span><span>${pct}%</span></div>
      ${r.items.length ? `<ul class="checklist">${r.items.map((it, i) => `<li><label><input type="checkbox" data-release-item="${i}" ${it.done ? "checked" : ""} ${can("edit") ? "" : "disabled"}><span>${esc(it.label)}</span></label>${full && can("edit") ? `<button class="icon-btn bare" data-remove-release="${i}" title="Remove">${icon("x", 16)}</button>` : ""}</li>`).join("")}</ul>` : '<p class="muted">No items yet.</p>'}
      ${full && !can("edit") ? "" : full ? '<form class="add-item" data-form="release-item" data-drafts><input class="input" id="release-new" name="label" placeholder="Add a release item…" required maxlength="80"><button class="btn">Add</button></form>' : `<a class="link" href="#release">View release details ${icon("arrow", 16)}</a>`}
    </div></section>`;
}

function viewTaskList(type) {
  const p = project();
  let list = tasks.filter((t) => t.type === type);
  if (taskFilter.status !== "all") list = list.filter((t) => t.status === taskFilter.status);
  if (taskFilter.owner !== "all") list = list.filter((t) => t.owner === taskFilter.owner);
  const chip = (key, val, label) => `<button class="chip ${taskFilter[key] === val ? "on" : ""}" data-filter="${key}:${esc(val)}">${esc(label)}</button>`;
  const empty = type === "bug" ? "No bugs here." : "No tasks match these filters.";
  const board = boardMode(type);
  const seg = `<div class="seg" role="group" aria-label="View"><button class="${board ? "" : "on"}" data-board-mode="list" data-board-type="${type}" title="List">${icon("list", 17)}</button><button class="${board ? "on" : ""}" data-board-mode="board" data-board-type="${type}" title="Board">${icon("columns", 17)}</button></div>`;
  return `${header(type === "bug" ? "Bugs" : "Tasks")}
    <section class="card ${board ? "board-card" : ""}">
      <div class="card-head wrap">
        ${board ? "" : `<div class="filters">${chip("status", "all", "All")}${Object.keys(STATUS).map((k) => chip("status", k, statusLabel(k, type))).join("")}</div>`}
        <div class="filters">${chip("owner", "all", "Everyone")}${p.memberIds.map((id) => chip("owner", id, memberName(id))).join("")}</div>
        ${seg}
      </div>
      ${board ? viewBoard(type, tasks.filter((t) => t.type === type && (taskFilter.owner === "all" || t.owner === taskFilter.owner)))
        : taskTable(list, type, `${empty}${can("edit") ? ` <button class="link" data-action="new-task">${type === "bug" ? "Report a bug" : "Create a task"}</button>` : ""}`)}
    </section>`;
}

function viewActivity() {
  const p = project();
  let list = activity;
  if (activityFilter.type !== "all") list = list.filter((a) => (ACT_TYPES[activityType(a)] || [])[2] === activityFilter.type);
  if (activityFilter.who !== "all") list = list.filter((a) => a.uid === activityFilter.who);
  let lastDay = "";
  const rows = list.map((a) => {
    const day = dayLabel(a.at);
    const divider = day !== lastDay ? `<li class="day-divider"><span>${esc(day)}</span></li>` : "";
    lastDay = day;
    return `${divider}<li class="act-row">
      ${actBadge(a, 18)}
      ${avatar(a.uid, 38, nameOf(a.uid, a.name))}
      <div class="act-main">
        <div class="txt">${actText(a)}</div>
        ${a.detail ? `<div class="sub detail">${esc(a.detail)}</div>` : ""}
        ${changesList(a)}
      </div>
      <div class="act-meta"><span title="${esc(new Date(a.at).toLocaleString())}">${clockTime(a.at)}</span>${a.where ? `<span class="where">${esc(a.where)}</span>` : ""}</div>
    </li>`;
  }).join("");
  const whoOptions = [["all", "Everyone"], ...p.memberIds.map((id) => [id, memberName(id)])];
  return `${header("Activity", "", { actions: false })}
    <div class="activity-layout">
      <aside class="card act-filters">
        <div class="side-label">Filter by type</div>
        ${Object.entries(ACT_GROUPS).map(([k, [label, ic]]) => `<button class="act-filter ${activityFilter.type === k ? "on" : ""}" data-act-filter="${k}">${icon(ic, 17)}<span>${label}</span></button>`).join("")}
        <div class="side-label spaced-sm">Member</div>
        <select id="act-who" aria-label="Member">${whoOptions.map(([v, l]) => `<option value="${esc(v)}" ${activityFilter.who === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      </aside>
      <section class="card act-card">
        <div class="card-head"><h2>Audit log</h2><span class="muted">${list.length} entr${list.length === 1 ? "y" : "ies"}</span></div>
        ${rows ? `<ul class="act-list">${rows}</ul>` : '<div class="empty">No activity matches these filters.</div>'}
        ${activity.length >= activityLimit ? '<div class="load-more"><button class="btn" data-action="load-older">Load older entries</button></div>' : activity.length ? '<div class="load-more muted">That\'s the beginning of this project\'s history.</div>' : ""}
      </section>
    </div>`;
}

// Each person's name keeps the colour of their avatar.
const nameColor = (uid) => `hsl(${hash(uid || "none") % 360} 75% 74%)`;
let chatNewBelow = false; // new messages arrived while scrolled up
function msgTime(at) {
  return dayLabel(at) === "Today" ? `Today at ${clockTime(at)}` : `${esc(dayLabel(at))} ${clockTime(at)}`;
}
function viewChat() {
  const p = project();
  const ch = channel();
  const myUid = user.uid;
  let html = "";
  let prev = null;
  const row = (m, body, extraCls = "", actions = "") => {
    const newDay = !prev || dayLabel(prev.at) !== dayLabel(m.at);
    const grouped = !newDay && prev.uid === m.uid && m.at - prev.at < 7 * 60000;
    if (newDay) html += `<div class="day-divider"><span>${esc(dayLabel(m.at))}</span></div>`;
    html += grouped
      ? `<div class="msg cont ${extraCls}" data-msg-id="${esc(m.id)}"><span class="msg-time-gutter">${clockTime(m.at)}</span><div class="msg-body">${body}</div>${actions}</div>`
      : `<div class="msg ${extraCls}" data-msg-id="${esc(m.id)}">${avatar(m.uid, 42, nameOf(m.uid, m.name))}<div class="msg-body"><div class="msg-head"><b style="color:${nameColor(m.uid)}">${esc(nameOf(m.uid, m.name))}</b><span class="msg-time" title="${esc(new Date(m.at).toLocaleString())}">${msgTime(m.at)}</span></div>${body}</div>${actions}</div>`;
    prev = m;
  };
  for (const m of messages) {
    const mine = m.uid === myUid;
    const actions = `<div class="msg-actions">${chatMsgActions(m)}${mine ? `<button class="icon-btn bare" data-edit-msg="${esc(m.id)}" title="Edit">${icon("edit", 15)}</button>` : ""}${mine || can("manage") ? `<button class="icon-btn bare danger-text" data-delete-msg="${esc(m.id)}" title="Delete">${icon("trash", 15)}</button>` : ""}</div>`;
    const body = editingMsg === m.id
      ? `<form class="msg-edit" data-form="edit-msg" data-msg="${esc(m.id)}" data-drafts><textarea id="msg-edit-text" rows="2" maxlength="2000">${esc(detokenizeMentions(m.text))}</textarea><div class="muted small">Enter to save · Esc to cancel</div></form>`
      : `${pinnedMark(m)}${m.text ? `<div class="msg-text">${formatMessage(m.text, { mention: renderMention })}${m.editedAt ? ' <span class="edited">(edited)</span>' : ""}</div>` : ""}${attachmentsHtml(m.attachments)}${reactionsHtml(m)}`;
    row(m, body, [mentionedIds(m.text).includes(myUid) && "mentioned", m.pinned && "pinned", flashMsg === m.id && "flash"].filter(Boolean).join(" "), actions);
  }
  // Messages still being sent show right away, with local previews.
  for (const o of outbox.filter((x) => x.pid === currentId && x.channel === ch.id && !x.hidden)) {
    const previews = o.files.length ? `<div class="atts ${o.files.length > 1 ? "multi" : ""}">${o.files.map((f) => f.preview
      ? `<div class="att-wrap"><span class="att-img sending">${f.kind === "video" ? `<video src="${esc(f.preview)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(f.preview)}" alt="">`}</span></div>`
      : f.kind === "audio" && f.extra ? `<span class="att-file">${icon("mic", 22)}<span><b class="ellipsis">Voice message</b><span class="muted small">${fmtDuration(f.extra.duration)}</span></span></span>`
      : `<span class="att-file">${icon("file", 22)}<span><b class="ellipsis">${esc(f.file.name)}</b><span class="muted small">${formatSize(f.file.size)}</span></span></span>`).join("")}</div>` : "";
    const status = o.state === "failed"
      ? `<div class="send-failed">${icon("cloudOff", 14)}<span>Couldn't send: ${esc(o.error || "")}</span><button class="link small" data-outbox-retry="${esc(o.id)}">Retry</button><button class="link small danger-text" data-outbox-discard="${esc(o.id)}">Discard</button></div>`
      : `<div class="sending-note">${icon("spinner", 13)}Sending…</div>`;
    row({ id: o.id, uid: myUid, name: storedName(), at: o.at }, `${o.text ? `<div class="msg-text">${formatMessage(o.text, { mention: renderMention })}</div>` : ""}${previews}${status}`, `outgoing ${o.state}`);
  }
  const gifs = assets.filter((a) => a.type === "image/gif" || a.kind === "gif");
  const chans = channelsOf();
  return `<div class="chat-layout">
      <aside class="card chat-channels">
        <div class="chan-project">${gameIcon(p, 30)}<b class="ellipsis">${esc(p.name)}</b></div>
        <div class="side-label row">Channels ${can("manage") ? `<button class="icon-btn small" data-action="new-channel" title="New channel">${icon("plus", 16)}</button>` : ""}</div>
        <select id="channel-select" class="channel-select" aria-label="Channel">${chans.map((c) => `<option value="${esc(c.id)}" ${c.id === ch.id ? "selected" : ""}># ${esc(c.name)}</option>`).join("")}</select>
        <ul class="chan-list">${chans.map((c) => `<li><a href="#chat.${esc(c.id)}" class="${c.id === ch.id ? "active" : ""} ${isUnread(c.id) && c.id !== ch.id ? "unread" : ""}">${icon("hash", 17)}<span class="grow ellipsis">${esc(c.name)}</span>${isUnread(c.id) && c.id !== ch.id ? '<span class="dot" title="New messages"></span>' : ""}</a></li>`).join("")}</ul>
      </aside>
      <section class="card chat-card" data-drop="chat">
        <div class="drop-hint">${icon("upload", 28)}<span>Drop files to add them to your message</span></div>
        <div class="chan-head">${icon("hash", 20)}<b>${esc(ch.name)}</b>${ch.topic ? `<span class="chan-topic ellipsis">${esc(ch.topic)}</span>` : ""}<span class="spacer"></span>
          ${pinsButton()}
          ${can("manage") ? `<button class="icon-btn bare" data-chan-menu="${esc(ch.id)}" data-menu-key="chan:${esc(ch.id)}" aria-haspopup="menu" title="Channel settings">${icon("dots", 18)}</button>` : ""}</div>
        ${pinsPanel()}
        <button type="button" class="jump-latest ${chatNewBelow ? "show" : ""}" data-action="jump-latest">${icon("arrowDown", 15)}New messages</button>
        <div class="chat" id="chat-log">${html || `<div class="chat-empty">${icon("hash", 34)}<h3>Welcome to #${esc(ch.name)}</h3><p class="muted">${ch.id === "general" ? `This is the start of ${esc(p.name)}'s team chat.` : "This is the start of the channel."} Say hi, share screenshots, drop GIFs, type @ to mention someone.</p></div>`}</div>
        ${typingHtml()}
        <form class="composer" data-form="chat" data-drafts>
          ${chatPending.length ? `<div class="pending">${chatPending.map((f) => `<div class="pend">${f.kind === "video" ? `<video src="${esc(f.preview)}" muted playsinline preload="metadata"></video>` : f.preview ? `<img src="${esc(f.preview)}" alt="">` : `<span class="pend-file">${icon(f.kind === "audio" ? "mic" : "file", 22)}</span>`}<span class="pend-name ellipsis">${esc(f.file.name)}</span><button type="button" class="icon-btn bare tiny" data-remove-pending="${esc(f.id)}" title="Remove">${icon("x", 13)}</button></div>`).join("")}</div>` : ""}
          <div class="fmt-bar">
            <button type="button" class="icon-btn bare" data-fmt="**" title="Bold (Ctrl+B)">${icon("bold", 16, 2.2)}</button>
            <button type="button" class="icon-btn bare" data-fmt="*" title="Italic (Ctrl+I)">${icon("italic", 16, 2)}</button>
            <button type="button" class="icon-btn bare" data-fmt="~~" title="Strikethrough">${icon("strike", 16, 2)}</button>
            <button type="button" class="icon-btn bare" data-fmt="\`" title="Code">${icon("code", 16, 2)}</button>
            <button type="button" class="icon-btn bare" data-fmt="> " title="Quote">${icon("quote", 16, 2)}</button>
            <button type="button" class="icon-btn bare" data-fmt="@" title="Mention someone">${icon("at", 16, 2)}</button>
            <span class="muted small fmt-hint">**bold** *italic* ~~strike~~ \`code\` @name</span>
          </div>
          ${voiceComposer() || `<div class="composer-row">
            <button type="button" class="icon-btn bare round-sm" data-pick="chat" title="Attach files (images, videos, files)">${icon("paperclip", 19)}</button>
            <textarea id="chat-text" name="text" rows="1" placeholder="Message #${esc(ch.name)}" maxlength="2000" autocomplete="off"></textarea>
            <div class="gif-wrap">
              <button type="button" class="icon-btn bare round-sm ${gifOpen ? "on" : ""}" data-action="toggle-gifs" title="GIFs">${icon("gif", 21)}</button>
              ${gifOpen ? `<div class="gif-panel" role="dialog" aria-label="GIFs">
                <div class="gif-head"><b>GIFs</b>${can("edit") ? `<button type="button" class="btn small" data-pick="gif">${icon("upload", 15)}Upload GIF</button>` : ""}</div>
                ${gifs.length ? `<div class="gif-grid">${gifs.map((g) => `<button type="button" class="gif-pick" data-send-gif="${esc(g.id)}" title="${esc(g.name)}"><img src="${src(g.url)}" alt="${esc(g.name)}" loading="lazy"></button>`).join("")}</div>` : '<p class="muted small">No GIFs yet. Upload one and it stays here for the whole team.</p>'}
              </div>` : ""}
            </div>
            ${voiceButton()}
            <button class="btn primary send-btn" title="Send">${icon("send", 18)}</button>
          </div>`}
        </form>
      </section>
      <aside class="card chat-members">
        ${membersHtml(p)}
      </aside>
    </div>`;
}
// Voice message player: play/pause, waveform with progress (click to seek), duration.
function voiceHtml(a) {
  const url = mediaSrc(a.url);
  const peaks = Array.isArray(a.peaks) && a.peaks.length ? a.peaks : Array.from({ length: 36 }, (_, i) => 3 + (hash(`${a.url}${i}`) % 6));
  return `<div class="voice" data-voice data-keep="voice:${esc(a.url)}:${mediaState(a.url)}">
    <button type="button" class="voice-play" data-voice-play title="Play" ${url ? "" : "disabled"}>${url ? icon("play", 16) : mediaFailed.has(a.url) ? icon("alert", 16) : icon("spinner", 16)}</button>
    <div class="voice-wave" data-voice-seek>${peaks.slice(0, 48).map((p) => `<i style="height:${Math.max(18, Math.min(100, Math.round(+p * 11)))}%"></i>`).join("")}</div>
    <span class="voice-time" data-total="${esc(fmtDuration(a.duration))}" data-dur="${+a.duration || 0}">${esc(fmtDuration(a.duration))}</span>
    ${url ? `<audio preload="metadata" src="${esc(url)}"></audio>` : ""}
  </div>`;
}
function videoHtml(a) {
  const url = mediaSrc(a.url);
  const ratio = a.width && a.height ? `aspect-ratio:${a.width}/${a.height}` : "aspect-ratio:16/9";
  return `<div class="att-wrap att-video-wrap" data-keep="video:${esc(a.url)}:${mediaState(a.url)}"><div class="att-video" style="${ratio}">${url
    ? `<video controls preload="metadata" playsinline src="${esc(url)}"></video>`
    : `<div class="media-wait">${mediaFailed.has(a.url) ? `${icon("alert", 20)}<span>Video unavailable</span>` : `${icon("spinner", 20)}<span>Loading video…</span>`}</div>`}</div>
    ${url ? `<button type="button" class="att-dl" data-download="${esc(a.url)}" data-name="${esc(a.name)}" title="Download">${icon("download", 16)}</button>` : ""}</div>`;
}
function attachmentsHtml(list) {
  if (!list?.length) return "";
  return `<div class="atts ${list.length > 1 ? "multi" : ""}">${list.map((a) => mediaKind(a.type) === "audio" ? voiceHtml(a)
    : mediaKind(a.type) === "video" ? videoHtml(a)
    : isStoredFile(a.url) && isImageType(a.type) && mediaSrc(a.url) ? `<div class="att-wrap"><button type="button" class="att-img" data-lightbox="${msrc(a.url)}" data-caption="${esc(a.name)}"><img src="${msrc(a.url)}" alt="${esc(a.name)}" ${a.width ? `width="${a.width}" height="${a.height}"` : ""}></button>
       <button type="button" class="att-dl" data-download="${esc(a.url)}" data-name="${esc(a.name)}" title="Download">${icon("download", 16)}</button></div>`
    : isStoredFile(a.url) ? `<button type="button" class="att-file" data-download="${esc(a.url)}" data-name="${esc(a.name)}">${icon("file", 22)}<span><b class="ellipsis">${esc(a.name)}</b><span class="muted small">${formatSize(a.size)}</span></span>${icon("download", 16)}</button>`
    : isImageType(a.type) && safeUrl(a.url)
    ? `<div class="att-wrap"><button type="button" class="att-img" data-lightbox="${src(a.url)}" data-caption="${esc(a.name)}"><img src="${src(a.url)}" alt="${esc(a.name)}" loading="lazy" decoding="async" ${a.width ? `width="${a.width}" height="${a.height}"` : ""}></button>
       <button type="button" class="att-dl" data-download="${src(a.url)}" data-name="${esc(a.name)}" title="Download">${icon("download", 16)}</button></div>`
    : `<${safeUrl(a.url) ? `a href="${src(a.url)}" target="_blank" rel="noopener"` : "span"} class="att-file">${icon("file", 22)}<span><b class="ellipsis">${esc(a.name)}</b><span class="muted small">${formatSize(a.size)}</span></span></${safeUrl(a.url) ? "a" : "span"}>`).join("")}</div>`;
}
function isChatAtBottom() {
  const el = $("#chat-log");
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}
function scrollChatDown(smooth = false) {
  const el = $("#chat-log");
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  if (chatNewBelow) { chatNewBelow = false; $(".jump-latest")?.classList.remove("show"); }
}
document.addEventListener("scroll", (e) => {
  if (e.target.id === "chat-log" && chatNewBelow && isChatAtBottom()) { chatNewBelow = false; $(".jump-latest")?.classList.remove("show"); }
}, true);

function viewRelease() {
  return `${header("Release")}<div class="narrow">${releaseCard(true)}</div>`;
}

function viewCollection(id) {
  const c = (project().collections || []).find((x) => x.id === id);
  if (!c) return viewOverview();
  const mode = storeGet(`blackbox:view:${c.id}`) || "grid";
  const q = itemQuery.trim().toLowerCase();
  const list = items.filter((x) => x.collectionId === c.id && (!q || `${x.name} ${x.desc}`.toLowerCase().includes(q)));
  const total = items.filter((x) => x.collectionId === c.id).length;
  const itemMenu = (x) => `<button class="icon-btn bare item-menu" data-item-menu="${esc(x.id)}" data-menu-key="item:${esc(x.id)}" aria-haspopup="menu" title="Actions">${icon("dots", 18)}</button>`;
  const body = !list.length
    ? `<button type="button" class="dropzone big" data-drop="items" data-pick="items" data-collection="${esc(c.id)}">${icon("images", 34)}<b>${total ? "No items match your search." : "Drop images here to add items"}</b><span class="muted">${total ? "Try another search, or " : "Each image becomes an item named after the file. You can also "}<span class="link">choose files</span></span></button>`
    : mode === "grid"
      ? `<div class="item-grid" data-drop="items" data-collection="${esc(c.id)}">${list.map((x) => `<article class="item-card" data-item="${esc(x.id)}">
          ${x.image ? `<img src="${src(x.image)}" alt="" loading="lazy">` : `<div class="item-noimg">${folderArt(x.id)}</div>`}
          <div class="item-info"><div class="item-name">${esc(x.name)}</div>${x.desc ? `<div class="item-desc">${esc(x.desc)}</div>` : ""}</div>
          ${itemMenu(x)}
        </article>`).join("")}</div>`
      : `<div class="table-wrap" data-drop="items" data-collection="${esc(c.id)}"><table class="table item-table"><thead><tr><th>Item</th><th>Added by</th><th>Date</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
          ${list.map((x) => `<tr data-item="${esc(x.id)}"><td><div class="task-cell"><span class="item-thumb">${x.image ? `<img src="${src(x.image)}" alt="" loading="lazy">` : icon("image", 20)}</span><div class="task-text"><div class="task-title">${esc(x.name)}</div>${x.desc ? `<div class="task-desc">${esc(x.desc)}</div>` : ""}</div></div></td>
            <td><div class="owner">${avatar(x.createdBy, 30)}<span class="ellipsis">${esc(memberName(x.createdBy))}</span></div></td><td class="muted nowrap">${timeAgo(x.createdAt)}</td><td class="menu-cell">${itemMenu(x)}</td></tr>`).join("")}
        </tbody></table></div>`;
  return `${header(c.name, "Collections")}
    <section class="card coll-page">
      <div class="coll-toolbar">
        <div class="coll-title"><span class="coll-badge">${icon("folder", 20)}</span><div class="min0"><div class="coll-h">${esc(c.name)} <span class="muted">· ${total} item${total === 1 ? "" : "s"}</span></div>${c.desc ? `<div class="muted small">${esc(c.desc)}</div>` : ""}</div></div>
        <div class="row-gap">
          <label class="search">${icon("search", 16)}<input id="item-search" placeholder="Search items" value="${esc(itemQuery)}" autocomplete="off"></label>
          <div class="seg" role="group" aria-label="View">
            <button class="${mode === "grid" ? "on" : ""}" data-view-mode="grid" data-collection="${esc(c.id)}" title="Grid">${icon("grid", 17)}</button>
            <button class="${mode === "list" ? "on" : ""}" data-view-mode="list" data-collection="${esc(c.id)}" title="List">${icon("list", 17)}</button>
          </div>
          <button class="btn primary" data-action="new-item" data-collection="${esc(c.id)}">${icon("plus", 18, 2.2)}Add item</button>
          <button class="icon-btn" data-coll-menu="${esc(c.id)}" data-menu-key="coll:${esc(c.id)}" aria-haspopup="menu" title="Collection actions">${icon("dots", 18)}</button>
        </div>
      </div>
      ${body}
    </section>`;
}

const foldersOf = (p = project()) => (p?.assetFolders || []).filter((f) => f && f.id);
function viewAssets() {
  const folders = foldersOf();
  const folder = folders.find((f) => f.id === assetFolder) || null;
  if (assetFolder && !folder) assetFolder = "";
  const here = assets.filter((a) => (a.folder || "") === (folder?.id || "") || (!folder && !folders.some((f) => f.id === a.folder) && a.folder));
  const q = assetFilter.q.trim().toLowerCase();
  const list = here.filter((a) => (assetFilter.kind === "all" || a.kind === assetFilter.kind) && (!q || a.name.toLowerCase().includes(q)));
  const count = (k) => here.filter((a) => a.kind === k).length;
  const folderTile = (f) => {
    const inside = assets.filter((a) => a.folder === f.id);
    const cover = inside.find((a) => isImageType(a.type) && safeUrl(a.url));
    return `<a class="folder-tile" href="#assets.${esc(f.id)}" data-folder-drop="${esc(f.id)}">
      <span class="folder-cover">${cover ? `<img src="${src(cover.url)}" alt="" loading="lazy">` : icon("folder", 30, 1.5)}</span>
      <span class="folder-text"><b class="ellipsis">${esc(f.name)}</b><span class="muted small">${inside.length} file${inside.length === 1 ? "" : "s"}</span></span>
      ${can("manage") ? `<button class="icon-btn bare" data-folder-menu="${esc(f.id)}" data-menu-key="folder:${esc(f.id)}" aria-haspopup="menu" title="Folder actions">${icon("dots", 16)}</button>` : ""}
    </a>`;
  };
  return `${header("Assets", "", { actions: false })}
    <section class="card assets-page">
      <div class="coll-toolbar">
        <div class="crumbs asset-crumbs"><a href="#assets" data-folder-drop="">${icon("images", 16)}All assets</a>${folder ? `<span>/</span><b>${esc(folder.name)}</b>` : ""}</div>
        <div class="row-gap">
          <label class="search">${icon("search", 16)}<input id="asset-search" placeholder="Search here" value="${esc(assetFilter.q)}" autocomplete="off"></label>
          ${can("edit") ? `${folder ? "" : `<button type="button" class="btn" data-action="new-folder">${icon("folderPlus", 17)}New folder</button>`}
          <select id="asset-upload-kind" aria-label="Upload as">${Object.entries(ASSET_KINDS).map(([k, v]) => `<option value="${k}" ${(storeGet("blackbox:asset-kind") || "image") === k ? "selected" : ""}>Upload as: ${v.one}</option>`).join("")}</select>
          <button type="button" class="btn primary" data-pick="asset">${icon("upload", 18)}Upload${folder ? " here" : ""}</button>` : ""}
        </div>
      </div>
      ${!folder && folders.length ? `<div class="folder-grid">${folders.map(folderTile).join("")}</div>` : ""}
      <div class="filters asset-filters">
        <button class="chip ${assetFilter.kind === "all" ? "on" : ""}" data-asset-kind="all">All · ${here.length}</button>
        ${Object.entries(ASSET_KINDS).map(([k, v]) => `<button class="chip ${assetFilter.kind === k ? "on" : ""}" data-asset-kind="${k}">${icon(v.icon, 14)}${v.label} · ${count(k)}</button>`).join("")}
      </div>
      ${list.length ? `<div class="asset-grid" data-drop="assets">${list.map((a) => `<article class="asset-card" data-asset="${esc(a.id)}" ${can("edit") ? 'draggable="true"' : ""}>
          <button type="button" class="asset-preview" ${isImageType(a.type) && safeUrl(a.url) ? `data-lightbox="${src(a.url)}" data-caption="${esc(a.name)}"` : ""}>${isImageType(a.type) && safeUrl(a.url) ? `<img src="${src(a.url)}" alt="" loading="lazy" decoding="async">` : icon("file", 40)}</button>
          <div class="asset-info">
            <div class="asset-name ellipsis" title="${esc(a.name)}">${esc(a.name)}</div>
            <div class="asset-meta"><span class="kind-chip">${icon(ASSET_KINDS[a.kind]?.icon || "file", 13)}${ASSET_KINDS[a.kind]?.one || "File"}</span>${a.width ? `<span>${a.width}×${a.height}</span>` : ""}<span>${formatSize(a.size)}</span></div>
            <div class="asset-by">${avatar(a.uid, 22)}<span class="ellipsis">${esc(memberName(a.uid))} · ${timeAgo(a.at)}</span></div>
          </div>
          ${safeUrl(a.url) ? `<button class="icon-btn bare asset-dl" data-download="${src(a.url)}" data-name="${esc(a.name)}" title="Download">${icon("download", 16)}</button>` : ""}
          <button class="icon-btn bare item-menu" data-asset-menu="${esc(a.id)}" data-menu-key="asset:${esc(a.id)}" aria-haspopup="menu" title="Actions">${icon("dots", 18)}</button>
        </article>`).join("")}</div>`
        : can("edit")
          ? `<button type="button" class="dropzone big" data-drop="assets" data-pick="asset">${icon("upload", 34)}<b>${here.length ? "No assets match." : folder ? `Drop files into ${esc(folder.name)}` : "Drop images, thumbnails, icons or GIFs here"}</b><span class="muted">${ARTIFACT ? "Up to 20 MB per file." : "Images are compressed; GIFs up to 600 KB."} <span class="link">Choose files</span></span></button>`
          : '<div class="empty">No assets here yet.</div>'}
    </section>`;
}

function viewTeam() {
  const p = project();
  const manage = can("manage");
  return `${header("Team")}
    <div class="grid">
      <section class="card">
        <div class="card-head"><h2>Members</h2><span class="muted">${p.memberIds.length}</span></div>
        <ul class="people">${p.memberIds.map((id) => {
          const role = roleOf(id);
          const editable = manage && role !== "owner" && id !== user.uid;
          return `<li>${avatarP(id, 44)}
          <div class="who"><div class="name">${esc(memberName(id))}${id === user.uid ? ' <span class="muted">(you)</span>' : ""}</div><div class="sub"><span class="pres-text pres-${presenceOf(id)}">${PRESENCE_LABEL[presenceOf(id)]}</span>${esc([profiles[id]?.title, memberEmail(id)].filter(Boolean).map((x) => ` · ${x}`).join(""))}</div></div>
          ${editable
            ? `<select id="role-${esc(id)}" class="role-select" data-role-for="${esc(id)}" aria-label="Role of ${esc(memberName(id))}">${["admin", "member", "viewer"].map((r) => `<option value="${r}" ${r === role ? "selected" : ""}>${ROLES[r].label}</option>`).join("")}</select>`
            : `<span class="role-tag role-${role}">${icon(role === "owner" ? "star" : role === "admin" ? "shield" : role === "viewer" ? "eye" : "user", 13)}${ROLES[role].label}</span>`}
          ${can("removeMembers") && id !== user.uid ? `<button class="icon-btn bare danger-text" data-remove-member="${esc(id)}" title="Remove from project">${icon("x", 18)}</button>` : ""}
        </li>`;
        }).join("")}</ul>
      </section>
      <div class="col">
        <section class="card">
          <div class="card-head"><h2>Invite people</h2></div>
          <div class="card-body">${ARTIFACT ? `
            <p>Open the <b>Share</b> menu of this page and invite them by email as <b>Editor</b>. They open the link with their Claude account and press <b>Join</b>.</p>
            <p class="muted">People with view-only access can read everything but can't make changes.</p>` : manage ? `
            <p class="muted">They sign in to BLACKBOX with this email and accept the invitation.</p>
            <form class="add-item" data-form="invite" data-drafts><input class="input" id="invite-email" name="email" type="email" placeholder="name@example.com" required autocomplete="off"><button class="btn primary">${icon("mail", 16)}Invite</button></form>
            ${(p.invitedEmails || []).length ? `<div class="side-label">Pending invitations</div><ul class="item-list">${p.invitedEmails.map((e) => `<li>${esc(e)}<button class="icon-btn bare" data-cancel-invite="${esc(e)}" title="Cancel invitation">${icon("x", 16)}</button></li>`).join("")}</ul>` : ""}` : '<p class="muted">Ask an admin or the owner to invite someone.</p>'}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Roles</h2></div>
          <ul class="role-legend">${Object.entries(ROLES).map(([k, r]) => `<li><span class="role-tag role-${k}">${icon(k === "owner" ? "star" : k === "admin" ? "shield" : k === "viewer" ? "eye" : "user", 13)}${r.label}</span><span class="muted small">${r.text}</span></li>`).join("")}</ul>
        </section>
      </div>
    </div>`;
}

function viewProjectSettings() {
  const p = project();
  const chosen = new Set((p.platforms || []).map((x) => platformKey(x)).filter(Boolean));
  const custom = (p.platforms || []).filter((x) => !platformKey(x));
  const tags = p.tags || [];
  const ro = !can("manage");
  return `${header("Project settings", "Settings", { actions: false })}
    ${ro ? `<div class="notice">${icon("shield", 18)}<span>Only admins and the owner can change these settings. You're ${ROLES[roleOf(user.uid)].label.toLowerCase()} in this project.</span></div>` : ""}
    <div class="settings-layout ${ro ? "read-only" : ""}">
      <form class="card settings-main" data-form="project" data-drafts ${ro ? "inert" : ""}>
        <div class="card-head"><h2>General</h2></div>
        <div class="card-body settings">
          <label>Game name<input class="input" id="set-name" name="name" required maxlength="40" value="${esc(p.name)}"></label>
          <label>Description<textarea class="input" id="set-desc" name="description" rows="3" maxlength="300" placeholder="What is the game about?">${esc(p.description)}</textarea></label>
          <div class="field"><span class="field-label">Tags</span>
            <input type="hidden" id="set-tags" name="tags" value="${esc(tags.join(", "))}">
            <div class="chip-input" id="tag-box">${tagChips(tags)}<input id="tag-entry" placeholder="Add a tag and press Enter" maxlength="30" autocomplete="off"></div>
          </div>
          <div class="field"><span class="field-label">Platforms</span>
            <div class="plat-grid">${Object.entries(PLATFORMS).map(([k, v]) => `<label class="plat-tile"><input type="checkbox" id="plat-${k}" name="plat" value="${k}" ${chosen.has(k) ? "checked" : ""}><span>${platformIcon(k, 22)}${esc(v.label)}</span></label>`).join("")}</div>
            <label class="sub-label">Other platforms <span class="hint">separated by commas</span><input class="input" id="set-custom-plat" name="customPlatforms" maxlength="120" value="${esc(custom.join(", "))}" placeholder="e.g. Fortnite Creative"></label>
          </div>
          <div><button class="btn primary">${icon("save", 17)}Save changes</button></div>
        </div>
      </form>
      <div class="settings-side">
        <section class="card">
          <div class="card-head"><h2>Game icon</h2></div>
          <div class="card-body brand-row">
            <button type="button" class="brand-pick icon-pick" data-drop="brand-icon" data-pick="icon" title="Upload icon">${p.icon ? `<img src="${src(p.icon)}" alt="Game icon">` : `<span class="muted">${icon("upload", 22)}</span>`}</button>
            <div class="brand-text"><p class="muted small">Square image, shown next to the game name. Drop a file or click to upload.</p>
              <div class="row-gap">${assetChooser("icon")}${p.icon ? '<button class="btn ghost small" data-action="remove-icon">Remove</button>' : ""}</div></div>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Thumbnail</h2></div>
          <div class="card-body">
            <button type="button" class="brand-pick thumb-pick" data-drop="brand-thumbnail" data-pick="thumbnail" title="Upload thumbnail">${p.thumbnail ? `<img src="${src(p.thumbnail)}" alt="Thumbnail">` : `<span class="muted">${icon("images", 26)}<span>Drop a 16:9 image or click to upload</span></span>`}</button>
            <div class="row-gap spaced-sm">${assetChooser("thumbnail")}${p.thumbnail ? '<button class="btn ghost small" data-action="remove-thumbnail">Remove</button>' : ""}</div>
          </div>
        </section>
        ${typeof revenueSettingsCard === "function" ? revenueSettingsCard() : ""}
        <section class="card">
          <div class="card-head"><h2>${isOwner() ? "Delete project" : "Leave project"}</h2></div>
          <div class="card-body">
            <p class="muted">${isOwner() ? "Deletes the project with all its tasks, bugs, files, activity and messages for everyone. This can't be undone." : "You lose access until someone invites you again."}</p>
            <button class="btn danger" data-action="${isOwner() ? "delete-project" : "leave-project"}" ${deletingId === currentId ? "disabled" : ""}>${deletingId === currentId ? "Deleting…" : isOwner() ? "Delete project" : "Leave project"}</button>
          </div>
        </section>
      </div>
    </div>`;
}
const tagChips = (tags) => tags.map((t) => `<span class="tag-chip removable">${esc(t)}<button type="button" data-remove-tag="${esc(t)}" title="Remove tag">${icon("x", 12)}</button></span>`).join("");
function assetChooser(target) {
  const imgs = assets.filter((a) => isImageType(a.type));
  if (!imgs.length) return "";
  return `<button type="button" class="btn ghost small" data-pick-asset="${target}" data-menu-key="pick:${target}" aria-haspopup="menu">${icon("images", 15)}From assets</button>`;
}

function aboutCard() {
  return `<section class="card about-card"><div class="card-head"><h2>BLACKBOX</h2><span class="tag-chip">v${APP_VERSION}</span></div>
    <div class="card-body settings">
      <p class="muted small">${esc(CHANGELOG[0].title)}.</p>
      <div class="row-gap">
        <button type="button" class="btn small" data-action="whats-new">${icon("sparkle", 15)}What's new</button>
        ${!ARTIFACT && installPrompt ? `<button type="button" class="btn primary small" data-action="install-app">${icon("download", 15)}Install the app</button>` : ""}
      </div>
      ${!ARTIFACT && !installPrompt && !isStandalone() ? '<p class="muted small">To install BLACKBOX as an app: in Chrome or Edge, use the install icon in the address bar; on iPhone, tap Share then “Add to Home Screen”.</p>' : ""}
    </div></section>`;
}
function viewProfile() {
  const m = me();
  const prof = profiles[user.uid] || {};
  return `<div class="head compact"><div class="head-text"><div class="crumbs"><span>Account</span><span>/</span><b>Profile</b></div><h1>Your profile</h1></div></div>
    <div class="settings-layout">
      <form class="card settings-main" data-form="profile" data-drafts>
        <div class="card-head"><h2>Profile</h2><span class="muted small">Visible to your teammates</span></div>
        <div class="card-body settings">
          <div class="profile-top">
            <button type="button" class="avatar-pick" data-drop="avatar" data-pick="avatar" title="Change photo">${avatar(user.uid, 96)}<span class="avatar-edit">${icon("upload", 18)}</span></button>
            <div><div class="profile-name">${esc(m.name)}</div><div class="muted">${esc(prof.title || "No role set")}</div>
              ${prof.avatar ? '<button type="button" class="btn ghost small spaced-sm" data-action="remove-avatar">Remove photo</button>' : '<p class="muted small">Drop a photo on the avatar or click it to upload.</p>'}</div>
          </div>
          ${ARTIFACT
            ? `<label>Display name <span class="hint">leave empty to use your Claude name</span><input class="input" id="prof-name" name="name" maxlength="40" value="${esc(prof.name || "")}" placeholder="${esc(BB.name(user.uid) || m.name)}"></label>`
            : `<label>Display name<input class="input" id="prof-name" name="name" required maxlength="40" value="${esc(prof.name || m.name)}"></label>`}
          <label>Role <span class="hint">e.g. Developer, Artist, Builder</span><input class="input" id="prof-title" name="title" maxlength="40" value="${esc(prof.title || "")}"></label>
          <label>Contact email <span class="hint">shown on the team page</span><input class="input" id="prof-email" name="email" type="email" maxlength="80" value="${esc(prof.email || "")}" placeholder="${esc(ARTIFACT ? "you@example.com" : m.email)}"></label>
          <div><button class="btn primary">${icon("save", 17)}Save profile</button></div>
        </div>
      </form>
      ${!ARTIFACT && !user.providerData?.some((x) => x.providerId === "password") ? `<div class="settings-side">${aboutCard()}<section class="card"><div class="card-head"><h2>Sign-in</h2></div><div class="card-body"><p class="muted">You sign in with Google as <b>${esc(m.email)}</b>. Your email and password are managed in your Google account.</p></div></section></div>` : ARTIFACT ? `<div class="settings-side"><section class="card"><div class="card-head"><h2>Sign-in</h2></div><div class="card-body"><p class="muted">You use BLACKBOX with your Claude account. Your sign-in email and password are managed in Claude.</p></div></section>${aboutCard()}</div>` : `
      <div class="settings-side">
        ${aboutCard()}
        <form class="card" data-form="change-email" data-drafts>
          <div class="card-head"><h2>Sign-in email</h2></div>
          <div class="card-body settings">
            <p class="muted small">Currently <b>${esc(m.email)}</b>. We send a confirmation link to the new address; the change applies once you open it.</p>
            <label>New email<input class="input" id="new-email" name="email" type="email" required autocomplete="email"></label>
            <label>Current password<input class="input" id="email-pass" name="password" type="password" required autocomplete="current-password"></label>
            <div><button class="btn">Send confirmation</button></div>
          </div>
        </form>
        <form class="card" data-form="change-password" data-drafts>
          <div class="card-head"><h2>Password</h2></div>
          <div class="card-body settings">
            <label>Current password<input class="input" id="pw-current" name="current" type="password" required autocomplete="current-password"></label>
            <label>New password<input class="input" id="pw-new" name="next" type="password" required minlength="6" autocomplete="new-password"></label>
            <div><button class="btn">Change password</button></div>
          </div>
        </form>
      </div>`}
    </div>`;
}

function viewWelcome() {
  return `<div class="welcome">
    <h1>Welcome${me().name ? `, ${esc(me().name)}` : ""}</h1>
    <p class="lede">Create a project for your game, then invite your team.${invites.length ? " Or accept an invitation above." : ""}</p>
    <button class="btn primary" data-action="new-project">${icon("plus", 20, 2.2)}Create a project</button>
  </div>`;
}

/* ---------- Render ---------- */
function route() {
  const h = location.hash.slice(1) || "overview";
  const [name, arg] = h.split(".");
  return { name, arg };
}

function renderBanners() {
  const viewerNote = project() && project().memberIds.includes(user.uid) && roleOf(user.uid) === "viewer"
    ? `<div class="invite">${icon("eye", 20)}<span>You're a <b>Viewer</b> in this project: you can read everything and chat. Ask an admin if you need to make changes.</span></div>` : "";
  if (ARTIFACT) {
    const p = project();
    $("#invites").innerHTML = BB.canWrite === false
      ? `<div class="invite">${icon("mail", 20)}<span>You can view this workspace. Ask the owner to share it with you as <b>Editor</b> to make changes.</span></div>`
      : p && !p.memberIds.includes(user.uid)
        ? `<div class="invite">${icon("userPlus", 20)}<span>You're viewing <b>${esc(p.name)}</b>. Join to appear in its team and get tasks assigned.</span><span class="spacer"></span><button class="btn primary" data-join="${esc(currentId)}">Join project</button></div>`
        : viewerNote;
    return;
  }
  $("#invites").innerHTML = viewerNote + invites.map((p) => `<div class="invite">
    ${icon("mail", 20)}<span><b>${esc(p.members?.[p.ownerId]?.name || "Someone")}</b> invited you to <b>${esc(p.name)}</b></span>
    <span class="spacer"></span>
    <button class="btn ghost" data-decline="${esc(p.id)}">Decline</button>
    <button class="btn primary" data-accept="${esc(p.id)}">Accept</button>
  </div>`).join("");
}

function renderSidebar() {
  const p = project();
  const r = route();
  const ids = Object.keys(projects).sort((a, b) => projects[a].name.localeCompare(projects[b].name));
  const sel = $("#project-select");
  sel.innerHTML = ids.map((id) => `<option value="${esc(id)}" ${projects[id].icon ? `data-img="${src(projects[id].icon)}"` : ""} ${id === currentId ? "selected" : ""}>${esc(projects[id].name)}</option>`).join("");
  refreshSelect(sel);
  for (const id of ["project-picker", "side-nav", "side-collections-section", "side-team-section"]) $(`#${id}`).hidden = !p;
  const m = me();
  $("#side-user").innerHTML = `<a class="side-me ${r.name === "profile" ? "active" : ""}" href="#profile" title="Edit your profile">${avatar(m.uid, 42, m.name)}<div class="who"><div class="name ellipsis">${esc(m.name)}</div><div class="role ellipsis">${esc(profiles[m.uid]?.title || (ARTIFACT ? "Edit profile" : m.email))}</div></div></a>
    ${ARTIFACT ? "" : `<button class="icon-btn bare" data-action="sign-out" title="Sign out">${icon("logout", 19)}</button>`}`;
  $("#mobile-title").textContent = p ? p.name : "BLACKBOX";
  $("#install-btn").hidden = ARTIFACT || !installPrompt;
  $$("#mobile-tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === r.name || (a.dataset.tab === "tasks" && r.name === "bugs")));
  $("#mobile-tabs").hidden = !p;
  if (!p) return;
  document.querySelectorAll("#side-nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === r.name));
  const chatDot = channelsOf().some((c) => isUnread(c.id) && !(r.name === "chat" && c.id === channelId));
  $('#side-nav a[data-view="chat"]').classList.toggle("has-dot", chatDot);
  $('#mobile-tabs a[data-tab="chat"]').classList.toggle("has-dot", chatDot);
  $("#side-collections").innerHTML = (p.collections || []).map((c) => `<li><a href="#collection.${esc(c.id)}" class="${r.name === "collection" && r.arg === c.id ? "active" : ""}">${icon("folder", 20, 1.6)}<span class="grow ellipsis">${esc(c.name)}</span></a></li>`).join("")
    || '<li class="muted small-pad">No collections yet</li>';
  $("#team-count").textContent = p.memberIds.length;
  $("#side-team").innerHTML = p.memberIds.slice(0, 6).map((id) => avatar(id, 40)).join("") + `<a class="icon-btn round" href="#team" title="Team">${icon("users", 17)}</a>`;
}
const whatsNewUnseen = () => storeGet("blackbox:seen-version") !== APP_VERSION;
function openWhatsNew() {
  storeSet("blackbox:seen-version", APP_VERSION);
  $("#whats-new-list").innerHTML = CHANGELOG.map((v) => `<section class="wn-entry"><div class="row-gap"><span class="tag-chip">v${esc(v.version)}</span><b>${esc(v.title)}</b><span class="muted small">${esc(new Date(v.date).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }))}</span></div><ul>${v.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></section>`).join("");
  $("#whats-new-dialog").showModal();
  renderNotifPanel();
}

// Snapshot listeners batch their updates: several changes in one frame cause one render.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
// Updates the page in place (only what changed), so images stay loaded and scroll stays put.
function patch(el, html) {
  // Styled-select buttons are added after rendering; drop them first so the patch never reuses one
  // (with its click handler) as some other button. upgradeSelects() puts them back.
  el.querySelectorAll(".cselect").forEach((b) => b.remove());
  if (window.Idiomorph) {
    Idiomorph.morph(el, html, {
      morphStyle: "innerHTML", restoreFocus: true,
      callbacks: {
        // The field being typed in keeps its text and caret; everything else updates.
        beforeNodeMorphed: (oldNode, newNode) => {
          // An element with data-keep="<key>" is left alone (with its children) while its key is unchanged:
          // media players and the document editor keep their live state.
          if (oldNode.nodeType === 1 && oldNode.dataset?.keep && newNode.nodeType === 1 && newNode.dataset?.keep === oldNode.dataset.keep) return false;
          if (oldNode === document.activeElement && (oldNode.tagName === "INPUT" || oldNode.tagName === "TEXTAREA") && newNode.nodeType === 1) {
            if (oldNode.tagName === "TEXTAREA") newNode.textContent = oldNode.value; else newNode.setAttribute("value", oldNode.value);
          }
          return true;
        },
        // An image that already loaded keeps its "loaded" state instead of fading in again.
        // Elements marked data-live (media players) keep the classes and styles their scripts set.
        beforeAttributeUpdated: (name, node) => !(name === "class" && node.tagName === "IMG" && node.classList.contains("loaded"))
          && !((name === "class" || name === "style") && node.hasAttribute?.("data-live")),
      },
    });
  }
  else el.innerHTML = html;
}
let lastRoute = "";
let renderBlocked = false; // true while dragging a card: renders wait until the drop
let renderPending = false;

function render() {
  if (!user) return;
  if (renderBlocked) { renderPending = true; return; }
  // Menus anchored in the view follow the re-render; others (sidebar, dialogs) stay open untouched.
  const anchoredInView = popover.anchor && $("#view").contains(popover.anchor);
  const menuState = anchoredInView ? popoverState() : null;
  if (anchoredInView) closePopover();
  // Keep focus and caret when a live update re-renders the view.
  const focused = document.activeElement;
  const keep = focused && focused.id && $("#view").contains(focused)
    ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const chatScroll = $("#chat-log")?.scrollTop;
  const actScroll = $(".act-card")?.scrollTop;

  renderBanners();
  const r = route();
  const views = {
    overview: viewOverview,
    tasks: () => viewTaskList("task"),
    bugs: () => viewTaskList("bug"),
    activity: viewActivity,
    chat: viewChat,
    release: viewRelease,
    team: viewTeam,
    project: viewProjectSettings,
    assets: viewAssets,
    updates: () => viewUpdates(r.arg),
    collection: () => viewCollection(r.arg),
  };
  if (r.name === "assets") assetFolder = r.arg || "";
  lists = {};
  const view = $("#view");
  const routeKey = `${currentId}:${location.hash}`;
  const entering = routeKey !== lastRoute;
  lastRoute = routeKey;
  view.className = `panel view-${r.name}${entering && !viewTransition ? " view-enter" : ""}`;
  const html = r.name === "profile" ? viewProfile() : project() ? (MODULE_VIEWS[r.name] || views[r.name] || viewOverview)() : viewWelcome();
  // A new page is drawn fresh; the same page is patched.
  if (entering) view.innerHTML = html; else patch(view, html);
  restoreDrafts(view);
  upgradeSelects(view);
  renderSidebar();
  renderNotifPanel();
  if (r.name === "chat" && project() && document.visibilityState === "visible") markChannelRead();
  document.title = project() ? `${project().name} · BLACKBOX` : "BLACKBOX";
  autoGrow($("#chat-text"));

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      el.focus();
      try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text input */ }
    }
  }
  if (chatScroll !== undefined && $("#chat-log")) $("#chat-log").scrollTop = chatScroll;
  if (actScroll !== undefined && $(".act-card")) $(".act-card").scrollTop = actScroll;
  reanchorPopover(menuState);
}

/* ---------- Menus ---------- */
function openTaskMenu(btn) {
  const id = btn.dataset.taskMenu;
  const key = btn.dataset.list;
  openPopover(btn, () => {
    const ids = lists[key] || [];
    const i = ids.indexOf(id);
    const t = tasks.find((x) => x.id === id);
    const edit = can("edit");
    return [
      { id: "edit", label: edit ? "Edit" : "View", icon: edit ? "edit" : "eye" },
      { id: "up", label: "Up", icon: "arrowUp", disabled: !edit || i <= 0 },
      { id: "down", label: "Down", icon: "arrowDown", disabled: !edit || i < 0 || i >= ids.length - 1 },
      { sep: true },
      { id: "delete", label: "Delete", icon: "trash", danger: true, disabled: !canDelete(t?.createdBy) },
    ];
  }, (it) => {
    if (it.id === "edit") openTask(id);
    if (it.id === "up") moveTask(id, -1, key);
    if (it.id === "down") moveTask(id, 1, key);
    if (it.id === "delete") deleteTask(id);
  });
}

async function moveTask(id, dir, key) {
  const ids = lists[key] || [];
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  const vis = ids.map((x) => tasks.find((t) => t.id === x));
  const a = vis[i];
  let orders = vis.map((t) => t.order ?? 0);
  // Equal orders (older tasks) can't be swapped meaningfully: number the visible list first.
  if (new Set(orders).size !== orders.length) orders = orders.map((_, k) => k + 1);
  const next = orders.slice();
  [next[i], next[j]] = [orders[j], orders[i]];
  const batch = db.batch();
  vis.forEach((t, k) => { if ((t.order ?? 0) !== next[k]) batch.update(sub("tasks").doc(t.id), { order: next[k] }); });
  if (await act(() => batch.commit())) log("task.move", dir < 0 ? "moved up" : "moved down", a.title, a.type === "bug" ? "Bugs" : "Tasks");
}

async function deleteTask(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const ok = await ask({ title: `Delete "${t.title}"?`, text: "This removes it for the whole team.", ok: "Delete", danger: true });
  if (!ok) return;
  if (await act(() => sub("tasks").doc(id).delete(), "Deleted")) log(t.type === "bug" ? "bug.delete" : "task.delete", "deleted", t.title, t.type === "bug" ? "Bugs" : "Tasks");
}

/* ---------- Task dialog ---------- */
const taskDialog = $("#task-dialog");
const taskForm = $("#task-form");
let editingId = null;

function openTask(id, defaults = {}) {
  const p = project();
  const t = id ? tasks.find((x) => x.id === id) : null;
  editingId = t ? t.id : null;
  const ro = !can("edit");
  $("#task-dialog-title").textContent = ro ? "Task" : t ? "Edit task" : defaults.type === "bug" ? "Report a bug" : "New task";
  taskForm.querySelector("fieldset").disabled = ro;
  taskForm.querySelector('button[type="submit"]').hidden = ro;
  $("#cancel-task-btn").textContent = ro ? "Close" : "Cancel";
  $("#task-owner").innerHTML = '<option value="">Unassigned</option>' + p.memberIds.map((m) => `<option value="${esc(m)}">${esc(memberName(m))}</option>`).join("");
  const v = t || { title: "", desc: "", type: "task", priority: "medium", status: "todo", owner: user.uid, ...defaults };
  for (const k of ["title", "desc", "type", "priority", "status", "owner"]) taskForm.elements[k].value = v[k] || "";
  if (typeof bugFormOpen === "function") bugFormOpen(t, v, ro); // bug fields, labels and attachments (bugs.js)
  refreshSelects(taskForm);
  taskDialog.showModal();
  taskForm.elements.title.focus();
}

function taskChanges(before, after) {
  const out = [];
  const kind = after.type || before.type;
  const label = { status: (v) => statusLabel(v, kind), priority: (v) => PRIORITY[v]?.label, owner: (v) => (v ? memberName(v) : "Unassigned"), type: (v) => (v === "bug" ? "Bug" : "Task") };
  const names = { title: "Title", desc: "Description", status: "Status", priority: "Priority", owner: "Owner", type: "Type" };
  for (const k of Object.keys(names)) {
    if ((before[k] || "") === (after[k] || "")) continue;
    const f = label[k] || ((v) => v);
    out.push({ field: names[k], from: f(before[k]) || "", to: f(after[k]) || "" });
  }
  if (typeof bugChanges === "function") out.push(...bugChanges(before, after));
  return out;
}

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(taskForm));
  data.title = data.title.trim();
  data.desc = data.desc.trim();
  if (!data.title) return;
  const editId = editingId;
  // Bug fields and attachments (uploads stay in the dialog until they're done) — bugs.js.
  if (typeof bugFormData === "function" && !(await bugFormData(data, editId))) return;
  taskDialog.close();
  const where = data.type === "bug" ? "Bugs" : "Tasks";
  if (editId) {
    const before = tasks.find((x) => x.id === editId) || {};
    const changes = taskChanges(before, data);
    if (!changes.length) return;
    if (await act(() => sub("tasks").doc(editId).update({ ...data, updatedAt: Date.now() }))) {
      const completed = before.status !== "done" && data.status === "done";
      const type = data.type === "bug" ? (completed ? "bug.fixed" : "bug.update") : (completed ? "task.complete" : "task.update");
      log(type, completed ? (data.type === "bug" ? "fixed" : "completed") : "updated", data.title, where, { changes, ref: `task:${editId}` });
      if (data.owner && data.owner !== before.owner) notify(data.owner, "assign", data.title, data.type === "bug" ? `#bugs.${editId}` : "#tasks");
    }
  } else {
    const order = Math.max(0, ...tasks.map((t) => t.order ?? 0)) + 1;
    const ref = await act(() => sub("tasks").add({ ...data, order, createdBy: user.uid, createdAt: Date.now() }));
    if (ref) {
      if (data.type === "bug") log("bug.report", "reported a new bug", "", "Bugs", { detail: data.title, ref: `task:${ref.id}` });
      else log("task.create", "created", data.title, "Tasks", { ref: `task:${ref.id}` });
      if (data.owner) notify(data.owner, "assign", data.title, data.type === "bug" ? `#bugs.${ref.id}` : "#tasks");
    }
  }
});
$("#cancel-task-btn").addEventListener("click", () => taskDialog.close());

/* ---------- Item dialog (collections) ---------- */
const itemDialog = $("#item-dialog");
const itemForm = $("#item-form");
let itemEdit = { id: null, collectionId: null, file: null, image: "", preview: "" };

function openItem(collectionId, id = null, file = null) {
  const x = id ? items.find((i) => i.id === id) : null;
  if (itemEdit.preview) URL.revokeObjectURL(itemEdit.preview);
  itemEdit = { id, collectionId: x?.collectionId || collectionId, file, image: x?.image || "", preview: file ? URL.createObjectURL(file) : "" };
  const ro = !can("edit");
  $("#item-dialog-title").textContent = ro ? "Item" : x ? "Edit item" : "New item";
  itemForm.querySelector("fieldset").disabled = ro;
  $("#item-save").hidden = ro;
  $("#item-cancel").textContent = ro ? "Close" : "Cancel";
  $("#item-name").value = x?.name || (file ? file.name.replace(/\.[^.]+$/, "") : "");
  $("#item-desc").value = x?.desc || "";
  renderItemPreview();
  itemDialog.showModal();
  $("#item-name").focus();
}
function renderItemPreview() {
  // A fresh pick is a local blob: preview; a saved image goes through safeUrl.
  const url = itemEdit.preview || safeUrl(itemEdit.image);
  $("#item-image-preview").innerHTML = url
    ? `<img src="${esc(url)}" alt=""><span class="change-hint">${icon("upload", 16)}Change image</span>`
    : `<span class="muted">${icon("image", 30)}<span>Drop an image or click to choose</span></span>`;
  $("#item-remove-image").hidden = !url;
}
function setItemFile(file) {
  if (!isImageType(file.type)) return toast("Choose an image file.", true);
  if (itemEdit.preview) URL.revokeObjectURL(itemEdit.preview);
  itemEdit.file = file;
  itemEdit.preview = URL.createObjectURL(file);
  renderItemPreview();
}
$("#item-file").addEventListener("change", (e) => { if (e.target.files[0]) setItemFile(e.target.files[0]); e.target.value = ""; });
$("#item-remove-image").addEventListener("click", () => {
  if (itemEdit.preview) URL.revokeObjectURL(itemEdit.preview);
  Object.assign(itemEdit, { file: null, image: "", preview: "" });
  renderItemPreview();
});
$("#item-cancel").addEventListener("click", () => itemDialog.close());
itemForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#item-name").value.trim();
  const desc = $("#item-desc").value.trim();
  if (!name) return;
  const btn = $("#item-save");
  btn.disabled = true;
  const { id, collectionId, file } = itemEdit;
  let image = itemEdit.image;
  const coll = project().collections.find((c) => c.id === collectionId);
  const ok = await act(async () => {
    if (file) image = (await storeFile(file, "item")).url;
    if (id) await sub("items").doc(id).update({ name, desc, image, updatedAt: Date.now() });
    else await sub("items").add({ collectionId, name, desc, image, createdBy: user.uid, createdAt: Date.now() });
  }, id ? "Item saved" : "Item added");
  btn.disabled = false;
  if (!ok) return;
  itemDialog.close();
  log(id ? "item.update" : "item.add", id ? "updated" : "added", name, coll?.name || "Collections");
});

async function addItemsFromFiles(collectionId, files) {
  const imgs = files.filter((f) => isImageType(f.type));
  if (!imgs.length) return toast("Drop image files to create items.", true);
  if (imgs.length === 1) return openItem(collectionId, null, imgs[0]);
  const coll = project().collections.find((c) => c.id === collectionId);
  let added = 0;
  toast(`Adding ${imgs.length} items…`);
  const t0 = Date.now();
  await mapLimit(imgs.map((f, i) => [f, i]), 3, async ([f, i]) => {
    const ok = await act(async () => {
      const up = await storeFile(f, "item");
      await sub("items").add({ collectionId, name: f.name.replace(/\.[^.]+$/, "").slice(0, 60), desc: "", image: up.url, createdBy: user.uid, createdAt: t0 + i });
    });
    if (ok) added++;
  });
  if (added) {
    toast(`${added} item${added === 1 ? "" : "s"} added`);
    log("item.add", `added ${added} items to`, coll?.name || "", coll?.name || "Collections");
  }
}

/* ---------- Assets ---------- */
async function uploadAssets(files, kind) {
  const created = [];
  const folder = route().name === "assets" ? assetFolder : "";
  toast(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`);
  // Several files upload at once.
  await mapLimit(files, 3, async (f) => {
    const k = isGif(f) ? "gif" : kind;
    const doc = await act(async () => {
      const up = await storeFile(f, k === "icon" ? "icon" : k === "thumbnail" ? "thumbnail" : "asset");
      const data = { name: f.name.slice(0, 100), kind: isImageType(up.type) ? k : "other", url: up.url, type: up.type, size: up.size, width: up.width || 0, height: up.height || 0, folder, uid: user.uid, at: Date.now() };
      await sub("assets").add(data);
      return data;
    });
    if (doc) created.push(doc);
  });
  const done = created.length;
  if (done) {
    toast(`${done} file${done === 1 ? "" : "s"} uploaded`);
    log("asset.upload", done === 1 ? "uploaded" : `uploaded ${done} files`, done === 1 ? created[0].name : "", "Assets");
  }
  return created;
}

async function setBranding(field, url, label) {
  if (url && !safeUrl(url)) return toast("This image can't be used.", true);
  if (await act(() => updateProject({ [field]: url }), url ? `${label} updated` : `${label} removed`)) {
    log("project.branding", url ? `changed the game ${label.toLowerCase()}` : `removed the game ${label.toLowerCase()}`, "", "Settings");
  }
}
async function uploadBranding(field, file) {
  if (!isImageType(file.type)) return toast("Choose an image file.", true);
  const purpose = field === "icon" ? "icon" : "thumbnail";
  const up = await act(() => storeFile(file, purpose));
  if (up) await setBranding(field, up.url, field === "icon" ? "Icon" : "Thumbnail");
}

// Firebase keeps images inline, so an asset is re-compressed to icon or thumbnail size before it
// goes into the project document (which every member downloads and which holds at most 1 MB).
async function brandFromAsset(field, a) {
  const label = field === "icon" ? "Icon" : "Thumbnail";
  if (ARTIFACT) return setBranding(field, a.url, label);
  const up = await act(async () => {
    const blob = await (await fetch(safeUrl(a.url))).blob();
    return storeFile(new File([blob], a.name, { type: blob.type }), field === "icon" ? "icon" : "thumbnail");
  });
  if (up) await setBranding(field, up.url, label);
}

function openAssetMenu(btn) {
  const a = assets.find((x) => x.id === btn.dataset.assetMenu);
  if (!a) return;
  const img = isImageType(a.type);
  openPopover(btn, () => [
    ...(img ? [{ id: "view", label: "View", icon: "expand" }] : [{ id: "open", label: "Open", icon: "expand" }]),
    ...(safeUrl(a.url) ? [{ id: "download", label: "Download", icon: "download" }] : []),
    { id: "rename", label: "Rename", icon: "edit", disabled: !can("edit") },
    { id: "move", label: "Move to…", icon: "folder", disabled: !can("edit") || !foldersOf().length },
    ...(img ? [{ id: "icon", label: "Use as game icon", icon: "star", disabled: !can("manage") }, { id: "thumb", label: "Use as thumbnail", icon: "images", disabled: !can("manage") }] : []),
    { sep: true },
    { id: "delete", label: "Delete", icon: "trash", danger: true, disabled: !canDelete(a.uid) },
  ], async (it, anchor) => {
    if (it.id === "download") downloadFile(a.url, a.name);
    if (it.id === "move") openPopover(anchor, () => [{ id: "", label: "No folder (All assets)", icon: "images", selected: !a.folder }, ...foldersOf().map((f) => ({ id: f.id, label: f.name, icon: "folder", selected: a.folder === f.id }))], (f) => moveAsset(a.id, f.id));
    if (it.id === "view") openLightbox(a.url, a.name);
    if (it.id === "open" && safeUrl(a.url)) window.open(safeUrl(a.url), "_blank", "noopener");
    if (it.id === "icon") brandFromAsset("icon", a);
    if (it.id === "thumb") brandFromAsset("thumbnail", a);
    if (it.id === "rename") {
      const res = await ask({ title: "Rename asset", fields: [{ label: "Name", value: a.name, max: 100 }], ok: "Save" });
      if (res && res[0] && res[0] !== a.name && await act(() => sub("assets").doc(a.id).update({ name: res[0] }))) log("asset.update", "renamed", res[0], "Assets", { changes: [{ field: "Name", from: a.name, to: res[0] }] });
    }
    if (it.id === "delete") {
      if (!(await ask({ title: `Delete ${a.name}?`, text: "Messages or items that show it keep their own copy only in the GitHub version.", ok: "Delete", danger: true }))) return;
      if (await act(() => sub("assets").doc(a.id).delete(), "Asset deleted")) log("asset.delete", "deleted", a.name, "Assets");
    }
  });
}

/* ---------- Chat ---------- */
function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}
function addChatFiles(files) {
  for (const file of files) {
    if (chatPending.length >= 10) { toast("You can attach up to 10 files per message.", true); break; }
    const kind = mediaKind(file.type);
    const max = ARTIFACT ? 20 : kind === "image" ? 15 : MEDIA_MAX[kind];
    if (file.size > max * 1048576) { toast(`${file.name} is larger than ${max} MB.`, true); continue; }
    chatPending.push({ id: Math.random().toString(36).slice(2), file, kind, preview: kind === "image" || kind === "video" ? URL.createObjectURL(file) : "" });
  }
  render();
  $("#chat-text")?.focus();
}
function wrapSelection(el, marker) {
  if (marker === "@") {
    const a = el.selectionStart;
    const pre = a > 0 && !/\s/.test(el.value[a - 1]) ? " @" : "@";
    el.setRangeText(pre, a, el.selectionEnd, "end");
    el.focus();
    drafts[el.id] = el.value;
    return updateMentionPicker(el);
  }
  const { selectionStart: a, selectionEnd: b, value } = el;
  const sel = value.slice(a, b);
  let next, caretA, caretB;
  if (marker === "> ") {
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    next = value.slice(0, lineStart) + "> " + value.slice(lineStart);
    caretA = a + 2; caretB = b + 2;
  } else {
    next = value.slice(0, a) + marker + sel + marker + value.slice(b);
    caretA = a + marker.length; caretB = b + marker.length;
  }
  el.value = next;
  drafts[el.id] = next;
  el.focus();
  el.setSelectionRange(caretA, caretB);
  autoGrow(el);
}
// Firebase keeps attachments inline, so a message holds what fits in one document (about 900 KB);
// the rest go into follow-up messages.
function chunkAttachments(atts) {
  if (ARTIFACT) return [atts];
  const chunks = [[]];
  let size = 0;
  for (const a of atts) {
    const s = a.url.length;
    if (chunks.at(-1).length && size + s > 900 * 1024) { chunks.push([]); size = 0; }
    chunks.at(-1).push(a);
    size += s;
  }
  return chunks;
}
// Sending is instant: the message joins the outbox (shown with local previews), the composer clears,
// and uploads run in the background. A failure keeps it in the outbox with Retry and Discard.
function sendChat() {
  const box = $("#chat-text");
  const raw = box.value.trim();
  if (!raw && !chatPending.length) return;
  const entry = { id: `out-${Math.random().toString(36).slice(2)}`, pid: currentId, channel: channelId, text: tokenizeMentions(raw), files: chatPending, at: Date.now(), state: "sending", posted: 0 };
  outbox.push(entry);
  chatPending = [];
  box.value = "";
  stopTyping();
  delete drafts["chat-text"];
  closeMentionPicker();
  render();
  scrollChatDown();
  box.focus();
  processOutbox(entry);
}
async function processOutbox(entry) {
  if (entry.busy) return; // a double-clicked Retry must not post twice
  entry.busy = true;
  entry.state = "sending";
  entry.hidden = false;
  scheduleRender();
  const m = me();
  const col = projectsCol().doc(entry.pid);
  const msgs = entry.channel === "general" ? col.collection("messages") : col.collection("channels").doc(entry.channel).collection("messages");
  const ok = await act(async () => {
    // Files are prepared in parallel; already prepared ones are reused on retry.
    await mapLimit(entry.files.filter((f) => !f.att), 3, async (f) => { f.att = { ...(await storeFile(f.file, "chat", entry.pid)), ...(f.extra || {}) }; });
    const chunks = chunkAttachments(entry.files.map((f) => f.att));
    for (let i = entry.posted; i < chunks.length; i++) {
      const pending = msgs.add({ uid: m.uid, name: storedName(), text: i === 0 ? entry.text : "", attachments: chunks[i], at: entry.at + i });
      if (i === chunks.length - 1) { entry.hidden = true; scheduleRender(); } // the real message is already on screen
      await pending;
      entry.posted = i + 1;
    }
  });
  entry.busy = false;
  if (!ok) {
    entry.state = "failed";
    entry.hidden = false;
    entry.error = navigator.onLine ? "the upload failed" : "you're offline";
    scheduleRender();
    return;
  }
  outbox = outbox.filter((o) => o !== entry);
  entry.files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
  for (const id of mentionedIds(entry.text)) notify(id, "mention", detokenizeMentions(entry.text).slice(0, 120), `#chat.${entry.channel}`, entry.pid);
  scheduleRender();
}
async function sendGif(asset) {
  gifOpen = false;
  const m = me();
  await act(() => msgCol().add({ uid: m.uid, name: storedName(), text: "", attachments: [{ url: asset.url, name: asset.name, type: asset.type || "image/gif", size: asset.size || 0, width: asset.width || 0, height: asset.height || 0 }], at: Date.now() }));
  render();
  scrollChatDown();
}
async function saveMessageEdit(id, text) {
  const m = messages.find((x) => x.id === id);
  editingMsg = null;
  delete drafts["msg-edit-text"];
  const next = tokenizeMentions(text.trim(), mentionedIds(m?.text));
  if (!m || next === (m.text || "")) return render();
  if (!next && !m.attachments?.length) return render();
  await act(() => msgCol().doc(id).update({ text: next, editedAt: Date.now() }));
  render();
}

/* ---------- Actions ---------- */
function updateCollections(fn) {
  const colls = structuredClone(project().collections || []);
  fn(colls);
  return act(() => updateProject({ collections: colls }));
}
function updateRelease(fn) {
  const r = structuredClone(project().release || { name: "UPDATE 1", due: "", items: [] });
  fn(r);
  return act(() => updateProject({ release: r }));
}

function openCollMenu(btn) {
  const c = project().collections.find((x) => x.id === btn.dataset.collMenu);
  openPopover(btn, () => [
    { id: "edit", label: "Rename or describe", icon: "edit", disabled: !can("edit") },
    { sep: true },
    { id: "delete", label: "Delete collection", icon: "trash", danger: true, disabled: !can("manage") },
  ], async (it) => {
    if (it.id === "edit") {
      const res = await ask({ title: "Edit collection", fields: [{ label: "Name", value: c.name, max: 40 }, { label: "Description", value: c.desc, optional: true, max: 160, multiline: true }], ok: "Save" });
      if (res && res[0] && await updateCollections((cs) => Object.assign(cs.find((x) => x.id === c.id), { name: res[0], desc: res[1] }))) {
        log("collection.update", "updated collection", res[0], "Collections", { changes: [res[0] !== c.name && { field: "Name", from: c.name, to: res[0] }, (res[1] || "") !== (c.desc || "") && { field: "Description", from: c.desc || "", to: res[1] }].filter(Boolean) });
      }
    }
    if (it.id === "delete") {
      const its = items.filter((x) => x.collectionId === c.id);
      if (!(await ask({ title: `Delete "${c.name}"?`, text: its.length ? `Its ${its.length} item${its.length === 1 ? "" : "s"} are deleted too, for everyone.` : "It's removed for everyone.", ok: "Delete", danger: true }))) return;
      const ok = await act(async () => {
        for (const x of its) await sub("items").doc(x.id).delete();
        const colls = structuredClone(project().collections || []).filter((x) => x.id !== c.id);
        await updateProject({ collections: colls });
      }, "Collection deleted");
      if (ok) { log("collection.delete", "deleted collection", c.name, "Collections"); location.hash = "#overview"; }
    }
  });
}

function openItemMenu(btn) {
  const x = items.find((i) => i.id === btn.dataset.itemMenu);
  if (!x) return;
  openPopover(btn, () => [
    ...(x.image ? [{ id: "view", label: "View image", icon: "expand" }, { id: "download", label: "Download image", icon: "download" }] : []),
    { id: "edit", label: "Edit", icon: "edit", disabled: !can("edit") },
    { sep: true },
    { id: "delete", label: "Delete", icon: "trash", danger: true, disabled: !canDelete(x.createdBy) },
  ], async (it) => {
    if (it.id === "download") downloadFile(x.image, `${x.name}.png`);
    const coll = project().collections.find((c) => c.id === x.collectionId);
    if (it.id === "view") openLightbox(x.image, x.name);
    if (it.id === "edit") openItem(x.collectionId, x.id);
    if (it.id === "delete") {
      if (!(await ask({ title: `Delete "${x.name}"?`, ok: "Delete", danger: true }))) return;
      if (await act(() => sub("items").doc(x.id).delete(), "Item deleted")) log("item.delete", "deleted", x.name, coll?.name || "Collections");
    }
  });
}

function openAssetPicker(btn) {
  const target = btn.dataset.pickAsset;
  openPopover(btn, () => assets.filter((a) => isImageType(a.type)).slice(0, 30).map((a) => ({ id: a.id, label: a.name, img: a.url })), (it) => {
    const a = assets.find((x) => x.id === it.id);
    if (a) brandFromAsset(target, a);
  });
}

// Minimum role for toolbar actions (rules enforce the same in the GitHub edition).
const ACTION_PERMS = {
  "new-task": "edit", "new-collection": "edit", "new-item": "edit", "edit-release": "edit", "new-folder": "edit",
  "new-channel": "manage", "new-update": "manage", "edit-update": "manage", "publish-update": "manage", "unpublish-update": "manage",
  "delete-update": "manage", "remove-icon": "manage", "remove-thumbnail": "manage",
};

// Downloads a file from the app. Artifact pages save through the viewer (it asks to confirm).
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf" };
async function downloadFile(url, name = "image") {
  try {
    const safe = await resolveMedia(url);
    if (!safe) return;
    const blob = await (await fetch(safe)).blob();
    const ext = EXT[blob.type.split(";")[0]] || (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "png");
    const filename = /\.[a-z0-9]{2,4}$/i.test(name) && name.toLowerCase().endsWith(ext) ? name : `${name.replace(/\.[^.]+$/, "")}.${ext}`;
    if (ARTIFACT) return await BB.download(blob, filename);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) {
    if (e?.code === "declined") return;
    console.error("BLACKBOX: download", e);
    toast(e?.code === "unavailable" ? "Downloads aren't available here." : "The download didn't work.", true);
  }
}

async function moveAsset(id, folder) {
  const a = assets.find((x) => x.id === id);
  if (!a || (a.folder || "") === folder) return;
  const to = foldersOf().find((f) => f.id === folder)?.name || "All assets";
  if (await act(() => sub("assets").doc(id).update({ folder }), `Moved to ${to}`)) log("asset.move", `moved to ${to}`, a.name, "Assets");
}
function openFolderMenu(btn) {
  const f = foldersOf().find((x) => x.id === btn.dataset.folderMenu);
  if (!f) return;
  openPopover(btn, () => [
    { id: "rename", label: "Rename", icon: "edit" },
    { sep: true },
    { id: "delete", label: "Delete folder", icon: "trash", danger: true },
  ], async (it) => {
    if (it.id === "rename") {
      const [name] = (await ask({ title: "Rename folder", fields: [{ label: "Folder name", value: f.name, max: 40 }], ok: "Save" })) || [];
      if (name && name !== f.name && await act(() => updateProject({ assetFolders: foldersOf().map((x) => (x.id === f.id ? { ...x, name } : x)) }))) log("folder.update", "renamed folder", name, "Assets", { changes: [{ field: "Name", from: f.name, to: name }] });
    }
    if (it.id === "delete") {
      const inside = assets.filter((a) => a.folder === f.id);
      if (!(await ask({ title: `Delete the folder ${f.name}?`, text: inside.length ? `Its ${inside.length} file${inside.length === 1 ? "" : "s"} move back to All assets. Nothing is deleted.` : "", ok: "Delete folder", danger: true }))) return;
      const ok = await act(async () => {
        await mapLimit(inside, 4, (a) => sub("assets").doc(a.id).update({ folder: "" }));
        await updateProject({ assetFolders: foldersOf().filter((x) => x.id !== f.id) });
      }, "Folder deleted");
      if (ok) { log("folder.delete", "deleted folder", f.name, "Assets"); if (assetFolder === f.id) location.hash = "#assets"; }
    }
  });
}

async function editChannel(id) {
  const c = id ? channel(id) : null;
  const res = await ask({ title: c ? `Edit #${c.name}` : "New channel", fields: [{ label: "Channel name", value: c?.name || "", max: 30 }, { label: "Topic", value: c?.topic || "", optional: true, max: 120 }], ok: c ? "Save" : "Create" });
  if (!res || !res[0]) return;
  const name = res[0].toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 30) || "channel";
  const list = channelsOf();
  if (c) {
    const next = list.map((x) => (x.id === c.id ? { ...x, name, topic: res[1] } : x));
    if (await act(() => updateProject({ channels: next, channelIds: next.map((x) => x.id) }))) log("channel.update", "updated channel", `#${name}`, "Chat");
    return;
  }
  let cid = slug(name);
  while (list.some((x) => x.id === cid)) cid += "-2";
  const next = [...list, { id: cid, name, topic: res[1] || "" }];
  // channelIds lets the security rules check that a channel exists.
  if (await act(() => updateProject({ channels: next, channelIds: next.map((x) => x.id) }), `#${name} created`)) {
    log("channel.create", "created channel", `#${name}`, "Chat");
    location.hash = `#chat.${cid}`;
  }
}
function openChannelMenu(btn) {
  const c = channel(btn.dataset.chanMenu);
  openPopover(btn, () => [
    { id: "edit", label: "Rename or set topic", icon: "edit" },
    { sep: true },
    { id: "delete", label: "Delete channel", icon: "trash", danger: true, disabled: c.id === "general" },
  ], async (it) => {
    if (it.id === "edit") editChannel(c.id);
    if (it.id === "delete") {
      if (!(await ask({ title: `Delete #${c.name}?`, text: "All its messages are deleted for everyone.", ok: "Delete channel", danger: true }))) return;
      const ok = await act(async () => {
        // Close the channel first so nothing new lands in it, then clear its messages.
        const next = channelsOf().filter((x) => x.id !== c.id);
        await updateProject({ channels: next, channelIds: next.map((x) => x.id) });
        const snap = await msgCol(c.id).get();
        await mapLimit(snap.docs, 4, (d) => d.ref.delete());
      }, "Channel deleted");
      if (ok) { log("channel.delete", "deleted channel", `#${c.name}`, "Chat"); location.hash = "#chat.general"; }
    }
  });
}

async function setRole(uid, role) {
  const prev = roleOf(uid);
  if (prev === role || role === "owner" || uid === project().ownerId) return;
  if (await act(() => updateProject({ [`roles.${uid}`]: role }), `${memberName(uid)} is now ${ROLES[role].label}`)) {
    log("member.role", `made ${memberName(uid)}`, ROLES[role].label, "Team", { changes: [{ field: "Role", from: ROLES[prev].label, to: ROLES[role].label }] });
    notify(uid, "role", ROLES[role].label, "#team");
  }
}

// Internal drag of an asset card onto a folder (desktop).
document.addEventListener("dragstart", (e) => {
  const card = e.target.closest?.(".asset-card[draggable]");
  if (!card) return;
  e.dataTransfer.setData("application/x-blackbox-asset", card.dataset.asset);
  e.dataTransfer.effectAllowed = "move";
  document.body.classList.add("dragging-asset");
});
document.addEventListener("dragend", () => { document.body.classList.remove("dragging-asset"); $$(".folder-over").forEach((x) => x.classList.remove("folder-over")); });
document.addEventListener("dragover", (e) => {
  const t = e.target.closest?.("[data-folder-drop]");
  if (!t || !e.dataTransfer.types.includes("application/x-blackbox-asset")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  $$(".folder-over").forEach((x) => x !== t && x.classList.remove("folder-over"));
  t.classList.add("folder-over");
});
document.addEventListener("drop", (e) => {
  const t = e.target.closest?.("[data-folder-drop]");
  const id = e.dataTransfer?.getData("application/x-blackbox-asset");
  if (!t || !id) return;
  e.preventDefault();
  t.classList.remove("folder-over");
  moveAsset(id, t.dataset.folderDrop);
});

const actions = {
  "new-task": (el) => openTask(null, { type: route().name === "bugs" ? "bug" : "task", status: el?.dataset.status || "todo" }),
  "new-channel": () => editChannel(null),
  "new-folder": async () => {
    const [name] = (await ask({ title: "New folder", fields: [{ label: "Folder name", max: 40 }], ok: "Create" })) || [];
    if (!name) return;
    let id = slug(name);
    while (foldersOf().some((f) => f.id === id)) id += "-2";
    if (await act(() => updateProject({ assetFolders: [...foldersOf(), { id, name }] }), "Folder created")) log("folder.create", "created folder", name, "Assets");
  },
  // Update actions (new/edit/publish/delete…) live in updates.js.
  "toggle-notifs": () => { notifOpen = !notifOpen; renderNotifPanel(); },
  "read-all": () => markAllRead(),
  "jump-latest": () => scrollChatDown(true),
  "open-menu": () => setMenu(true),
  "install-app": () => installApp(),
  "whats-new": () => openWhatsNew(),
  "new-project": async () => {
    const [name] = (await ask({ title: "New project", fields: [{ label: "Game name", max: 40 }], ok: "Create" })) || [];
    if (name) await act(() => createProject(name), "Project created");
  },
  "new-collection": async () => {
    const res = await ask({ title: "New collection", fields: [{ label: "Name", max: 40 }, { label: "Description", optional: true, max: 160, multiline: true }], ok: "Create" });
    if (!res || !res[0]) return;
    const colls = project().collections || [];
    let id = slug(res[0]);
    while (colls.some((c) => c.id === id)) id += "-2";
    if (await updateCollections((cs) => cs.push({ id, name: res[0], desc: res[1] || "" }))) {
      log("collection.create", "created collection", res[0], "Collections");
      location.hash = `#collection.${id}`;
      render();
    }
  },
  "new-item": (el) => openItem(el.dataset.collection),
  "edit-release": async () => {
    const r = project().release || {};
    const res = await ask({ title: "Edit release", fields: [{ label: "Release name", value: r.name, max: 40 }, { label: "Due date", value: r.due, optional: true, max: 30 }], ok: "Save" });
    if (res && res[0] && await updateRelease((x) => { x.name = res[0]; x.due = res[1]; })) {
      log("release.update", "updated the release", res[0], "Release", { changes: [res[0] !== r.name && { field: "Name", from: r.name || "", to: res[0] }, (res[1] || "") !== (r.due || "") && { field: "Due", from: r.due || "", to: res[1] }].filter(Boolean) });
    }
  },
  "remove-icon": () => setBranding("icon", "", "Icon"),
  "remove-thumbnail": () => setBranding("thumbnail", "", "Thumbnail"),
  "remove-avatar": () => saveProfile({ avatar: "" }, "Photo removed"),
  "load-older": () => { activityLimit += 100; listenActivity(); },
  "toggle-gifs": () => { gifOpen = !gifOpen; render(); },
  "delete-project": async () => {
    const p = project();
    const res = await ask({ title: `Delete ${p.name}?`, text: "Type the project name to confirm. This deletes everything in it for the whole team.", fields: [{ label: "Project name" }], ok: "Delete project", danger: true });
    if (!res) return;
    if (res[0] !== p.name) return toast("The name doesn't match, so nothing was deleted.", true);
    // Stay on the project until everything is gone, so nobody leaves while the deletion is half done.
    deletingId = currentId;
    render();
    const ok = await act(() => deleteProjectData(deletingId), "Project deleted");
    deletingId = null;
    if (ok) location.hash = "#overview";
    render();
  },
  "leave-project": async () => {
    const p = project();
    if (!(await ask({ title: `Leave ${p.name}?`, ok: "Leave", danger: true }))) return;
    const id = currentId;
    await act(() => sub("activity").add({ uid: user.uid, name: storedName(), type: "member.leave", verb: "left the project", target: "", where: "Team", detail: "", changes: [], at: Date.now() }));
    await act(() => projectsCol().doc(id).update({
      memberIds: FV().arrayRemove(user.uid),
      [`members.${user.uid}`]: FV().delete(),
    }), "You left the project");
  },
  "sign-out": () => auth.signOut(),
};

async function saveProfile(patch, okMsg = "Profile saved") {
  const current = profiles[user.uid] || {};
  const next = { name: current.name || "", title: current.title || "", email: current.email || "", avatar: current.avatar || "", ...patch, updatedAt: Date.now() };
  const ok = await act(() => db.collection("profiles").doc(user.uid).set(next), okMsg);
  if (ok && !ARTIFACT && patch.name && patch.name !== user.displayName) user.updateProfile({ displayName: patch.name }).catch((e) => console.error("BLACKBOX: display name", e));
  return ok;
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action],[data-task-menu],[data-task],[data-filter],[data-remove-release],[data-remove-member],[data-cancel-invite],[data-accept],[data-decline],[data-delete-msg],[data-edit-msg],[data-join],[data-act-filter],[data-asset-kind],[data-view-mode],[data-item-menu],[data-coll-menu],[data-asset-menu],[data-item],[data-lightbox],[data-fmt],[data-remove-pending],[data-send-gif],[data-remove-tag],[data-pick-asset],[data-pick],[data-download],[data-notif],[data-mention-pick],[data-folder-menu],[data-chan-menu],[data-board-mode],[data-outbox-retry],[data-outbox-discard]");
  if (notifOpen && !e.target.closest("#notif-panel, #bell")) { notifOpen = false; renderNotifPanel(); }
  if (gifOpen && !e.target.closest(".gif-wrap")) { gifOpen = false; render(); }
  if (!el || !user) return;
  const d = el.dataset;

  if (d.taskMenu) return popover.anchor === el ? closePopover() : openTaskMenu(el);
  if (d.itemMenu) { e.stopPropagation(); return popover.anchor === el ? closePopover() : openItemMenu(el); }
  if (d.collMenu) return popover.anchor === el ? closePopover() : openCollMenu(el);
  if (d.assetMenu) { e.stopPropagation(); return popover.anchor === el ? closePopover() : openAssetMenu(el); }
  if (d.pickAsset) return popover.anchor === el ? closePopover() : openAssetPicker(el);
  if (d.download) { e.preventDefault(); e.stopPropagation(); return downloadFile(d.download, d.name); }
  if (d.notif) return openNotif(d.notif);
  if (d.mentionPick !== undefined) return pickMention(+d.mentionPick);
  if (d.folderMenu) { e.preventDefault(); e.stopPropagation(); return popover.anchor === el ? closePopover() : openFolderMenu(el); }
  if (d.chanMenu) return popover.anchor === el ? closePopover() : openChannelMenu(el);
  if (d.boardMode) { storeSet(`blackbox:board:${d.boardType}`, d.boardMode); return render(); }
  if (d.outboxRetry) { const o = outbox.find((x) => x.id === d.outboxRetry); if (o) processOutbox(o); return; }
  if (d.outboxDiscard) { outbox = outbox.filter((x) => x.id !== d.outboxDiscard); return render(); }
  if (d.pick) {
    const need = FILE_TARGETS[d.pick] ? FILE_TARGET_PERMS[d.pick] || "edit" : d.pick === "chat" ? "chat" : ["icon", "thumbnail", "update-cover"].includes(d.pick) ? "manage" : d.pick === "avatar" ? null : "edit";
    if (need && !can(need)) return toast("Your role in this project can't do that.", true);
    return pickFiles(el);
  }
  if (d.action) {
    if (ACTION_PERMS[d.action] && !can(ACTION_PERMS[d.action])) return toast("Your role in this project can't do that.", true);
    return actions[d.action]?.(el);
  }
  if (d.lightbox) return openLightbox(d.lightbox, d.caption);
  if (d.task) return tasks.find((x) => x.id === d.task)?.type === "bug" && typeof openBug === "function" ? openBug(d.task) : openTask(d.task);
  if (d.item) return openItem(null, d.item);
  if (d.filter) {
    const [k, v] = d.filter.split(":");
    taskFilter[k] = v;
    return render();
  }
  if (d.actFilter) { activityFilter.type = d.actFilter; return render(); }
  if (d.assetKind) { assetFilter.kind = d.assetKind; return render(); }
  if (d.viewMode) { storeSet(`blackbox:view:${d.collection}`, d.viewMode); return render(); }
  if (d.fmt) return wrapSelection($("#chat-text"), d.fmt);
  if (d.removePending) {
    const f = chatPending.find((x) => x.id === d.removePending);
    if (f?.preview) URL.revokeObjectURL(f.preview);
    chatPending = chatPending.filter((x) => x !== f);
    return render();
  }
  if (d.sendGif) { const a = assets.find((x) => x.id === d.sendGif); if (a) sendGif(a); return; }
  if (d.removeTag) {
    const hidden = $("#set-tags");
    const tags = splitList(hidden.value).filter((t) => t !== d.removeTag);
    hidden.value = tags.join(", ");
    drafts["set-tags"] = hidden.value;
    $("#tag-box").querySelectorAll(".tag-chip").forEach((c) => c.remove());
    $("#tag-entry").insertAdjacentHTML("beforebegin", tagChips(tags));
    return;
  }
  if (d.removeRelease !== undefined) return updateRelease((r) => r.items.splice(+d.removeRelease, 1));
  if (d.editMsg) { editingMsg = d.editMsg; delete drafts["msg-edit-text"]; render(); const t = $("#msg-edit-text"); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } return; }
  if (d.deleteMsg) {
    if (!(await ask({ title: "Delete this message?", ok: "Delete", danger: true }))) return;
    return act(() => msgCol().doc(d.deleteMsg).delete());
  }
  if (d.cancelInvite) return act(() => updateProject({ invitedEmails: FV().arrayRemove(d.cancelInvite) }), "Invitation cancelled");
  if (d.removeMember) {
    const name = memberName(d.removeMember);
    if (!(await ask({ title: `Remove ${name}?`, text: "They lose access to this project.", ok: "Remove", danger: true }))) return;
    if (await act(() => updateProject({
      memberIds: FV().arrayRemove(d.removeMember),
      [`members.${d.removeMember}`]: FV().delete(),
      [`roles.${d.removeMember}`]: FV().delete(),
    }), `${name} removed`)) log("member.remove", "removed", name, "Team");
    return;
  }
  if (d.join) {
    const id = d.join;
    const ok = await act(() => projectsCol().doc(id).update({
      memberIds: FV().arrayUnion(user.uid),
      [`members.${user.uid}`]: { name: storedName(), email: "" },
    }), "You joined the project");
    if (ok) log("member.join", "joined the project", "", "Team");
    return;
  }
  if (d.accept) {
    const m = me();
    const id = d.accept;
    // Open the project right away (it shows before the server confirms), so a later confirmation
    // never pulls the person back from a page they moved to.
    const from = location.hash;
    storeSet("blackbox:project", id);
    location.hash = "#overview";
    const ok = await act(() => projectsCol().doc(id).update({
      memberIds: FV().arrayUnion(m.uid),
      [`members.${m.uid}`]: { name: m.name, email: m.email },
      invitedEmails: FV().arrayRemove(m.email),
    }), "Welcome to the team");
    if (!ok) { location.hash = from || "#overview"; return; }
    if (currentId !== id) {
      if (projects[id]) selectProject(id);
      else currentId = id; // selected by the projects listener
    }
    await act(() => projectsCol().doc(id).collection("activity").add({ uid: m.uid, name: m.name, type: "member.join", verb: "joined the project", target: "", where: "Team", detail: "", changes: [], at: Date.now() }));
    return;
  }
  if (d.decline) return act(() => projectsCol().doc(d.decline).update({ invitedEmails: FV().arrayRemove(me().email) }), "Invitation declined");
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!user) return;
  if (t.dataset.releaseItem !== undefined) {
    if (!can("edit")) { t.checked = !t.checked; return; }
    const i = +t.dataset.releaseItem;
    const checked = t.checked;
    const label = project().release.items[i]?.label;
    const ok = await updateRelease((r) => { r.items[i].done = checked; });
    if (ok) log("release.check", checked ? "checked off" : "unchecked", label, project()?.release?.name || "Release");
    return;
  }
  if (t.id === "act-who") { activityFilter.who = t.value; return render(); }
  if (t.id === "channel-select") { location.hash = `#chat.${t.value}`; return; }
  if (t.dataset.roleFor) return setRole(t.dataset.roleFor, t.value);
  if (t.id === "asset-upload-kind") return storeSet("blackbox:asset-kind", t.value);
});

// One file picker for the whole app. It lives outside the re-rendered view, so a file chosen while
// a teammate's change re-renders the page is never lost.
const PICK_ACCEPT = { chat: () => "", asset: () => (ARTIFACT ? "" : "image/*"), gif: () => "image/gif" };
const PICK_MULTI = new Set(["chat", "asset", "items"]);
let pickTarget = null;
function pickFiles(el) {
  const target = el.dataset.pick;
  const input = $("#file-picker");
  input.accept = (PICK_ACCEPT[target] || (() => "image/*"))();
  input.multiple = PICK_MULTI.has(target);
  input.value = "";
  pickTarget = { target, collection: el.dataset.collection, el };
  input.click();
}
$("#file-picker").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length && pickTarget) handleFiles(pickTarget.target, files, pickTarget);
});

// Files from the picker or a drop zone, by destination.
async function handleFiles(target, files, opts = {}) {
  if (!user) return;
  const need = FILE_TARGETS[target] ? FILE_TARGET_PERMS[target] || "edit" : target === "chat" ? "chat" : /icon|thumbnail|update-cover/.test(target) ? "manage" : target === "avatar" ? null : "edit";
  if (need && !can(need)) return toast("Your role in this project can't do that.", true);
  if (FILE_TARGETS[target]) return FILE_TARGETS[target](files, opts);
  if (target === "chat") return addChatFiles(files);
  if (target === "asset" || target === "assets") return uploadAssets(files, $("#asset-upload-kind")?.value || "image");
  if (target === "items") return addItemsFromFiles(opts.collection, files);
  if (target === "item-image") return setItemFile(files[0]);
  if (target === "icon" || target === "brand-icon") return uploadBranding("icon", files[0]);
  if (target === "thumbnail" || target === "brand-thumbnail") return uploadBranding("thumbnail", files[0]);
  if (target === "avatar") {
    const up = await act(() => storeFile(files[0], "avatar"));
    if (up) saveProfile({ avatar: up.url }, "Photo updated");
  }
  if (target === "gif") {
    const gif = files[0];
    if (!isGif(gif)) return toast("Choose a .gif file.", true);
    gifOpen = false;
    const [a] = await uploadAssets([gif], "gif");
    if (a) sendGif(a);
  }
}

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "chat-text") { autoGrow(t); updateMentionPicker(t); }
  if (t.id === "item-search") { itemQuery = t.value; render(); }
  if (t.id === "asset-search") { assetFilter.q = t.value; render(); }
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.id === "chat-text") {
    if (mentionKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); wrapSelection(t, "**"); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") { e.preventDefault(); wrapSelection(t, "*"); }
  }
  if (t.id === "msg-edit-text") {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveMessageEdit(t.form.dataset.msg, t.value); }
    if (e.key === "Escape") { e.preventDefault(); editingMsg = null; delete drafts["msg-edit-text"]; render(); }
  }
  if (t.id === "tag-entry" && (e.key === "Enter" || e.key === ",")) {
    e.preventDefault();
    const v = t.value.trim().replace(/,/g, "");
    if (!v) return;
    const hidden = $("#set-tags");
    const tags = splitList(hidden.value);
    if (!tags.includes(v)) tags.push(v);
    hidden.value = tags.join(", ");
    drafts["set-tags"] = hidden.value;
    t.value = "";
    delete drafts["tag-entry"];
    $("#tag-box").querySelectorAll(".tag-chip").forEach((c) => c.remove());
    t.insertAdjacentHTML("beforebegin", tagChips(tags));
  }
});

document.addEventListener("paste", (e) => {
  if (e.target.id !== "chat-text") return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addChatFiles(files); }
});

document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (!f.dataset.form || !user) return;
  e.preventDefault();
  const val = (name) => (f.elements[name]?.value || "").trim();
  const type = f.dataset.form;

  if (type === "chat") return sendChat();
  if (type === "edit-msg") return saveMessageEdit(f.dataset.msg, $("#msg-edit-text").value);
  if (type === "release-item" && can("edit")) {
    const label = val("label");
    if (!label) return;
    f.reset();
    clearDrafts(f);
    if (await updateRelease((r) => r.items.push({ label, done: false }))) log("release.update", "added to the release", label, project()?.release?.name || "Release");
  }
  if (type === "invite") {
    const email = val("email").toLowerCase();
    const p = project();
    if (!EMAIL_RE.test(email)) return toast("Enter a valid email address.", true);
    if (Object.values(p.members || {}).some((m) => m.email === email)) return toast("This person is already in the team.", true);
    if ((p.invitedEmails || []).includes(email)) return toast("This email is already invited.", true);
    f.reset();
    clearDrafts(f);
    if (await act(() => updateProject({ invitedEmails: FV().arrayUnion(email) }), `Invitation sent to ${email}`)) log("member.invite", "invited", email, "Team");
  }
  if (type === "project") {
    const p = project();
    const name = val("name");
    if (!name) return toast("The project needs a name.", true);
    const platforms = [...[...f.querySelectorAll("input[name=plat]:checked")].map((x) => PLATFORMS[x.value].label), ...splitList(val("customPlatforms"))];
    const next = { name, description: val("description"), platforms, tags: splitList(val("tags")) };
    const changes = [];
    if (next.name !== p.name) changes.push({ field: "Name", from: p.name, to: next.name });
    if (next.description !== (p.description || "")) changes.push({ field: "Description", from: p.description || "", to: next.description });
    if (next.platforms.join(", ") !== (p.platforms || []).join(", ")) changes.push({ field: "Platforms", from: (p.platforms || []).join(", "), to: next.platforms.join(", ") });
    if (next.tags.join(", ") !== (p.tags || []).join(", ")) changes.push({ field: "Tags", from: (p.tags || []).join(", "), to: next.tags.join(", ") });
    if (!changes.length) return toast("Nothing to save.");
    if (await act(() => updateProject(next), "Project saved")) {
      clearDrafts(f);
      log("project.settings", "updated the project settings", "", "Settings", { changes });
      render();
    }
  }
  if (type === "profile") {
    const email = val("email");
    if (email && !EMAIL_RE.test(email)) return toast("Enter a valid contact email, or leave it empty.", true);
    if (await saveProfile({ name: val("name"), title: val("title"), email })) { clearDrafts(f); render(); }
  }
  if (type === "change-email") {
    const email = val("email").toLowerCase();
    if (!EMAIL_RE.test(email)) return toast("Enter a valid email address.", true);
    const ok = await act(async () => {
      await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, f.elements.password.value));
      await user.verifyBeforeUpdateEmail(email);
    }, `Confirmation sent to ${email}`);
    if (ok) { f.reset(); clearDrafts(f); }
  }
  if (type === "change-password") {
    const ok = await act(async () => {
      await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, f.elements.current.value));
      await user.updatePassword(f.elements.next.value);
    }, "Password changed");
    if (ok) { f.reset(); clearDrafts(f); }
  }
});

setupDropZones((zone, files, el) => handleFiles(zone, files, { collection: el.dataset.collection, el }));

$("#project-select").addEventListener("change", (e) => {
  selectProject(e.target.value);
  location.hash = "#overview";
});

function setMenu(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").hidden = !open;
}
$("#menu-btn").addEventListener("click", () => setMenu(!$("#sidebar").classList.contains("open")));
$("#scrim").addEventListener("click", () => setMenu(false));
let lastView = route().name;
// Pages render straight away and animate in with CSS (the browser's View Transitions would swallow
// clicks made during the animation).
let viewTransition = false;
function navigateRender(after) {
  render();
  after?.();
}
window.addEventListener("hashchange", () => {
  setMenu(false);
  if (route().name !== lastView) {
    taskFilter = { status: "all", owner: "all" };
    itemQuery = "";
    gifOpen = false;
    editingMsg = null;
  }
  lastView = route().name;
  closeMentionPicker();
  notifOpen = false;
  if (route().name === "chat" && project()) listenChannel(channelsOf().some((c) => c.id === route().arg) ? route().arg : "general");
  navigateRender(() => { if (route().name === "chat") scrollChatDown(); });
});

/* ---------- Auth screens ---------- */
function showScreen(id) {
  for (const s of ["boot-screen", "setup-screen", "auth-screen", "verify-screen", "app"]) $(`#${s}`).hidden = s !== id;
}

let authMode = "signin";
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("[data-auth-mode]").forEach((b) => b.classList.toggle("on", b.dataset.authMode === mode));
  $("#auth-name-row").hidden = mode !== "signup";
  $("#auth-submit").textContent = mode === "signup" ? "Create account" : "Sign in";
  $("#auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("#forgot-btn").hidden = mode === "signup";
  $("#auth-error").hidden = true;
}
function authError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = !msg;
}

document.querySelectorAll("[data-auth-mode]").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.authMode)));

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const name = $("#auth-name").value.trim();
  if (!EMAIL_RE.test(email)) return authError("#auth-error", "Enter a valid email address.");
  if (authMode === "signup" && !name) return authError("#auth-error", "Choose a display name.");
  const btn = $("#auth-submit");
  btn.disabled = true;
  try {
    if (authMode === "signup") {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      await cred.user.updateProfile({ displayName: name });
      await cred.user.sendEmailVerification();
      onAuth(cred.user);
    } else {
      await auth.signInWithEmailAndPassword(email, password);
    }
    authError("#auth-error", "");
  } catch (err) {
    console.error("BLACKBOX: auth", err);
    authError("#auth-error", friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

// Google sign-in: a popup on computers, a full-page redirect on phones and in the installed app.
$("#google-btn").addEventListener("click", async () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    if (isStandalone() || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) await auth.signInWithRedirect(provider);
    else await auth.signInWithPopup(provider);
    authError("#auth-error", "");
  } catch (err) {
    if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
    console.error("BLACKBOX: google sign-in", err);
    authError("#auth-error", friendlyError(err));
  }
});

$("#forgot-btn").addEventListener("click", async () => {
  const email = $("#auth-email").value.trim();
  if (!EMAIL_RE.test(email)) return authError("#auth-error", "Type your email above first, then press Forgot password.");
  try {
    await auth.sendPasswordResetEmail(email);
    authError("#auth-error", "");
    toast(`Password reset email sent to ${email}`);
  } catch (err) {
    authError("#auth-error", friendlyError(err));
  }
});

$("#verify-continue").addEventListener("click", async () => {
  try {
    await auth.currentUser.reload();
    if (!auth.currentUser.emailVerified) return authError("#verify-error", "Your email isn't confirmed yet. Open the link in the email we sent, then try again.");
    await auth.currentUser.getIdToken(true); // refresh the token so the database sees the verified email
    authError("#verify-error", "");
    onAuth(auth.currentUser);
  } catch (err) {
    authError("#verify-error", friendlyError(err));
  }
});
$("#verify-resend").addEventListener("click", async () => {
  try {
    await auth.currentUser.sendEmailVerification();
    toast("Confirmation email sent again");
  } catch (err) {
    authError("#verify-error", friendlyError(err));
  }
});
$("#verify-signout").addEventListener("click", () => auth.signOut());

function onAuth(u) {
  unsubProjects.forEach((f) => f());
  unsubCurrent.forEach((f) => f());
  unsubActivity?.();
  profileUnsubs.forEach((f) => f());
  profileUnsubs.clear();
  stopNotifications();
  closeMentionPicker();
  unsubUpdates?.(); unsubUpdates = null;
  unsubMessages?.(); unsubMessages = null;
  channelUnsubs.forEach((f) => f()); channelUnsubs.clear();
  outbox = [];
  clearAllDrafts();
  unsubProjects = []; unsubCurrent = []; unsubActivity = null;
  PROJECT_RESETS.forEach((fn) => fn());
  projects = {}; invites = []; profiles = {}; currentId = null; subscribedId = null;
  tasks = []; activity = []; messages = []; items = []; assets = [];
  user = null;
  if (!u && ARTIFACT) {
    $("#setup-title").textContent = "Sign in to use BLACKBOX";
    $("#setup-text").textContent = "Open this page while signed in to Claude. If someone sent you the link, ask them to share the page with your email.";
    return showScreen("setup-screen");
  }
  if (!u) {
    setAuthMode("signin");
    return showScreen("auth-screen");
  }
  if (!u.emailVerified) {
    $("#verify-email").textContent = u.email;
    authError("#verify-error", "");
    return showScreen("verify-screen");
  }
  user = u;
  showScreen("app");
  $("#view").innerHTML = '<div class="empty">Loading your projects…</div>';
  renderSidebar();
  setSaveState();
  watchProjects();
}
