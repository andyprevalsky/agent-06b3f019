/**
 * useTopBarProps — account/viewport gating + wiring shared by the stock TopBar
 * row and the Rose Desktop NubToolbar (same items, different placement).
 */

import { useIsMobile } from '@/hooks/use-mobile';
import { canUseFastMode } from '@/lib/fastModeAccounts';
import { SIMULATOR_USER_IDS } from '@/lib/simulatorAccounts';
import { isAdminOperator } from '@/lib/adminAccounts';
import { useAuth } from '../../hooks';
import {
  IS_DEV_MODE,
  DEFAULT_RESTART_THRESHOLD,
  DEFAULT_PENDING_PRICE_LIMIT_CENTS,
} from '../../config';
import type { QueryInputProps } from './types';
import type { TopBarProps } from './TopBar';
import type { UsePriceLimitResult } from './usePriceLimit';
import type { useAttachments } from './useAttachments';

function getQueryInputVisibility(isMobile: boolean, user: { id?: string; phone?: string } | null) {
  const userId = user?.id;
  return {
    showTestPrompts: !isMobile && (IS_DEV_MODE || isAdminOperator(user)),
    showFastMode: canUseFastMode(user),
    showSimulator: userId != null && userId !== '' && SIMULATOR_USER_IDS.includes(userId),
  };
}

export function useTopBarProps(
  props: QueryInputProps,
  attachments: ReturnType<typeof useAttachments>,
  priceLimit: UsePriceLimitResult,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): TopBarProps {
  const { user: authUser } = useAuth();
  const visibility = getQueryInputVisibility(useIsMobile(), authUser);
  return {
    agentDetail: props.agentDetail ?? null,
    onAgentUpdate: props.onAgentUpdate,
    onAgentDelete: props.onAgentDelete,
    showTestPrompts: visibility.showTestPrompts,
    showFastMode: visibility.showFastMode,
    fastMode: props.fastMode ?? false,
    onFastModeChange: props.onFastModeChange,
    showSimulator: visibility.showSimulator,
    simulatorMode: props.simulatorMode ?? false,
    onSimulatorModeChange: props.onSimulatorModeChange,
    onSelectPrompt: (prompt, files) => {
      props.onChange(prompt);
      if (files && files.length > 0) void attachments.processFiles(files);
    },
    shouldAutoLoadDefaultPrompt: () => (textareaRef.current?.value ?? '').trim() === '',
    pendingPriceLimitCents: props.pendingPriceLimitCents ?? DEFAULT_PENDING_PRICE_LIMIT_CENTS,
    priceLimit,
    contextPercentage: props.contextPercentage ?? 0,
    contextSize: props.contextSize ?? 0,
    restartThreshold: props.restartThreshold ?? DEFAULT_RESTART_THRESHOLD,
  };
}
