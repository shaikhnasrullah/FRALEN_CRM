// Tiny in-memory Firestore (paths, get/set/update, transactions) for unit tests.
function makeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  const snap = (path) => ({ exists: store.has(path), data: () => (store.has(path) ? structuredClone(store.get(path)) : undefined) });
  const docRef = (path) => ({
    path,
    get: async () => snap(path),
    set: async (d) => { store.set(path, structuredClone(d)); },
    update: async (d) => {
      if (!store.has(path)) throw new Error("NOT_FOUND " + path);
      store.set(path, { ...store.get(path), ...structuredClone(d) });
    },
    collection: (name) => collRef(path + "/" + name),
  });
  const collRef = (path) => ({ doc: (id) => docRef(path + "/" + id) });
  return {
    store,
    collection: (name) => collRef(name),
    doc: (path) => docRef(path),
    runTransaction: async (fn) => {
      const pending = [];
      const tx = {
        get: async (ref) => ref.get(),
        set: (ref, d) => pending.push(() => ref.set(d)),
        update: (ref, d) => pending.push(() => ref.update(d)),
      };
      const result = await fn(tx);
      for (const w of pending) await w();
      return result;
    },
  };
}
module.exports = { makeDb };
