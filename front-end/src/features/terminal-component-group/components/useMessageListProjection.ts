/** Shared projections keep the renderer focused on one ordered list map. */
import { useMemo } from 'react';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import type { Message } from '../hooks';
import { dedupeCodeDisplays } from '../hooks/codeDisplayIdentity';
import { EMPTY_DISPLAY_MEDIA_GROUPING, groupDisplayMedia } from './inline-media/displayMediaGroups';
import { useAgentExchangeGroups } from './useAgentExchangeGroups';
import { useTrajectoryWorkGroups } from './useTrajectoryWorkGroups';
import { groupToolArtifacts } from './toolArtifactGroups';
import { isHiddenTrajectoryRow } from './trajectoryRowVisibility';
import type { WebSearchTurnGrouping } from './webSearchTurnGroups';
export function useMessageListProjection({
  filteredMessages,
  groupAgentMessages,
  compressWork,
  workStatus,
  workEndedAt,
  agentExchangeGroups,
  webSearchGrouping,
  currentAnimatingId,
  onAnimationComplete,
}: {
  filteredMessages: Message[];
  groupAgentMessages: boolean;
  compressWork: boolean;
  workStatus?: string;
  workEndedAt?: string;
  agentExchangeGroups?: ReturnType<typeof useAgentExchangeGroups>['groups'];
  webSearchGrouping: WebSearchTurnGrouping;
  currentAnimatingId: string | null;
  onAnimationComplete: () => void;
}) {
  const roseDesktop = useRoseDesktop();
  const artifactGrouping = useMemo(() => groupToolArtifacts(filteredMessages), [filteredMessages]);
  const visibleMessages = useMemo(
    () =>
      roseDesktop
        ? dedupeCodeDisplays(artifactGrouping.visibleMessages)
        : artifactGrouping.visibleMessages,
    [artifactGrouping, roseDesktop],
  );
  const displayGrouping = useMemo(
    () => (roseDesktop ? groupDisplayMedia(visibleMessages) : EMPTY_DISPLAY_MEDIA_GROUPING),
    [visibleMessages, roseDesktop],
  );
  const localExchanges = useAgentExchangeGroups(
    visibleMessages,
    roseDesktop && groupAgentMessages && !compressWork,
    currentAnimatingId,
    onAnimationComplete,
    false,
    agentExchangeGroups,
  );
  const workGroups = useTrajectoryWorkGroups(
    visibleMessages,
    roseDesktop && compressWork,
    workStatus,
    workEndedAt,
    currentAnimatingId,
    onAnimationComplete,
  );
  const exchanges = agentExchangeGroups ?? localExchanges.groups;
  const renderedMessages = useMemo(
    () =>
      visibleMessages.filter((message) => {
        if (roseDesktop && isHiddenTrajectoryRow(message)) return false;
        const id = message.message_id;
        if (workGroups.groupsByLeadId.has(id)) return true;
        if (workGroups.foldedIds.has(id)) return false;
        if (exchanges.groupsByLeadId.has(id)) return true;
        return (
          !exchanges.foldedIds.has(id) &&
          !webSearchGrouping.hiddenMessageIds.has(id) &&
          !displayGrouping.hiddenMessageIds.has(id)
        );
      }),
    [visibleMessages, roseDesktop, workGroups, exchanges, webSearchGrouping, displayGrouping],
  );
  return {
    renderedMessages,
    displayGrouping,
    localExchanges,
    workGroups,
    artifactsByOwner: artifactGrouping.byOwner,
  };
}
