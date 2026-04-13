/**
 * Terminal feature — message scroll and visibility hook.
 *
 * Handles auto-scrolling, tab visibility reconnection,
 * and browser-panel-aware scroll suppression.
 */

import { useEffect, useRef, useCallback } from 'react';

import { AUTO_SCROLL_THRESHOLD_PX } from '../config';
import type { Message } from '../types';

export function useTerminalMessages(
  messages: Message[],
  selectedAgentId: string | null,
  forceResubscribe: () => void,
) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isInitialLoadRef = useRef<boolean>(false);

  // Handle tab visibility changes — reconnect when visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && selectedAgentId) {
        setTimeout(() => {
          if (selectedAgentId) forceResubscribe();
        }, 1000);
      }
    };

    const handleFocus = () => {
      if (selectedAgentId) {
        setTimeout(() => {
          if (selectedAgentId) forceResubscribe();
        }, 500);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [selectedAgentId, forceResubscribe]);

  // Auto-scroll when messages change
  useEffect(() => {
    if (!messagesEndRef.current) return;

    const lastMessage = messages[messages.length - 1];
    const isBrowserAction = lastMessage?.metadata?.browser_url;
    if (isBrowserAction) return;

    const hasActiveBrowser = messages.some((msg) => {
      const taskId = msg.metadata?.task_id;
      if (!taskId) return false;
      const taskMessages = messages.filter((m) => m.metadata?.task_id === taskId);
      const lastTaskMessage = taskMessages[taskMessages.length - 1];
      return lastTaskMessage?.metadata?.action_type !== 'task_complete';
    });

    if (hasActiveBrowser) return;

    const scrollContainer = messagesEndRef.current.closest('[data-radix-scroll-area-viewport]');
    if (!scrollContainer) return;

    if (isInitialLoadRef.current) {
      requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        isInitialLoadRef.current = false;
      });
      return;
    }

    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;

    if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [messages]);

  const markInitialLoad = useCallback(() => {
    isInitialLoadRef.current = true;
  }, []);

  return { messagesEndRef, markInitialLoad };
}
