// BLACKBOX artifact backend: the small part of the Firebase API that app.js uses, implemented on the
// claude.ai artifact runtime (`db` for shared data, `user` for who is viewing). With it, app.js runs
// unchanged inside a published Artifact. Accounts are claude.ai accounts; the Share menu decides who gets in.
"use strict";
window.BLACKBOX_ARTIFACT = true;

(function () {
  const runtime = (async () => {
    const use = (name) => (window.claude?.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));
    const [db, user, assets, downloads] = await Promise.all([use("db"), use("user"), use("assets"), use("downloads")]);
    return { db, user, assets, downloads };
  })();
  let rt = { db: null, user: null, assets: null, downloads: null };

  /* ---------- Names, resolved from accounts at render time ---------- */
  const names = {};
  const emails = {};
  const requested = new Set();
  let queued = new Set();
  let onNames = () => {};
  window.BB = {
    canWrite: null,
    // Stores a file in the artifact's file storage. The id is the durable pointer; it serves at /_blob/<id>.
    // Offers a file to the viewer, who confirms the save.
    async download(blob, filename) {
      if (!rt.downloads) throw Object.assign(new Error("Downloads aren't available."), { code: "unavailable" });
      return rt.downloads.save({ filename, data: blob });
    },
    async upload(blob) {
      if (!rt.assets) throw Object.assign(new Error("Uploads aren't available."), { code: "no_uploads" });
      const up = await rt.assets.upload(blob);
      return { url: "/_blob/" + up.id, id: up.id, sizeBytes: up.sizeBytes };
    },
    name: (id) => names[id] || "",
    email: (id) => emails[id] || "",
    onNames(fn) { onNames = fn; },
    want(ids) {
      for (const id of ids) if (id && !requested.has(id)) { requested.add(id); queued.add(id); }
      if (!queued.size || !rt.user) return;
      const batch = [...queued];
      queued = new Set();
      rt.user.profiles(batch).then((ps) => {
        let changed = false;
        for (const id of batch) {
          const p = ps[id] || {};
          if ((p.name || "") !== (names[id] || "")) { names[id] = p.name || ""; changed = true; }
          if (p.email) emails[id] = p.email;
        }
        if (changed) onNames();
      });
    },
  };

  /* ---------- FieldValue sentinels and update() semantics ---------- */
  class Sentinel {
    constructor(op, values) { this.op = op; this.values = values; }
  }
  const FieldValue = {
    arrayUnion: (...v) => new Sentinel("union", v),
    arrayRemove: (...v) => new Sentinel("remove", v),
    delete: () => new Sentinel("delete"),
  };
  // Applies a Firebase-style update (dot paths and sentinels) to a document body.
  function applyUpdate(base, data) {
    const out = structuredClone(base);
    for (const [key, val] of Object.entries(data)) {
      const parts = key.split(".");
      let obj = out;
      for (const p of parts.slice(0, -1)) {
        if (typeof obj[p] !== "object" || obj[p] === null) obj[p] = {};
        obj = obj[p];
      }
      const last = parts[parts.length - 1];
      const arr = Array.isArray(obj[last]) ? obj[last] : [];
      if (!(val instanceof Sentinel)) obj[last] = val;
      else if (val.op === "delete") delete obj[last];
      else if (val.op === "union") obj[last] = [...arr, ...val.values.filter((v) => !arr.includes(v))];
      else if (val.op === "remove") obj[last] = arr.filter((v) => !val.values.includes(v));
    }
    return out;
  }
  const notFound = () => Object.assign(new Error("This item no longer exists."), { code: "not-found" });

  /* ---------- References and snapshots ---------- */
  function docSnap(s, ref) {
    return { id: s.id, exists: s.exists, data: () => s.data(), metadata: s.metadata, ref };
  }
  function querySnap(s, col, reverse) {
    const docs = s.docs.map((d) => docSnap(d, wrapDoc(col.doc(d.id))));
    if (reverse) docs.reverse();
    return { docs, size: docs.length, empty: !docs.length, metadata: s.metadata, forEach: (fn) => docs.forEach(fn) };
  }
  function wrapDoc(ref) {
    return {
      id: ref.id,
      path: ref.path,
      collection: (p) => wrapCol(ref.collection(p)),
      get: async () => docSnap(await ref.get(), wrapDoc(ref)),
      // set(data, { merge: true }) merges like Firestore; plain set replaces the document.
      set: async (data, opts) => {
        if (!opts?.merge) return ref.set(data);
        const s = await ref.get();
        return ref.set(applyUpdate(s.exists ? s.data() : {}, data));
      },
      // The store's update() merges nested objects and cannot remove keys, so updates are
      // read-modify-write of the whole document (last writer wins, like the rest of the store).
      update: async (data) => {
        const s = await ref.get();
        if (!s.exists) throw notFound();
        await ref.set(applyUpdate(s.data(), data));
      },
      delete: () => ref.delete(),
      onSnapshot: (next, error) => ref.onSnapshot((s) => next(docSnap(s, wrapDoc(ref))), error),
    };
  }
  // `pre` is the query before orderBy, kept so limitToLast can flip the order (one orderBy per query).
  function wrapQuery(col, q, opts = {}) {
    return {
      where: (f, op, v) => {
        const nq = q.where(f, op, v);
        return wrapQuery(col, nq, { ...opts, pre: opts.order ? opts.pre.where(f, op, v) : nq });
      },
      orderBy: (f, dir = "asc") => wrapQuery(col, q.orderBy(f, dir), { ...opts, pre: opts.pre || q, order: [f, dir] }),
      limit: (n) => wrapQuery(col, q.limit(n), opts),
      limitToLast: (n) => {
        if (!opts.order) throw new TypeError("limitToLast needs an orderBy first");
        const [f, dir] = opts.order;
        return wrapQuery(col, opts.pre.orderBy(f, dir === "asc" ? "desc" : "asc").limit(n), { ...opts, reverse: true });
      },
      get: async () => querySnap(await q.get(), col, opts.reverse),
      onSnapshot: (next, error) => q.onSnapshot((s) => next(querySnap(s, col, opts.reverse)), error),
    };
  }
  function wrapCol(col) {
    return Object.assign(wrapQuery(col, col, {}), {
      path: col.path,
      doc: (id) => wrapDoc(id ? col.doc(id) : col.doc()),
      add: async (data) => wrapDoc(await col.add(data)),
    });
  }

  const firestore = {
    collection: (p) => wrapCol(rt.db.collection(p)),
    batch() {
      const ops = [];
      return {
        update: (ref, data) => ops.push(() => ref.update(data)),
        set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
        delete: (ref) => ops.push(() => ref.delete()),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    useEmulator() {},
  };

  /* ---------- Auth: the claude.ai account viewing the page ---------- */
  const auth = {
    currentUser: null,
    onAuthStateChanged(cb) {
      runtime.then(async (r) => {
        rt = r;
        if (!r.db || !r.user) return cb(null);
        const me = await r.user.me();
        if (!me.id) return cb(null);
        window.BB.canWrite = await r.user.can("data.write");
        names[me.id] = me.name;
        requested.add(me.id);
        if (me.email) emails[me.id] = me.email;
        auth.currentUser = {
          uid: me.id,
          displayName: me.name,
          email: me.email || "",
          emailVerified: true,
          isOwner: me.isOwner,
          updateProfile: async () => {},
          reload: async () => {},
          getIdToken: async () => "",
        };
        cb(auth.currentUser);
      });
      return () => {};
    },
    signOut: async () => {},
    useEmulator() {},
  };

  window.firebase = {
    initializeApp() {},
    auth: () => auth,
    firestore: Object.assign(() => firestore, { FieldValue }),
  };
})();
