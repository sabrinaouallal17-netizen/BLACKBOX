// Test double for the claude.ai artifact runtime (`db` and `user`), used by tests/artifact-e2e.js.
// Data lives in localStorage so several pages of one browser context share it, like viewers of one
// artifact. The viewer is chosen with ?u=<id> in the page URL; MOCK_PEOPLE lists who exists.
(() => {
  const PEOPLE = {
    alice: { name: "Alice", email: "alice@example.com", owner: true, write: true },
    bob: { name: "Bob", email: "bob@example.com", owner: false, write: true },
    vera: { name: "Vera", email: "vera@example.com", owner: false, write: false },
  };
  const who = new URLSearchParams(location.search).get("u");
  const viewer = PEOPLE[who] ? { id: "u_" + who, ...PEOPLE[who] } : null;
  const KEY = "mock:db";
  const load = () => JSON.parse(localStorage.getItem(KEY) || "{}");
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());
  window.addEventListener("storage", (e) => { if (e.key === KEY) notify(); });
  const deny = () => Promise.reject({ code: "invalid_argument", message: "write not allowed" });
  const write = (fn) => {
    if (!viewer || !viewer.write) return deny();
    const all = load(); fn(all); localStorage.setItem(KEY, JSON.stringify(all));
    setTimeout(notify, 0);
    return Promise.resolve();
  };
  const segs = (p) => p.split("/");
  const freeze = (o) => JSON.parse(JSON.stringify(o));
  let n = 0;
  const newId = () => Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = { fromCache: false, hasPendingWrites: false };

  function docRef(path) {
    if (segs(path).length % 2) throw new TypeError("document path needs an even number of segments: " + path);
    const snap = () => { const d = load()[path]; return { id: segs(path).at(-1), exists: !!d, data: () => (d ? freeze(d) : undefined), metadata: meta }; };
    return {
      id: segs(path).at(-1), path,
      get: async () => snap(),
      set: (data) => write((all) => { all[path] = freeze(data); }),
      update: (data) => load()[path] ? write((all) => { all[path] = { ...all[path], ...freeze(data) }; }) : deny(),
      delete: () => write((all) => { delete all[path]; }),
      collection: (p) => colRef(path + "/" + p),
      onSnapshot(next) { const fn = () => next(snap()); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
    };
  }
  function query(path, filters = [], order = null, lim = null, ordered = false) {
    const run = () => {
      const all = load();
      let docs = Object.keys(all).filter((k) => k.startsWith(path + "/") && segs(k).length === segs(path).length + 1)
        .map((k) => ({ id: segs(k).at(-1), body: all[k] }));
      for (const [f, op, v] of filters) docs = docs.filter((d) => op === "==" ? d.body[f] === v : op === "array-contains" ? (d.body[f] || []).includes(v) : true);
      if (order) { const [f, dir] = order; docs.sort((a, b) => ((a.body[f] > b.body[f]) - (a.body[f] < b.body[f])) * (dir === "desc" ? -1 : 1)); }
      else docs.sort((a, b) => (a.id > b.id) - (a.id < b.id));
      if (lim) docs = docs.slice(0, lim);
      const out = docs.map((d) => ({ id: d.id, exists: true, data: () => freeze(d.body), metadata: meta }));
      return { docs: out, size: out.length, empty: !out.length, docChanges: () => [], metadata: meta };
    };
    return {
      where: (f, op, v) => query(path, [...filters, [f, op, v]], order, lim, ordered),
      orderBy: (f, dir = "asc") => { if (ordered) throw new Error("mock: only one orderBy"); return query(path, filters, [f, dir], lim, true); },
      limit: (k) => query(path, filters, order, k, ordered),
      get: async () => run(),
      onSnapshot(next) { const fn = () => next(run()); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
    };
  }
  function colRef(path) {
    if (segs(path).length % 2 === 0) throw new TypeError("collection path needs an odd number of segments: " + path);
    return Object.assign(query(path), {
      path,
      doc: (id) => docRef(path + "/" + (id || newId())),
      add: async (data) => { const r = docRef(path + "/" + newId()); await r.set(data); return r; },
    });
  }
  const db = viewer ? { doc: docRef, collection: colRef } : null;
  const user = {
    isOwner: async () => !!viewer?.owner,
    canEdit: async () => !!viewer?.owner,
    can: async (k) => (k === "data.write" ? !!viewer?.write : null),
    me: async () => ({ id: viewer?.id || null, name: viewer?.name || "", email: viewer?.email || null, avatarUrl: "", color: "#888", isOwner: !!viewer?.owner, canEdit: !!viewer?.owner }),
    id: async () => viewer?.id || null,
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => {
      const p = PEOPLE[String(id).replace(/^u_/, "")];
      return [id, { id, name: p?.name || "", email: p?.email || null, avatarUrl: "", color: "#888", isMe: id === viewer?.id, guest: false }];
    })),
  };
  // File storage: bytes go to the test server (Playwright routes), which serves them at /_blob/<id>.
  const assets = viewer?.write ? {
    upload: async (blob) => {
      const id = "a" + newId();
      await fetch("/__mock_upload/" + id, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
      return { id, url: "/_blob/" + id, sizeBytes: blob.size, contentType: blob.type };
    },
  } : null;
  // Downloads: records what the page offered (the real viewer asks the person to confirm).
  window.__downloads = [];
  const downloads = { save: async ({ filename, data }) => { window.__downloads.push({ filename, size: data.size ?? data.length }); return { status: "saved" }; } };
  const caps = { db, user: viewer ? user : null, assets, downloads };
  window.claude = { use: async (name) => caps[name] ?? null };
})();
