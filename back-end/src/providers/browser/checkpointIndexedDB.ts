/** Frame-scoped IndexedDB transfer; public web APIs keep the native storage partition.
 * Schema collection follows Playwright's packages/injected/src/storageScript.ts.
 * The private artifact uses an explicit graph encoding, never executable saved code.
 */
import type { CDPSession, Frame } from 'playwright';
import { createLogger } from '../logger';

const log = createLogger('BrowserCheckpoint');
import type { CapturePages } from './checkpointCapture';

const transfer = String.raw`
async ({ mode, saved }) => {
  const typed = {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };
  const request = (value) =>
    new Promise((resolve, reject) => {
      value.onsuccess = () => resolve(value.result);
      value.onerror = () => reject(value.error);
      value.onblocked = () =>
        reject(new Error("Checkpoint IndexedDB request blocked"));
    });
  const done = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () =>
        reject(
          tx.error || new Error("Checkpoint IndexedDB transaction aborted"),
        );
    });
  const encoder = () => {
    const nodes = [],
      seen = new Map();
    const visit = async (value) => {
      const object = value !== null && typeof value === "object";
      if (object && seen.has(value)) return seen.get(value);
      const id = nodes.length;
      nodes.push(null);
      if (object) seen.set(value, id);
      const tag = Object.prototype.toString.call(value).slice(8, -1);
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
      )
        nodes[id] = ["scalar", value];
      else if (value === undefined) nodes[id] = ["undefined"];
      else if (typeof value === "number")
        nodes[id] = ["number", Object.is(value, -0) ? "-0" : String(value)];
      else if (typeof value === "bigint") nodes[id] = ["bigint", String(value)];
      else if (Array.isArray(value)) {
        nodes[id] = ["array", value.length, []];
        for (const key of Object.keys(value))
          nodes[id][2].push([key, await visit(value[key])]);
      } else if (tag === "Object") {
        nodes[id] = ["object", []];
        for (const key of Object.keys(value))
          nodes[id][1].push([key, await visit(value[key])]);
      } else if (tag === "Date") nodes[id] = ["date", String(value.getTime())];
      else if (tag === "RegExp")
        nodes[id] = ["regexp", value.source, value.flags];
      else if (tag === "Map") {
        nodes[id] = ["map", []];
        for (const [key, entry] of value)
          nodes[id][1].push([await visit(key), await visit(entry)]);
      } else if (tag === "Set") {
        nodes[id] = ["set", []];
        for (const entry of value) nodes[id][1].push(await visit(entry));
      } else if (tag === "ArrayBuffer")
        nodes[id] = ["buffer", Array.from(new Uint8Array(value))];
      else if (tag === "DataView" || Object.hasOwn(typed, tag))
        nodes[id] = [
          "view",
          tag,
          await visit(value.buffer),
          value.byteOffset,
          tag === "DataView" ? value.byteLength : value.length,
        ];
      else if (tag === "Blob" || tag === "File")
        nodes[id] = [
          tag,
          Array.from(new Uint8Array(await value.arrayBuffer())),
          value.type,
          value.name,
          value.lastModified,
        ];
      else
        throw Object.assign(
          new Error("Unsupported checkpoint IndexedDB value type: " + tag),
          { unsupportedType: tag },
        );
      return id;
    };
    return {
      // Each record is its own structured clone. A host object that cannot
      // leave this browser (for example a non-extractable CryptoKey) omits only
      // its record and reports the type, instead of failing the checkpoint.
      record: async (value) => {
        if (value === null || typeof value !== "object") return undefined;
        const mark = nodes.length;
        try {
          await visit(value);
          return undefined;
        } catch (error) {
          if (!error?.unsupportedType) throw error;
          nodes.length = mark;
          for (const [object, id] of seen) if (id >= mark) seen.delete(object);
          return error.unsupportedType;
        }
      },
      finish: async (root) =>
        JSON.stringify({ version: 1, rootId: await visit(root), nodes }),
    };
  };
  const decode = (serialized) => {
    const graph = JSON.parse(serialized),
      values = new Map();
    if (graph.version !== 1 || !Array.isArray(graph.nodes))
      throw new Error("Invalid checkpoint IndexedDB graph");
    const visit = (id) => {
      if (values.has(id)) return values.get(id);
      const [tag, data, a, b, c] = graph.nodes[id];
      const keep = (value) => {
        values.set(id, value);
        return value;
      };
      switch (tag) {
        case "scalar":
          return keep(data);
        case "undefined":
          return keep(undefined);
        case "number":
          return keep(Number(data));
        case "bigint":
          return keep(BigInt(data));
        case "date":
          return keep(new Date(Number(data)));
        case "regexp":
          return keep(new RegExp(data, a));
        case "buffer":
          return keep(Uint8Array.from(data).buffer);
        case "Blob":
          return keep(new Blob([Uint8Array.from(data)], { type: a }));
        case "File":
          return keep(
            new File([Uint8Array.from(data)], b, { type: a, lastModified: c }),
          );
        case "view": {
          const buffer = visit(a);
          if (data === "DataView") return keep(new DataView(buffer, b, c));
          if (!Object.hasOwn(typed, data))
            throw new Error("Invalid checkpoint typed array");
          return keep(new typed[data](buffer, b, c));
        }
        case "array": {
          const value = keep(new Array(data));
          for (const [key, entry] of a)
            Object.defineProperty(value, key, {
              value: visit(entry),
              enumerable: true,
              writable: true,
              configurable: true,
            });
          return value;
        }
        case "object": {
          const value = keep({});
          for (const [key, entry] of data)
            Object.defineProperty(value, key, {
              value: visit(entry),
              enumerable: true,
              writable: true,
              configurable: true,
            });
          return value;
        }
        case "map": {
          const value = keep(new Map());
          for (const [key, entry] of data) value.set(visit(key), visit(entry));
          return value;
        }
        case "set": {
          const value = keep(new Set());
          for (const entry of data) value.add(visit(entry));
          return value;
        }
        default:
          throw new Error("Invalid checkpoint IndexedDB value tag");
      }
    };
    return visit(graph.rootId);
  };
  if (mode === "capture") {
    const databases = [];
    for (const info of await indexedDB.databases()) {
      if (typeof info.name !== "string" || !info.version)
        throw new Error("Checkpoint IndexedDB identity missing");
      const db = await request(indexedDB.open(info.name, info.version));
      try {
        const stores = [];
        if (db.objectStoreNames.length) {
          const tx = db.transaction(
              Array.from(db.objectStoreNames),
              "readonly",
            ),
            settled = done(tx);
          const reads = Array.from(db.objectStoreNames, (name) => {
            const store = tx.objectStore(name);
            const schema = {
              name,
              keyPath: store.keyPath,
              autoIncrement: store.autoIncrement,
              indexes: Array.from(store.indexNames, (name) => {
                const index = store.index(name);
                return {
                  name,
                  keyPath: index.keyPath,
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                };
              }),
            };
            return Promise.all([
              request(store.getAllKeys()),
              request(store.getAll()),
            ]).then(([keys, values]) => ({
              ...schema,
              records: keys.map((key, i) => ({ key, value: values[i] })),
            }));
          });
          stores.push(...(await Promise.all(reads)));
          await settled;
        }
        databases.push({ name: info.name, version: info.version, stores });
      } finally {
        db.close();
      }
    }
    const encoding = encoder(),
      omitted = [];
    for (const db of databases)
      for (const store of db.stores) {
        const kept = [],
          counts = new Map();
        for (const record of store.records) {
          const type = await encoding.record(record.value);
          if (type === undefined) kept.push(record);
          else counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        store.records = kept;
        for (const [type, count] of counts)
          omitted.push({ database: db.name, store: store.name, type, count });
      }
    return {
      data: await encoding.finish(databases),
      omitted,
      databaseCount: databases.length,
      autoStores: databases.flatMap((db) =>
        db.stores
          .filter((store) => store.autoIncrement)
          .map((store) => ({ database: db.name, store: store.name })),
      ),
    };
  }
  const envelope = JSON.parse(saved);
  if (envelope.version !== 1)
    throw new Error("Invalid checkpoint IndexedDB envelope");
  const databases = decode(envelope.data);
  for (const info of databases) {
    await request(indexedDB.deleteDatabase(info.name));
    const opening = indexedDB.open(info.name, info.version);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      for (const store of info.stores) {
        const target = db.createObjectStore(store.name, {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
        });
        for (const index of store.indexes)
          target.createIndex(index.name, index.keyPath, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          });
      }
    };
    const db = await request(opening);
    try {
      if (!info.stores.length) continue;
      const tx = db.transaction(
          info.stores.map((store) => store.name),
          "readwrite",
        ),
        settled = done(tx);
      for (const store of info.stores) {
        const target = tx.objectStore(store.name);
        for (const record of store.records) {
          if (store.keyPath === null) target.add(record.value, record.key);
          else target.add(record.value);
        }
        const next = envelope.generators.find(
          (entry) => entry.database === info.name && entry.store === store.name,
        )?.value;
        if (
          next > 1 &&
          !store.records.some((record) => record.key === next - 1)
        ) {
          if (store.keyPath === null) target.add(null, next - 1);
          else {
            const value = {},
              path = store.keyPath.split(".");
            let owner = value;
            for (const part of path.slice(0, -1)) owner = owner[part] = {};
            owner[path[path.length - 1]] = next - 1;
            target.add(value);
          }
          target.delete(next - 1);
        }
      }
      await settled;
    } finally {
      db.close();
    }
  }
}
`;

type AutoStore = { database: string; store: string };
type Generator = AutoStore & { value: number };
type Omitted = AutoStore & { type: string; count: number };

/** Use the actual frame's native storage key, including its top-level-site partition. */
async function storageSession(
  frame: Frame,
  resources?: CapturePages
): Promise<{ client: CDPSession; storageKey: string }> {
  const context = frame.page().context();
  const create = (target: Frame | ReturnType<Frame['page']>) =>
    resources
      ? resources.session(() => context.newCDPSession(target))
      : context.newCDPSession(target);
  const detach = (client: CDPSession) => (resources ? resources.detach(client) : client.detach());
  let client = await create(frame.page());
  try {
    const { frameTree } = await client.send('Page.getFrameTree');
    const find = (node: typeof frameTree): string | undefined => {
      if (node.frame.url === frame.url()) return node.frame.id;
      for (const child of node.childFrames ?? []) {
        const id = find(child);
        if (id) return id;
      }
    };
    let id = find(frameTree);
    if (!id) {
      await detach(client);
      client = await create(frame);
      id = (await client.send('Page.getFrameTree')).frameTree.frame.id;
    }
    const { storageKey } = await client.send('Storage.getStorageKeyForFrame', { frameId: id });
    return { client, storageKey };
  } catch (error) {
    await detach(client);
    throw error;
  }
}

export async function captureFrameIndexedDB(
  frame: Frame,
  resources?: CapturePages
): Promise<string | undefined> {
  const snapshot = await frame.evaluate<{
    data: string;
    omitted: Omitted[];
    databaseCount: number;
    autoStores: AutoStore[];
  }>(`(${transfer})(${JSON.stringify({ mode: 'capture' })})`);
  if (!snapshot.databaseCount) return undefined;
  if (snapshot.omitted.length)
    log.warn('Browser checkpoint omitted non-transferable IndexedDB records', {
      origin: new URL(frame.url()).origin,
      omitted: snapshot.omitted,
    });
  const generators: Generator[] = [];
  if (snapshot.autoStores.length) {
    const { client, storageKey } = await storageSession(frame, resources);
    try {
      for (const store of snapshot.autoStores) {
        const metadata = await client.send('IndexedDB.getMetadata', {
          storageKey,
          databaseName: store.database,
          objectStoreName: store.store,
        });
        generators.push({ ...store, value: metadata.keyGeneratorValue });
      }
    } finally {
      if (resources) await resources.detach(client);
      else await client.detach();
    }
  }
  return JSON.stringify({
    version: 1,
    data: snapshot.data,
    generators,
    ...(snapshot.omitted.length ? { omitted: snapshot.omitted } : {}),
  });
}

export async function restoreFrameIndexedDB(frame: Frame, saved: string): Promise<void> {
  await frame.evaluate(`(${transfer})(${JSON.stringify({ mode: 'restore', saved })})`);
}
