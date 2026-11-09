/**
 * [EXPANDED + new owned phone event] -> existing fullscreen event once.
 * [EXACT NATIVE ATTENTION HINT] -> fullscreen validation, even when collapsed.
 * [COLLAPSED|FORCE_MINIMIZED] -> no read/poll or forced open.
 * [FULLSCREEN -> CLOSED] -> same phone event cannot reopen it; new event may.
 */
import { useEffect, useRef } from 'react';
import type { Message } from '../../../hooks';
import { phoneActivityKey } from './phoneOverlayState';

export function usePhoneFullscreenEntry(
  taskId: string,
  messages: Message[],
  ui: { isExpanded: boolean; isFullscreen: boolean },
  forceMinimized: boolean,
  attentionRequestId = '',
) {
  const trigger = attentionRequestId
    ? `auth:${attentionRequestId}`
    : phoneActivityKey(messages, taskId);
  const opened = useRef('');
  useEffect(() => {
    if (ui.isFullscreen) {
      opened.current = trigger;
      return;
    }
    if (
      (ui.isExpanded || attentionRequestId) &&
      !forceMinimized &&
      trigger &&
      opened.current !== trigger
    ) {
      opened.current = trigger;
      window.dispatchEvent(new CustomEvent('navi-open-browser', { detail: { taskId } }));
    }
  }, [attentionRequestId, forceMinimized, trigger, taskId, ui.isExpanded, ui.isFullscreen]);
}
