'use strict';
// Hands a GPX dropped on one page over to another (the visor → Upload Trail). A page cannot pass a File through a
// navigation, so it is kept for a moment in IndexedDB and taken (once) by the next page.
(function () {
  const DB = 'gpx-drop', STORE = 'files', KEY = 'pending';
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('IndexedDB no disponible'));
  });
  const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); res(req && req.result); };
    tx.onerror = tx.onabort = () => { db.close(); rej(tx.error || new Error('IndexedDB')); };
  }));

  window.gpxDrop = {
    /** Keeps the file for the next page. */
    stash: file => file.text().then(text => run('readwrite', s => s.put({ name: file.name, text, at: Date.now() }, KEY))),
    /** The kept file as a File (and forgets it), or null. A file older than 5 minutes is ignored. */
    take: () => run('readwrite', s => { const g = s.get(KEY); g.onsuccess = () => s.delete(KEY); return g; })
      .then(v => (v && Date.now() - v.at < 5 * 60 * 1000 ? new File([v.text], v.name, { type: 'application/gpx+xml' }) : null))
      .catch(() => null),
  };
})();
