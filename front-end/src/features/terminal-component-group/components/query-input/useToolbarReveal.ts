/**
 * useToolbarReveal — owns the query-box toolbar reveal flags (see the state
 * machine in ToolbarNub.tsx, NubTab): open = hovered || focused || pinned.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

export const TOOLBAR_LEAVE_GRACE_MS = 150;

export interface ToolbarReveal {
  open: boolean;
  toolbarId: string;
  nubRef: React.RefObject<HTMLDivElement | null>;
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  regionHandlers: {
    onPointerEnter: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onFocus: () => void;
    onBlur: (e: React.FocusEvent) => void;
  };
  onNubClick: () => void;
}

function isInside(node: EventTarget | null, refs: React.RefObject<HTMLElement | null>[]): boolean {
  if (!(node instanceof Node)) return false;
  return refs.some((ref) => ref.current?.contains(node) === true);
}

/** Owns the hovered/focused/pinned flags; see ToolbarNub.tsx's state machine. */
export function useToolbarReveal(): ToolbarReveal {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const toolbarId = useId();
  const nubRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const lastPointerType = useRef<string>('');
  const pointerInside = useRef(false);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // A touch outside the nub/toolbar (and outside their portaled popovers, which
  // mark pointerInside via React bubbling first) unpins the toolbar.
  useEffect(() => {
    if (!pinned) return undefined;
    const onDocPointerDown = () => {
      if (!pointerInside.current) setPinned(false);
      pointerInside.current = false;
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [pinned]);

  const onPointerEnter = useCallback((e: React.PointerEvent) => {
    lastPointerType.current = e.pointerType ?? '';
    if (e.pointerType === 'touch') return;
    window.clearTimeout(leaveTimer.current);
    setHovered(true);
  }, []);

  const onPointerLeave = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHovered(false), TOOLBAR_LEAVE_GRACE_MS);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    lastPointerType.current = e.pointerType ?? '';
    pointerInside.current = true;
  }, []);

  const onFocus = useCallback(() => {
    if (lastPointerType.current === 'touch') return;
    setFocused(true);
  }, []);

  const onBlur = useCallback((e: React.FocusEvent) => {
    if (isInside(e.relatedTarget, [nubRef, toolbarRef])) return;
    setFocused(false);
  }, []);

  const onNubClick = useCallback(() => {
    // Mouse hover already opened it; only taps (and keyboard-synthesized clicks) pin.
    if (lastPointerType.current === 'mouse' || lastPointerType.current === 'pen') return;
    setPinned((prev) => !prev);
  }, []);

  return {
    open: hovered || focused || pinned,
    toolbarId,
    nubRef,
    toolbarRef,
    regionHandlers: { onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur },
    onNubClick,
  };
}
