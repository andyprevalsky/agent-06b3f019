/**
 * Terminal feature — message scroll and visibility hook.
 *
 * Handles auto-scrolling, tab visibility reconnection,
 * and browser-panel-aware scroll suppression.
 * Scroll check: newest row for each task -> active: hold / all complete: follow.
 * Walk newest to oldest once so completed long histories cost O(messages).
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
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelReconnect = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };
    const scheduleReconnect = (delay: number) => {
      cancelReconnect();
      if (document.hidden || !selectedAgentId) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (!document.hidden) forceResubscribe();
      }, delay);
    };
    const handleVisibilityChange = () => {
      scheduleReconnect(1000);
    };

    const handleFocus = () => {
      scheduleReconnect(500);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelReconnect();
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

    const seenTasks = new Set<string>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const metadata = messages[index].metadata;
      const taskId = metadata?.task_id;
      if (!taskId || seenTasks.has(taskId)) continue;
      if (metadata.action_type !== 'task_complete') return;
      seenTasks.add(taskId);
    }

    const scrollContainer = messagesEndRef.current.closest('[data-radix-scroll-area-viewport]');
    if (!scrollContainer) return;

    if (isInitialLoadRef.current) {
      const frame = requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        isInitialLoadRef.current = false;
      });
      return () => cancelAnimationFrame(frame);
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
