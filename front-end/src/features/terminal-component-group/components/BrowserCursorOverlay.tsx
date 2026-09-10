/**
 * BrowserCursorOverlay - Renders cursor on top of browser view
 *
 * STATE MACHINE:
 * [MOUNTED] -> subscribe to agent:{agentId} BROWSER_CURSOR broadcast
 *    |
 *    +--> [STREAMING] first realtime sample initializes cursor
 *    |        |
 *    |        v
 *    |     [INTERPOLATING] later samples become animation targets; RAF blends between points
 *    |
 *    +--> [MESSAGE_FALLBACK] saved browser action coordinates update position
 *    |
 *    v
 * [UNMOUNTED] -> unsubscribe from realtime channel
 *
 * Realtime samples mirror BrowserHumanizer cursor motion. Browser action message
 * coordinates remain the durable fallback for reloads and completed runs.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  type MutableRefObject,
  type RefObject,
} from 'react';
import { extractRecord, subscribeToChannel, unsubscribe } from '@/lib/realtime';
import { recordAgentScopeDiscard } from '@/lib/agentScopeDiagnostics';
import type { Message } from '../hooks';
import {
  useCursorAnimation,
  type BrowserCursorPayload,
  type CursorPosition,
} from './useCursorAnimation';
import {
  LIVE_VIEW_CONTENT_VIEWPORT,
  computeLiveViewLetterbox,
} from './browser-status-bar/liveViewGeometry';

// Custom cursor SVG - navigation arrow pointing right (from navigate-v2.png, flipped)
// Auto-traced using potrace from the actual PNG. Black fill, 4px white stroke.
// Tip is on right edge after flip; translateX(-28px) aligns tip with click point.
const CURSOR_SVG = `<svg width="28" height="28" viewBox="0 0 427 427" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(427, 0) scale(-1, 1)">
    <g transform="translate(-43, 470) scale(0.1, -0.1)">
      <path d="M669 4687 c-149 -42 -244 -165 -242 -312 1 -77 1202 -3705 1257 -3800 116 -198 438 -191 548 11 15 27 128 389 253 804 322 1072 177 927 1255 1250 830 249 777 231 840 281 165 131 146 408 -36 515 -59 35 -3711 1251 -3777 1258 -29 3 -72 0 -98 -7z"
            fill="#1a1a1a" stroke="#ffffff" stroke-width="40" stroke-linejoin="round"/>
    </g>
  </g>
</svg>`;

interface BrowserCursorOverlayProps {
  agentId?: string | null;
  taskId: string;
  messages: Message[];
}

interface ViewportBounds {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

function isBrowserCursorPayload(value: unknown): value is BrowserCursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<BrowserCursorPayload>;
  return (
    typeof record.agentId === 'string' &&
    typeof record.taskId === 'string' &&
    typeof record.x === 'number' &&
    typeof record.y === 'number'
  );
}

function computeViewportBounds(container: HTMLDivElement): ViewportBounds {
  const box = computeLiveViewLetterbox(
    container.clientWidth,
    container.clientHeight,
    LIVE_VIEW_CONTENT_VIEWPORT.width,
    LIVE_VIEW_CONTENT_VIEWPORT.height,
  );
  return {
    offsetX: box.offsetX,
    offsetY: box.offsetY,
    width: box.width,
    height: box.height,
  };
}

function useViewportBounds(containerRef: RefObject<HTMLDivElement | null>): ViewportBounds {
  const [viewportBounds, setViewportBounds] = useState<ViewportBounds>({
    offsetX: 0,
    offsetY: 0,
    width: 0,
    height: 0,
  });

  const updateViewportBounds = useCallback(() => {
    if (!containerRef.current) return;
    setViewportBounds(computeViewportBounds(containerRef.current));
  }, [containerRef]);

  useEffect(() => {
    updateViewportBounds();
    const observer = new ResizeObserver(updateViewportBounds);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [updateViewportBounds, containerRef]);

  return viewportBounds;
}

function useCursorPosition(
  agentId: string | null | undefined,
  taskId: string,
  messages: Message[],
): CursorPosition {
  const lastProcessedMessageRef = useRef<string | null>(null);
  const liveAgentIdRef = useRef(agentId);
  liveAgentIdRef.current = agentId;
  const {
    cursorPos,
    lastRealtimeSampleRef,
    updateCursorPos,
    stopAnimation,
    animateCursorTo,
    resetCursor,
  } = useCursorAnimation(agentId);

  useLayoutEffect(() => {
    lastProcessedMessageRef.current = null;
    resetCursor(agentId);
  }, [agentId, resetCursor]);

  useRealtimeCursor(agentId, liveAgentIdRef, taskId, animateCursorTo, stopAnimation);
  useMessageCursor(
    agentId,
    messages,
    taskId,
    lastProcessedMessageRef,
    lastRealtimeSampleRef,
    stopAnimation,
    updateCursorPos,
  );
  return cursorPos;
}

function useRealtimeCursor(
  agentId: string | null | undefined,
  liveAgentIdRef: MutableRefObject<string | null | undefined>,
  taskId: string,
  animateCursorTo: (record: BrowserCursorPayload, ownerScopeId: string | null | undefined) => void,
  stopAnimation: () => void,
) {
  useEffect(() => {
    if (!agentId) return;

    let disposed = false;
    let discardReported = false;
    let channel: Awaited<ReturnType<typeof subscribeToChannel>> | null = null;

    void subscribeToChannel(
      `agent:${agentId}`,
      {
        BROWSER_CURSOR: (wrapper: unknown) => {
          const record = extractRecord<BrowserCursorPayload>(wrapper);
          if (!isBrowserCursorPayload(record) || record.taskId !== taskId) return;
          if (disposed || liveAgentIdRef.current !== agentId || record.agentId !== agentId) {
            if (!discardReported) {
              discardReported = true;
              recordAgentScopeDiscard('browser-cursor', record.agentId, liveAgentIdRef.current);
            }
            return;
          }
          animateCursorTo(record, agentId);
        },
      },
      'Browser cursor',
    )
      .then((nextChannel) => {
        if (disposed) {
          unsubscribe(nextChannel);
          return;
        }
        channel = nextChannel;
      })
      .catch((error: unknown) => {
        console.warn('Failed to subscribe to browser cursor stream', error);
      });

    return () => {
      disposed = true;
      stopAnimation();
      unsubscribe(channel);
    };
  }, [agentId, animateCursorTo, liveAgentIdRef, stopAnimation, taskId]);
}

function useMessageCursor(
  agentId: string | null | undefined,
  messages: Message[],
  taskId: string,
  lastProcessedMessageRef: MutableRefObject<string | null>,
  lastRealtimeSampleRef: MutableRefObject<BrowserCursorPayload | null>,
  stopAnimation: () => void,
  updateCursorPos: (next: CursorPosition, ownerScopeId: string | null | undefined) => void,
) {
  const latestWithCoords = useMemo(() => {
    const browserMessages = messages.filter(
      (m) => m.metadata?.task_id === taskId && m.metadata?.auxiliary?.coordinates,
    );
    return browserMessages[browserMessages.length - 1];
  }, [messages, taskId]);

  useEffect(() => {
    if (!latestWithCoords) return;

    const messageId = latestWithCoords.message_id;
    if (messageId === lastProcessedMessageRef.current) return;
    lastProcessedMessageRef.current = messageId;

    const coords = latestWithCoords.metadata?.auxiliary?.coordinates as CursorPosition | undefined;
    if (coords?.x !== undefined && coords?.y !== undefined) {
      lastRealtimeSampleRef.current = null;
      stopAnimation();
      updateCursorPos({ x: coords.x, y: coords.y }, agentId);
    }
  }, [
    agentId,
    lastProcessedMessageRef,
    lastRealtimeSampleRef,
    latestWithCoords,
    stopAnimation,
    updateCursorPos,
  ]);
}

export default function BrowserCursorOverlay({
  agentId,
  taskId,
  messages,
}: BrowserCursorOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportBounds = useViewportBounds(containerRef);
  const cursorPos = useCursorPosition(agentId, taskId, messages);

  const cursorLeft =
    viewportBounds.offsetX +
    (cursorPos.x / LIVE_VIEW_CONTENT_VIEWPORT.width) * viewportBounds.width;
  const cursorTop =
    viewportBounds.offsetY +
    (cursorPos.y / LIVE_VIEW_CONTENT_VIEWPORT.height) * viewportBounds.height;

  return (
    <div
      data-testid="browser-cursor-overlay"
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 10,
      }}
    >
      <div
        data-testid="browser-cursor"
        style={{
          position: 'absolute',
          left: cursorLeft,
          top: cursorTop,
          width: 28,
          height: 28,
          pointerEvents: 'none',
          filter: 'drop-shadow(2px 3px 3px rgba(0, 0, 0, 0.5))',
          transform: 'translateX(-28px)',
          willChange: 'left, top',
        }}
        dangerouslySetInnerHTML={{ __html: CURSOR_SVG }}
      />
    </div>
  );
}
