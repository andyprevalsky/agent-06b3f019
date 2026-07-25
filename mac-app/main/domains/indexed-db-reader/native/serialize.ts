/**
 * JSON serialization of decoded IndexedDB keys/values into the shape the app +
 * backend already expect (`IndexedDBRecord`). Non-JSON-native types (bigint,
 * bytes, Map, Set, non-finite numbers) are represented as tagged `{ __type }`
 * objects.
 */

import { bytesToHexKey, type IdbKey, type SerializedIdbKey } from './idb-coding';

/** Serialize a decoded IdbKey into the JSON-friendly `IndexedDBRecord.key` shape. */
export function serializeKey(key: IdbKey): SerializedIdbKey {
  const v = key.value;
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return bytesToHexKey(v);
  // Array key: flatten inner keys to strings/numbers.
  return v.map((inner) => {
    const s = serializeKey(inner);
    return Array.isArray(s) ? s.join(',') : s;
  });
}

/** Recursively convert a decoded value into a JSON-serializable form. */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return Number.isNaN(value)
        ? { __type: 'NaN' }
        : { __type: 'Infinity', sign: value > 0 ? 1 : -1 };
    }
    return value;
  }
  if (typeof value === 'bigint') return { __type: 'bigint', value: value.toString() };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array)
    return { __type: 'bytes', data: Buffer.from(value).toString('base64') };
  if (value instanceof Map) {
    return {
      __type: 'Map',
      entries: [...value.entries()].map(([k, val]) => [serializeValue(k), serializeValue(val)]),
    };
  }
  if (value instanceof Set) {
    return { __type: 'Set', values: [...value.values()].map((v) => serializeValue(v)) };
  }
  if (Array.isArray(value)) return value.map((v) => serializeValue(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = serializeValue(v);
    return out;
  }
  return String(value);
}
