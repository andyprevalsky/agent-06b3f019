/** Persistent defaults for signed-in accounts; signed-out controls remain usable in memory. */
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  readQueryPreferences,
  subscribeQueryPreferences,
  writeQueryPreferences,
  type QueryPreferences,
} from '@/lib/queryPreferences';

export function useQueryPreference<K extends keyof QueryPreferences>(
  userId: string | null | undefined,
  key: K,
  fallback: QueryPreferences[K],
) {
  const [local, setLocal] = useState(fallback);
  const stored = useSyncExternalStore(
    subscribeQueryPreferences,
    () => readQueryPreferences(userId)[key],
    () => undefined,
  );
  const setValue = useCallback(
    (value: QueryPreferences[K]) => {
      if (userId) writeQueryPreferences(userId, { [key]: value });
      else setLocal(value);
    },
    [key, userId],
  );
  return [userId ? (stored ?? fallback) : local, setValue] as const;
}
