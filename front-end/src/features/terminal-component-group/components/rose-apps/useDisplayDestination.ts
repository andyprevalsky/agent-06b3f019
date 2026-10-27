import { useEffect, useMemo } from 'react';
import type { Message } from '../../hooks';
import { useRoseApps } from './roseAppsState';
import { agentDisplayEntries, displayEntryId } from './agentDisplayEntries';

/** Only the active app conversation routes its displays into the shared panel. */
export function useDisplayDestination(messages: Message[], owner: string | null, enabled: boolean) {
  const apps = useRoseApps();
  const route = enabled && owner !== null && apps?.selectedAgentId === owner;
  const entries = useMemo(
    () => (route ? agentDisplayEntries(owner!, messages) : []),
    [route, owner, messages],
  );
  const register = apps?.registerDisplays;
  useEffect(() => {
    if (route) register?.(entries);
  }, [route, register, entries]);
  return route
    ? (message: Message) => apps?.openAgentDisplay(owner!, displayEntryId(message))
    : undefined;
}
