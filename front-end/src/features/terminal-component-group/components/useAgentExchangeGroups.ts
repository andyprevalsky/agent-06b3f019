/** Shared list clock and typing completion for the quiet exchange projection. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../hooks';
import { groupAgentExchanges } from './agentExchangeGroups';

export function useAgentExchangeGroups(
  messages: Message[],
  enabled: boolean,
  animatingId: string | null,
  onComplete: () => void,
  includeCodeOnly = false,
  suppliedGroups?: ReturnType<typeof groupAgentExchanges>,
) {
  const groups = useMemo(
    () =>
      enabled && suppliedGroups
        ? suppliedGroups
        : groupAgentExchanges(enabled ? messages : [], includeCodeOnly),
    [enabled, messages, includeCodeOnly, suppliedGroups],
  );
  const [now, setNow] = useState(Date.now);
  const completed = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || suppliedGroups || !groups.groupsByLeadId.size) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, [enabled, suppliedGroups, groups.groupsByLeadId.size]);
  useEffect(() => {
    if (!animatingId || !groups.foldedIds.has(animatingId)) {
      completed.current = null;
      return;
    }
    if (completed.current !== animatingId) {
      completed.current = animatingId;
      onComplete();
    }
  }, [groups, animatingId, onComplete]);
  return { groups, now };
}
