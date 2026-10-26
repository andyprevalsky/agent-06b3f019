import { useCallback, useState } from 'react';
import type { AgentDisplayEntry } from './agentDisplayEntries';

/** Retain displayed outputs when their chat unmounts; replay upserts by canonical id. */
export function useAgentDisplays() {
  const [displayEntries, setEntries] = useState<AgentDisplayEntry[]>([]);
  const [displaySelection, setSelection] = useState<{ agentId: string; id: string } | null>(null);
  const registerDisplays = useCallback((incoming: AgentDisplayEntry[]) => {
    if (!incoming.length) return;
    setEntries((previous) => {
      const next = [...previous];
      let changed = false;
      for (const entry of incoming) {
        const index = next.findIndex((old) => old.agentId === entry.agentId && old.id === entry.id);
        if (index < 0) {
          next.push(entry);
          changed = true;
        } else if (JSON.stringify(next[index]) !== JSON.stringify(entry)) {
          next[index] = entry;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);
  return { displayEntries, displaySelection, registerDisplays, selectDisplay: setSelection };
}
