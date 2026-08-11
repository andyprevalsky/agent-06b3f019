/** Init script that restores localStorage/indexedDB origins onto the recovery tab. */
export function recoveryOriginStorageScript(storageState: Record<string, unknown>): string {
  const origins = Array.isArray(storageState.origins) ? storageState.origins : [];
  return `
(() => {
  const originStates = ${JSON.stringify(origins).replaceAll('</', '<\\/')};
  const completionKey = '__naviRecoveryStorageRestoredV1';
  let restorePromise;
  const restoreCurrentOrigin = async () => {
    const state = originStates.find((entry) => entry.origin === location.origin);
    if (!state) return;
    try { if (sessionStorage.getItem(completionKey) === '1') return; } catch {}
    localStorage.clear();
    for (const item of state.localStorage || []) localStorage.setItem(item.name, item.value);
    for (const database of state.indexedDB || []) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(database.name, database.version);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of database.stores || []) {
            if (!db.objectStoreNames.contains(store.name)) {
              db.createObjectStore(store.name, {
                keyPath: store.keyPath === undefined ? null : store.keyPath,
                autoIncrement: Boolean(store.autoIncrement),
              });
            }
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const storeNames = (database.stores || [])
            .map((store) => store.name)
            .filter((name) => db.objectStoreNames.contains(name));
          if (storeNames.length === 0) { db.close(); resolve(); return; }
          const transaction = db.transaction(storeNames, 'readwrite');
          for (const storeState of database.stores || []) {
            if (!storeNames.includes(storeState.name)) continue;
            const store = transaction.objectStore(storeState.name);
            store.clear();
            for (const record of storeState.records || []) {
              if (store.keyPath === null && Object.hasOwn(record, 'key')) {
                store.put(record.value, record.key);
              } else {
                store.put(record.value);
              }
            }
          }
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => { db.close(); reject(transaction.error); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
    }
    try { sessionStorage.setItem(completionKey, '1'); } catch {}
  };
  globalThis.__naviRestoreRecoveryStorage = () => {
    restorePromise ||= restoreCurrentOrigin();
    return restorePromise;
  };
  void globalThis.__naviRestoreRecoveryStorage().catch(() => undefined);
})();`;
}
