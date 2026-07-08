/**
 * Derived state for a ToolMessage card. Centralizes the expand/collapse and
 * progress/title handling so the main component stays under the 80-line
 * strict-lint cap.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ToolMessageData } from './types';
import { extractEmoji } from './extractEmoji';

export interface ToolMessageState {
  titleText: string;
  isThought: boolean;
  hasMessage: boolean;
  isExpandable: boolean;
  showChevron: boolean;
  shouldBeExpanded: boolean;
  toggle: () => void;
  progressPercent: number | undefined;
  showProgressBar: boolean;
}

export function useToolMessageState(
  data: ToolMessageData,
  shouldType: boolean,
  onComplete?: () => void,
): ToolMessageState {
  const [isExpanded, setIsExpanded] = useState(false);
  const isThought = data.toolName === 'thought';
  const isCloudAgentLifecycle = data.toolName === 'cloud_agent';
  const [forceExpanded, setForceExpanded] = useState(false);

  useEffect(() => {
    if (!isThought) return;
    if (data.status === 'IN_PROGRESS') {
      setForceExpanded(false);
      setIsExpanded(false);
    } else {
      setForceExpanded(false);
      setIsExpanded(false);
    }
  }, [isThought, data.status]);

  useEffect(() => {
    if (shouldType && onComplete) {
      requestAnimationFrame(() => onComplete());
    }
  }, [shouldType, onComplete]);

  const { text: titleText } = useMemo(() => extractEmoji(data.title), [data.title]);
  const hasMessage = useMemo(() => data.message.trim().length > 0, [data.message]);
  const isExpandable = useMemo(
    () => !isCloudAgentLifecycle && (data.status === 'FINISHED' || data.status === 'ERROR'),
    [data.status, isCloudAgentLifecycle],
  );
  const showChevron = useMemo(
    () => hasMessage && isExpandable && !forceExpanded,
    [hasMessage, isExpandable, forceExpanded],
  );
  const shouldBeExpanded = useMemo(() => forceExpanded || isExpanded, [forceExpanded, isExpanded]);

  const progressPercent = useMemo(() => {
    if (data.progressComplete === undefined) return undefined;
    return data.progressComplete <= 1 ? data.progressComplete * 100 : data.progressComplete;
  }, [data.progressComplete]);
  const showProgressBar =
    !isThought && progressPercent !== undefined && data.status === 'IN_PROGRESS';

  return {
    titleText,
    isThought,
    hasMessage,
    isExpandable,
    showChevron,
    shouldBeExpanded,
    toggle: () => setIsExpanded((v) => !v),
    progressPercent,
    showProgressBar,
  };
}
