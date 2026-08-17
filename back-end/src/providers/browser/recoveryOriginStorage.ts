/** Init script that restores localStorage/indexedDB origins onto the recovery tab. */
export function recoveryOriginStorageScript(storageState: Record<string, unknown>): string {
  const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
  return `
(() => {
  const originStates = ${JSON.stringify(origins)
    .replaceAll('</', '<\\/')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')};
  const completionKey = '__naviRecoveryStorageRestoredV1';
  const RESTORE_DEADLINE_MS = 8_000;
  const OVERALL_RESTORE_DEADLINE_MS = 12_000;
  let restorePromise;
  const restoreCurrentOrigin = async () => {
    const state = originStates.find((entry) => entry.origin === location.origin);
    if (!state) return;
    try { if (sessionStorage.getItem(completionKey) === '1') return; } catch {}
    try {
      localStorage.clear();
      for (const item of state.localStorage || []) localStorage.setItem(item.name, item.value);
    } catch {}
    const overallDeadline = Date.now() + OVERALL_RESTORE_DEADLINE_MS;
    let restoredAllDatabases = true;
    for (const database of state.indexedDB || []) {
      if (Date.now() >= overallDeadline) {
        restoredAllDatabases = false;
        break;
      }
      const remainingMs = Math.max(0, overallDeadline - Date.now());
      const entryDeadlineMs = Math.min(RESTORE_DEADLINE_MS, remainingMs);
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(finish, entryDeadlineMs);
        let request;
        try {
          request = indexedDB.open(database.name, database.version);
        } catch {
          clearTimeout(timer);
          finish();
          return;
        }
        request.onblocked = () => { clearTimeout(timer); finish(); };
        request.onupgradeneeded = () => {
          try {
            const db = request.result;
            for (const store of database.stores || []) {
              if (!db.objectStoreNames.contains(store.name)) {
                db.createObjectStore(store.name, {
                  keyPath: store.keyPath === undefined ? null : store.keyPath,
                  autoIncrement: Boolean(store.autoIncrement),
                });
              }
            }
          } catch {}
        };
        request.onerror = () => { clearTimeout(timer); finish(); };
        request.onsuccess = () => {
          try {
            const db = request.result;
            const storeNames = (database.stores || [])
              .map((store) => store.name)
              .filter((name) => db.objectStoreNames.contains(name));
            if (storeNames.length === 0) {
              db.close();
              clearTimeout(timer);
              finish();
              return;
            }
            const transaction = db.transaction(storeNames, 'readwrite');
            for (const storeState of database.stores || []) {
              if (!storeNames.includes(storeState.name)) continue;
              const store = transaction.objectStore(storeState.name);
              try { store.clear(); } catch {}
              for (const record of storeState.records || []) {
                try {
                  if (store.keyPath === null && Object.hasOwn(record, 'key')) {
                    store.put(record.value, record.key);
                  } else {
                    store.put(record.value);
                  }
                } catch {}
              }
            }
            transaction.oncomplete = () => { db.close(); clearTimeout(timer); finish(); };
            transaction.onerror = () => { try { db.close(); } catch {} clearTimeout(timer); finish(); };
            transaction.onabort = () => { try { db.close(); } catch {} clearTimeout(timer); finish(); };
          } catch {
            clearTimeout(timer);
            finish();
          }
        };
      });
    }
    // Only mark complete after a full restore. A truncated IndexedDB pass must
    // retry on the next candidate probe rather than pretend storage is ready.
    if (restoredAllDatabases) {
      try { sessionStorage.setItem(completionKey, '1'); } catch {}
    }
  };
  globalThis.__naviRestoreRecoveryStorage = () => {
    // Absorb rejections into the memoized promise itself so a later await
    // cannot discard a recovery candidate over best-effort storage noise.
    restorePromise ||= restoreCurrentOrigin().catch(() => undefined);
    return restorePromise;
  };
  void globalThis.__naviRestoreRecoveryStorage();
})();`;
}
