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

import { useEffect, useRef, useState, useMemo, useCallback, type RefObject } from 'react';
import { extractRecord, subscribeToChannel, unsubscribe } from '@/lib/realtime';
import type { Message } from '../hooks';

// Steel browser dimensions
// Debug view shows full browser window (1288x891), content viewport is 1280x800
// Chrome offsets: ~4px left border, ~91px top toolbar
const BROWSER_WINDOW_WIDTH = 1288;
const BROWSER_WINDOW_HEIGHT = 891;
const CONTENT_VIEWPORT_WIDTH = 1280;
const CONTENT_VIEWPORT_HEIGHT = 800;
const CHROME_OFFSET_X = 4; // Left border
const CHROME_OFFSET_Y = 91; // Toolbar height
const WINDOW_ASPECT = BROWSER_WINDOW_WIDTH / BROWSER_WINDOW_HEIGHT;
const MIN_CURSOR_ANIMATION_MS = 35;
const MAX_CURSOR_ANIMATION_MS = 120;
const DEFAULT_CURSOR_ANIMATION_MS = 70;

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

interface CursorPosition {
  x: number;
  y: number;
}

interface ViewportBounds {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface BrowserCursorPayload {
  agentId: string;
  taskId: string;
  x: number;
  y: number;
  sequence?: number;
  timestampMs?: number;
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
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  const containerAspect = containerWidth / containerHeight;

  let windowWidth: number;
  let windowHeight: number;
  let windowOffsetX: number;
  let windowOffsetY: number;

  if (containerAspect > WINDOW_ASPECT) {
    windowHeight = containerHeight;
    windowWidth = containerHeight * WINDOW_ASPECT;
    windowOffsetX = (containerWidth - windowWidth) / 2;
    windowOffsetY = 0;
  } else {
    windowWidth = containerWidth;
    windowHeight = containerWidth / WINDOW_ASPECT;
    windowOffsetX = 0;
    windowOffsetY = (containerHeight - windowHeight) / 2;
  }

  const scale = windowWidth / BROWSER_WINDOW_WIDTH;
  return {
    offsetX: windowOffsetX + CHROME_OFFSET_X * scale,
    offsetY: windowOffsetY + CHROME_OFFSET_Y * scale,
    width: CONTENT_VIEWPORT_WIDTH * scale,
    height: CONTENT_VIEWPORT_HEIGHT * scale,
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
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 640, y: 400 });
  const cursorPosRef = useRef<CursorPosition>(cursorPos);
  const animationFrameRef = useRef<number | null>(null);
  const animationStartRef = useRef<{
    from: CursorPosition;
    to: CursorPosition;
    startedAt: number;
    durationMs: number;
  } | null>(null);
  const lastRealtimeSampleRef = useRef<BrowserCursorPayload | null>(null);
  const lastProcessedMessageRef = useRef<string | null>(null);

  const updateCursorPos = useCallback((next: CursorPosition) => {
    cursorPosRef.current = next;
    setCursorPos(next);
  }, []);

  const stopAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    animationStartRef.current = null;
  }, []);

  const runAnimationFrame = useCallback(
    (now: number) => {
      const animation = animationStartRef.current;
      if (!animation) return;

      const elapsed = now - animation.startedAt;
      const progress = Math.min(1, Math.max(0, elapsed / animation.durationMs));
      const next = {
        x: animation.from.x + (animation.to.x - animation.from.x) * progress,
        y: animation.from.y + (animation.to.y - animation.from.y) * progress,
      };
      updateCursorPos(next);

      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(runAnimationFrame);
      } else {
        animationFrameRef.current = null;
        animationStartRef.current = null;
      }
    },
    [updateCursorPos],
  );

  const animateCursorTo = useCallback(
    (record: BrowserCursorPayload) => {
      const previous = lastRealtimeSampleRef.current;
      lastRealtimeSampleRef.current = record;

      const to = { x: record.x, y: record.y };
      if (!previous) {
        stopAnimation();
        updateCursorPos(to);
        return;
      }

      const sampleDeltaMs =
        typeof record.timestampMs === 'number' && typeof previous.timestampMs === 'number'
          ? record.timestampMs - previous.timestampMs
          : DEFAULT_CURSOR_ANIMATION_MS;
      const durationMs = Math.min(
        MAX_CURSOR_ANIMATION_MS,
        Math.max(
          MIN_CURSOR_ANIMATION_MS,
          sampleDeltaMs > 0 ? sampleDeltaMs : DEFAULT_CURSOR_ANIMATION_MS,
        ),
      );

      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationStartRef.current = {
        from: cursorPosRef.current,
        to,
        startedAt: performance.now(),
        durationMs,
      };
      animationFrameRef.current = window.requestAnimationFrame(runAnimationFrame);
    },
    [runAnimationFrame, stopAnimation, updateCursorPos],
  );

  useEffect(() => {
    if (!agentId) return;

    let disposed = false;
    let channel: Awaited<ReturnType<typeof subscribeToChannel>> | null = null;

    void subscribeToChannel(
      `agent:${agentId}`,
      {
        BROWSER_CURSOR: (wrapper: unknown) => {
          const record = extractRecord<BrowserCursorPayload>(wrapper);
          if (!isBrowserCursorPayload(record) || record.taskId !== taskId) return;
          animateCursorTo(record);
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
  }, [agentId, animateCursorTo, stopAnimation, taskId]);

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
      updateCursorPos({ x: coords.x, y: coords.y });
    }
  }, [latestWithCoords, stopAnimation, updateCursorPos]);

  return cursorPos;
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
    viewportBounds.offsetX + (cursorPos.x / CONTENT_VIEWPORT_WIDTH) * viewportBounds.width;
  const cursorTop =
    viewportBounds.offsetY + (cursorPos.y / CONTENT_VIEWPORT_HEIGHT) * viewportBounds.height;

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
