/** Pure projection plus completion of animation IDs hidden by the live slot. */
import { useEffect, useMemo, useRef } from 'react';
import type { Message } from '../hooks';
import { groupTrajectoryWork } from './trajectoryWorkGroups';
export function useTrajectoryWorkGroups(
  messages: Message[],
  enabled: boolean,
  status: string | undefined,
  endedAt: string | undefined,
  animatingId: string | null,
  onComplete: () => void,
) {
  const groups = useMemo(
    () => groupTrajectoryWork(enabled ? messages : [], status, endedAt),
    [messages, enabled, status, endedAt],
  );
  const completed = useRef<string | null>(null);
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
  return groups;
}
