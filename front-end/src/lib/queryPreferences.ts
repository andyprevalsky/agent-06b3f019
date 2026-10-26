/** Account-scoped composer defaults only; never store drafts, credentials, or agent state. */
import { getItem, setItem } from './storage';

export interface QueryPreferences {
  model?: string;
  priceLimitCents?: number;
  fastMode?: boolean;
  ultraPreferred?: boolean;
}

const memory = new Map<string, QueryPreferences>();
const listeners = new Set<() => void>();
const keyFor = (userId: string) => `rose-query-defaults:${userId}`;

function validate(value: unknown): QueryPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const result: QueryPreferences = {};
  if (typeof input.model === 'string' && input.model.length > 0 && input.model.length <= 256)
    result.model = input.model;
  if (Number.isSafeInteger(input.priceLimitCents) && (input.priceLimitCents as number) > 0)
    result.priceLimitCents = input.priceLimitCents as number;
  if (typeof input.fastMode === 'boolean') result.fastMode = input.fastMode;
  if (typeof input.ultraPreferred === 'boolean') result.ultraPreferred = input.ultraPreferred;
  return result;
}

function parse(raw: string | null): QueryPreferences | null {
  if (raw === null) return null;
  try {
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readQueryPreferences(userId: string | null | undefined): QueryPreferences {
  if (!userId) return {};
  const current = memory.get(userId);
  if (current) return current;
  const local = parse(getItem(keyFor(userId)));
  if (local) return local;
  try {
    const prefix = encodeURIComponent(keyFor(userId)) + '=';
    const raw = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return parse(raw ? decodeURIComponent(raw.slice(prefix.length)) : null) ?? {};
  } catch {
    return {};
  }
}

export function writeQueryPreferences(userId: string, patch: QueryPreferences): void {
  const merged = validate({ ...readQueryPreferences(userId), ...patch });
  memory.set(userId, merged);
  const value = JSON.stringify(merged);
  setItem(keyFor(userId), value);
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${encodeURIComponent(keyFor(userId))}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Electron local storage remains available when cookies are unsupported.
  }
  for (const listener of listeners) listener();
}

export function subscribeQueryPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: simulate a fresh renderer without clearing durable preferences. */
export function resetQueryPreferencesMemory(): void {
  memory.clear();
}
