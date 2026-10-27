/** Shared projections keep the renderer focused on one ordered list map. */
import { useMemo } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import type { Message } from '../hooks';
import { dedupeCodeDisplays } from '../hooks/codeDisplayIdentity';
import { EMPTY_DISPLAY_MEDIA_GROUPING, groupDisplayMedia } from './inline-media/displayMediaGroups';
import { useDisplayDestination } from './rose-apps/useDisplayDestination';
import { useAgentExchangeGroups } from './useAgentExchangeGroups';
import { useTrajectoryWorkGroups } from './useTrajectoryWorkGroups';
export function useMessageListProjection({
  filteredMessages,
  groupAgentMessages,
  compressWork,
  workStatus,
  workEndedAt,
  selectedAgentId,
  currentAnimatingId,
  onAnimationComplete,
}: {
  filteredMessages: Message[];
  groupAgentMessages: boolean;
  compressWork: boolean;
  workStatus?: string;
  workEndedAt?: string;
  selectedAgentId: string | null;
  currentAnimatingId: string | null;
  onAnimationComplete: () => void;
}) {
  const roseDesktop = useRoseDesktop();
  const visibleMessages = useMemo(
    () => (roseDesktop ? dedupeCodeDisplays(filteredMessages) : filteredMessages),
    [filteredMessages, roseDesktop],
  );
  const openDisplay = useDisplayDestination(visibleMessages, selectedAgentId, roseDesktop);
  const displayGrouping = useMemo(
    () => (roseDesktop ? groupDisplayMedia(visibleMessages) : EMPTY_DISPLAY_MEDIA_GROUPING),
    [visibleMessages, roseDesktop],
  );
  const localExchanges = useAgentExchangeGroups(
    visibleMessages,
    roseDesktop && groupAgentMessages && !compressWork,
    currentAnimatingId,
    onAnimationComplete,
  );
  const workGroups = useTrajectoryWorkGroups(
    visibleMessages,
    roseDesktop && compressWork,
    workStatus,
    workEndedAt,
    currentAnimatingId,
    onAnimationComplete,
  );
  return { visibleMessages, openDisplay, displayGrouping, localExchanges, workGroups };
}
