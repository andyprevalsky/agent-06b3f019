/**
 * STATE MACHINE: AppDrawerShell
 *
 *   [CLOSED] translated off-screen to the right, opacity 0, inert
 *   --open--> [OPEN] slides in (transform + opacity only, 520ms
 *             cubic-bezier(.22,1,.36,1))
 *   [OPEN] --close--> [CLOSED]
 *
 * Desktop (md+), UI ledger rows 22/66 — no right bar, no gap, no floating card:
 *   variant 'panel': flush against the window's right edge, top 56px (below the
 *                    app icon row) to the bottom, only the top-left corner
 *                    rounded (12px). Left-edge handle / arrow keys resize it
 *                    (clamped >= 420px; transitions paused while dragging).
 *   variant 'full':  Browser — from the left bar (64px) to the right edge,
 *                    below the icon row; not resizable.
 * Mobile (< md): a full-height bottom sheet sliding up.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useRoseApps } from './roseAppsState';
import {
  APP_PANEL_RADIUS,
  APP_PANEL_TOP,
  DRAWER_DURATION_MS,
  DRAWER_EASE,
  LEFT_BAR_WIDTH,
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

type DrawerVariant = 'panel' | 'full';

function desktopGeometry(variant: DrawerVariant, width: number): React.CSSProperties {
  const base = { top: APP_PANEL_TOP, bottom: 0, right: 0, borderTopLeftRadius: APP_PANEL_RADIUS };
  return variant === 'full' ? { ...base, left: LEFT_BAR_WIDTH } : { ...base, width };
}

export function AppDrawerShell({
  open,
  label,
  testId,
  variant = 'panel',
  children,
}: {
  open: boolean;
  label: string;
  testId: string;
  variant?: DrawerVariant;
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
  const closedTransform = isMobile ? 'translateY(100%)' : 'translateX(calc(100% + 40px))';
  return (
    <section
      ref={shellRef}
      aria-label={label}
      aria-hidden={!open}
      data-testid={testId}
      data-state={open ? 'open' : 'closed'}
      data-variant={variant}
      className={cn(
        'fixed z-[66] flex flex-col overflow-hidden bg-white text-[hsl(240_15%_8%)] dark:bg-[#262624] dark:text-[#ecece8]',
        'border-l border-t border-gray-200/95 shadow-[-12px_0_40px_rgba(20,20,40,0.08)] dark:border-white/[0.09]',
        isMobile && 'inset-x-0 bottom-0 top-0 rounded-t-[14px]',
        !open && 'pointer-events-none',
      )}
      style={{
        ...(isMobile ? {} : desktopGeometry(variant, apps.drawerWidth)),
        transform: open ? 'none' : closedTransform,
        opacity: open ? 1 : 0,
        transition,
        willChange: 'transform',
      }}
    >
      {!isMobile && variant === 'panel' && (
        <DrawerResizeHandle label={`Resize ${label.toLowerCase()}`} />
      )}
      {children}
    </section>
  );
}
