import { useCallback, useRef, useState } from 'react';

export interface CursorPosition {
  x: number;
  y: number;
}

export interface BrowserCursorPayload {
  agentId: string;
  taskId: string;
  x: number;
  y: number;
  sequence?: number;
  timestampMs?: number;
}

const MIN_CURSOR_ANIMATION_MS = 35;
const MAX_CURSOR_ANIMATION_MS = 120;
const DEFAULT_CURSOR_ANIMATION_MS = 70;
const DEFAULT_CURSOR_POSITION: CursorPosition = { x: 640, y: 400 };

type CursorScopeId = string | null | undefined;

interface ScopedCursorPosition {
  scopeId: CursorScopeId;
  position: CursorPosition;
}

/**
 * Cursor animation state machine:
 *
 *   [IDLE] -- first realtime sample --> [IDLE at sample]
 *   [IDLE | ANIMATING] -- later sample --> [ANIMATING]
 *   [ANIMATING] -- RAF progress < 1 --> [ANIMATING]
 *   [ANIMATING] -- RAF progress = 1 / stop --> [IDLE]
 *
 * A newer sample cancels the scheduled frame and starts from cursorPosRef, so
 * rapid realtime updates remain continuous instead of jumping backward.
 */

export function useCursorAnimation(scopeId: CursorScopeId) {
  const scopeIdRef = useRef(scopeId);
  scopeIdRef.current = scopeId;
  const [cursorState, setCursorState] = useState<ScopedCursorPosition>({
    scopeId,
    position: DEFAULT_CURSOR_POSITION,
  });
  const cursorPos =
    cursorState.scopeId === scopeId ? cursorState.position : DEFAULT_CURSOR_POSITION;
  const cursorPosRef = useRef(cursorPos);
  const animationFrameRef = useRef<number | null>(null);
  const animationStartRef = useRef<{
    scopeId: CursorScopeId;
    from: CursorPosition;
    to: CursorPosition;
    startedAt: number;
    durationMs: number;
  } | null>(null);
  const lastRealtimeSampleRef = useRef<BrowserCursorPayload | null>(null);

  const updateCursorPos = useCallback((next: CursorPosition, ownerScopeId: CursorScopeId) => {
    if (scopeIdRef.current !== ownerScopeId) return;
    cursorPosRef.current = next;
    setCursorState((previous) =>
      scopeIdRef.current === ownerScopeId ? { scopeId: ownerScopeId, position: next } : previous,
    );
  }, []);
  const stopAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    animationStartRef.current = null;
  }, []);
  const runAnimationFrame = useCallback(
    (now: number) => {
      const animation = animationStartRef.current;
      if (!animation) return;
      if (scopeIdRef.current !== animation.scopeId) {
        animationFrameRef.current = null;
        animationStartRef.current = null;
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - animation.startedAt) / animation.durationMs));
      updateCursorPos(
        {
          x: animation.from.x + (animation.to.x - animation.from.x) * progress,
          y: animation.from.y + (animation.to.y - animation.from.y) * progress,
        },
        animation.scopeId,
      );
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
    (record: BrowserCursorPayload, ownerScopeId: CursorScopeId) => {
      if (scopeIdRef.current !== ownerScopeId) return;
      const previous = lastRealtimeSampleRef.current;
      lastRealtimeSampleRef.current = record;
      const to = { x: record.x, y: record.y };
      if (!previous) {
        stopAnimation();
        updateCursorPos(to, ownerScopeId);
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
      if (animationFrameRef.current !== null)
        window.cancelAnimationFrame(animationFrameRef.current);
      animationStartRef.current = {
        scopeId: ownerScopeId,
        from: cursorPosRef.current,
        to,
        startedAt: performance.now(),
        durationMs,
      };
      animationFrameRef.current = window.requestAnimationFrame(runAnimationFrame);
    },
    [runAnimationFrame, stopAnimation, updateCursorPos],
  );

  const resetCursor = useCallback(
    (ownerScopeId: CursorScopeId) => {
      stopAnimation();
      lastRealtimeSampleRef.current = null;
      updateCursorPos(DEFAULT_CURSOR_POSITION, ownerScopeId);
    },
    [stopAnimation, updateCursorPos],
  );

  return {
    cursorPos,
    lastRealtimeSampleRef,
    updateCursorPos,
    stopAnimation,
    animateCursorTo,
    resetCursor,
  };
}
