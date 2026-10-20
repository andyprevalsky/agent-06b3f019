/**
 * STATE MACHINE: AppDrawerShell
 *
 *   [CLOSED] translated off-screen past the app bar, opacity 0, inert
 *   --open--> [OPEN] slides in (transform + opacity only, 520ms
 *             cubic-bezier(.22,1,.36,1))
 *   [OPEN] --drag left-edge handle / arrow keys on it--> [OPEN, new width]
 *             (clamped to >= 420px; transitions paused while dragging)
 *   [OPEN] --close--> [CLOSED]
 *
 * Desktop (md+): a floating panel docked left of the right app bar, default
 * 50vw wide. Mobile (< md): a full-height bottom sheet sliding up.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useRoseApps } from './roseAppsState';
import {
  APP_BAR_WIDTH,
  DRAWER_DURATION_MS,
  DRAWER_EASE,
  DRAWER_GAP,
  drawerWidthFromPointer,
} from './roseAppsLayout';

const RESIZE_STEP = 24;

function DrawerResizeHandle({ label }: { label: string }) {
  const apps = useRoseApps();
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (apps === null) return;
      event.preventDefault();
      apps.setIsResizing(true);
      const onMove = (e: PointerEvent) =>
        apps.setDrawerWidth(drawerWidthFromPointer(e.clientX, window.innerWidth));
      const stop = () => {
        apps.setIsResizing(false);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        cleanupRef.current = null;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      cleanupRef.current = stop;
    },
    [apps],
  );
  if (apps === null) return null;
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowLeft') apps.setDrawerWidth(apps.drawerWidth + RESIZE_STEP);
    if (event.key === 'ArrowRight') apps.setDrawerWidth(apps.drawerWidth - RESIZE_STEP);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={apps.drawerWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      data-testid="app-drawer-resize-handle"
      className={cn(
        'absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize focus-visible:outline-none',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors',
        'hover:after:bg-blue-400/60 focus-visible:after:bg-blue-400/60',
        apps.isResizing ? 'after:bg-blue-500' : 'after:bg-transparent',
      )}
    />
  );
}

export function AppDrawerShell({
  open,
  label,
  testId,
  children,
}: {
  open: boolean;
  label: string;
  testId: string;
  children?: ReactNode;
}) {
  const apps = useRoseApps();
  const isMobile = useIsMobile();
  const shellRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    if (open) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [open]);
  if (apps === null) return null;
  const transition = apps.isResizing
    ? 'none'
    : `transform ${DRAWER_DURATION_MS}ms ${DRAWER_EASE}, opacity 250ms ease`;
  const closedTransform = isMobile ? 'translateY(100%)' : 'translateX(calc(100% + 90px))';
  return (
    <section
      ref={shellRef}
      aria-label={label}
      aria-hidden={!open}
      data-testid={testId}
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'fixed z-[45] flex flex-col overflow-hidden bg-white text-[hsl(240_15%_8%)]',
        'border border-gray-200/90 shadow-[0_20px_50px_rgba(20,20,40,0.18)]',
        isMobile ? 'inset-x-0 bottom-0 top-0 rounded-t-[14px]' : 'rounded-[14px]',
        !open && 'pointer-events-none',
      )}
      style={{
        ...(isMobile
          ? {}
          : {
              top: DRAWER_GAP,
              bottom: DRAWER_GAP,
              right: APP_BAR_WIDTH + DRAWER_GAP,
              width: apps.drawerWidth,
            }),
        transform: open ? 'none' : closedTransform,
        opacity: open ? 1 : 0,
        transition,
        willChange: 'transform',
      }}
    >
      {!isMobile && <DrawerResizeHandle label={`Resize ${label.toLowerCase()}`} />}
      {children}
    </section>
  );
}
