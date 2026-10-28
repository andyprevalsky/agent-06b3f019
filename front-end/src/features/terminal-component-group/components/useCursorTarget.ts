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

export const DEFAULT_CURSOR_POSITION: CursorPosition = { x: 640, y: 400 };

type CursorScopeId = string | null | undefined;

interface ScopedCursorPosition {
  scopeId: CursorScopeId;
  position: CursorPosition;
}

/**
 * Cursor target state machine (page-space coordinates, scoped to one agent):
 *
 *   [DEFAULT center] -- realtime sample / saved action coords --> [TARGET]
 *   [TARGET] -- later sample (timestampMs not older) --> [TARGET]
 *   [TARGET] -- saved action coords, only before any live sample --> [TARGET]
 *   [any] -- agent switch --> [DEFAULT center]
 *
 * Only the target is held here. The overlay's CSS transition glides the cursor
 * to it, so there is no per-sample RAF loop to stutter on bursty delivery.
 */
export function useCursorTarget(scopeId: CursorScopeId) {
  const scopeIdRef = useRef(scopeId);
  scopeIdRef.current = scopeId;
  const [cursorState, setCursorState] = useState<ScopedCursorPosition>({
    scopeId,
    position: DEFAULT_CURSOR_POSITION,
  });
  const cursorPos =
    cursorState.scopeId === scopeId ? cursorState.position : DEFAULT_CURSOR_POSITION;
  const lastRealtimeSampleRef = useRef<BrowserCursorPayload | null>(null);

  const updateCursorPos = useCallback((next: CursorPosition, ownerScopeId: CursorScopeId) => {
    if (scopeIdRef.current !== ownerScopeId) return;
    setCursorState((previous) => {
      if (scopeIdRef.current !== ownerScopeId) return previous;
      if (
        previous.scopeId === ownerScopeId &&
        previous.position.x === next.x &&
        previous.position.y === next.y
      ) {
        return previous;
      }
      return { scopeId: ownerScopeId, position: next };
    });
  }, []);

  const applyRealtimeSample = useCallback(
    (record: BrowserCursorPayload, ownerScopeId: CursorScopeId) => {
      if (scopeIdRef.current !== ownerScopeId) return;
      const previous = lastRealtimeSampleRef.current;
      // Out-of-order delivery must not glide the cursor backward in time.
      if (
        typeof previous?.timestampMs === 'number' &&
        typeof record.timestampMs === 'number' &&
        record.timestampMs < previous.timestampMs
      ) {
        return;
      }
      lastRealtimeSampleRef.current = record;
      updateCursorPos({ x: record.x, y: record.y }, ownerScopeId);
    },
    [updateCursorPos],
  );

  const resetCursor = useCallback(
    (ownerScopeId: CursorScopeId) => {
      lastRealtimeSampleRef.current = null;
      updateCursorPos(DEFAULT_CURSOR_POSITION, ownerScopeId);
    },
    [updateCursorPos],
  );

  return {
    cursorPos,
    lastRealtimeSampleRef,
    updateCursorPos,
    applyRealtimeSample,
    resetCursor,
  };
}
