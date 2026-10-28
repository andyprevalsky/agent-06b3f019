/**
 * BrowserCursorOverlay - Renders the agent's cursor on top of the live browser
 *
 * STATE MACHINE:
 * [MOUNTED] -> subscribe to agent:{agentId} BROWSER_CURSOR broadcast
 *    |
 *    +--> [TARGET] realtime sample (or saved action coords before any sample)
 *    |        |  (page CSS px); a CSS transition glides the track there
 *    |        v
 *    |     [TARGET] later samples retarget the same glide (no remount/restart)
 *    |
 *    +--> visible=false (user/assist control) -> hidden; target + bob kept
 *    |
 *    v
 * [UNMOUNTED] -> unsubscribe from realtime channel
 *
 * GEOMETRY: the overlay fills the letterboxed 1280x800 stream box. Page
 * coordinates map through resolveLiveViewPageRect (Kernel: Chrome UI above the
 * page) to fractions of that box, applied as a % translate on a full-size
 * track, so alignment holds at any pane size, aspect ratio, zoom or DPR without
 * measuring. MOTION: the track glides; an inner element runs one constant,
 * slow bob loop that new samples never restart. Reduced motion disables both.
 *
 * Realtime samples mirror BrowserHumanizer cursor motion. Browser action message
 * coordinates remain the durable fallback for reloads and completed runs.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { extractRecord, subscribeToChannel, unsubscribe } from '@/lib/realtime';
import { recordAgentScopeDiscard } from '@/lib/agentScopeDiagnostics';
import type { Message } from '../hooks';
import { useCursorTarget, type BrowserCursorPayload, type CursorPosition } from './useCursorTarget';
import {
  liveViewPointFraction,
  resolveLiveViewPageRect,
} from './browser-status-bar/liveViewDisplay';

// Custom cursor SVG - navigation arrow pointing right (from navigate-v2.png, flipped)
// Auto-traced using potrace from the actual PNG. Black fill, 4px white stroke.
// Tip is at the top-right corner after the flip; left: -28px puts it on the point.
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
  /** Live-view URL: selects where the page viewport sits inside the stream. */
  browserUrl?: string | null;
  /** Hide without unmounting, so the glide position and bob survive control flips. */
  visible?: boolean;
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

function useCursorPosition(
  agentId: string | null | undefined,
  taskId: string,
  messages: Message[],
): CursorPosition {
  const lastProcessedMessageRef = useRef<string | null>(null);
  const liveAgentIdRef = useRef(agentId);
  liveAgentIdRef.current = agentId;
  const { cursorPos, lastRealtimeSampleRef, updateCursorPos, applyRealtimeSample, resetCursor } =
    useCursorTarget(agentId);

  useLayoutEffect(() => {
    lastProcessedMessageRef.current = null;
    resetCursor(agentId);
  }, [agentId, resetCursor]);

  useRealtimeCursor(agentId, liveAgentIdRef, taskId, applyRealtimeSample);
  useMessageCursor(
    agentId,
    messages,
    taskId,
    lastProcessedMessageRef,
    lastRealtimeSampleRef,
    updateCursorPos,
  );
  return cursorPos;
}

function useRealtimeCursor(
  agentId: string | null | undefined,
  liveAgentIdRef: MutableRefObject<string | null | undefined>,
  taskId: string,
  applyRealtimeSample: (
    record: BrowserCursorPayload,
    ownerScopeId: string | null | undefined,
  ) => void,
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
          applyRealtimeSample(record, agentId);
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
      unsubscribe(channel);
    };
  }, [agentId, applyRealtimeSample, liveAgentIdRef, taskId]);
}

function useMessageCursor(
  agentId: string | null | undefined,
  messages: Message[],
  taskId: string,
  lastProcessedMessageRef: MutableRefObject<string | null>,
  lastRealtimeSampleRef: MutableRefObject<BrowserCursorPayload | null>,
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

    // Live samples are the truth once streaming; a late-saved action message
    // must not glide the cursor back to an earlier click.
    if (lastRealtimeSampleRef.current) return;
    const coords = latestWithCoords.metadata?.auxiliary?.coordinates as CursorPosition | undefined;
    if (typeof coords?.x === 'number' && typeof coords?.y === 'number') {
      updateCursorPos({ x: coords.x, y: coords.y }, agentId);
    }
  }, [agentId, lastProcessedMessageRef, lastRealtimeSampleRef, latestWithCoords, updateCursorPos]);
}

export default function BrowserCursorOverlay({
  agentId,
  taskId,
  messages,
  browserUrl,
  visible = true,
}: BrowserCursorOverlayProps) {
  const cursorPos = useCursorPosition(agentId, taskId, messages);
  const fraction = liveViewPointFraction(resolveLiveViewPageRect(browserUrl), cursorPos);

  return (
    <div
      data-testid="browser-cursor-overlay"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 10,
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      {/* Full-size track: a % translate is relative to its own (= stream) size. */}
      <div
        data-testid="browser-cursor-track"
        className="browser-cursor-track"
        data-cursor-x={cursorPos.x}
        data-cursor-y={cursorPos.y}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          transform: `translate(${fraction.x * 100}%, ${fraction.y * 100}%)`,
          willChange: 'transform',
        }}
      >
        <div
          data-testid="browser-cursor"
          className="browser-cursor-bob"
          style={{
            position: 'absolute',
            left: -28,
            top: 0,
            width: 28,
            height: 28,
            filter: 'drop-shadow(2px 3px 3px rgba(0, 0, 0, 0.5))',
          }}
          dangerouslySetInnerHTML={{ __html: CURSOR_SVG }}
        />
      </div>
    </div>
  );
}
