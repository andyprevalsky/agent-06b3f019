import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';

import { cn } from '@/lib/utils';

const ContextMenu = ContextMenuPrimitive.Root;

/** Radix's own touch long-press delay. */
const LONG_PRESS_MS = 700;
/** Inset of a touch-opened menu from the trigger's left edge. */
const TOUCH_ANCHOR_INSET_PX = 8;

/**
 * Touch / pen long-press opens the menu from the trigger's left edge at the
 * touch height instead of under the finger. Radix anchors at the pointer and
 * only shifts menus vertically, so on a phone a wide menu pressed mid-row had
 * room on neither side and hung off the screen. Browsers that fire their own
 * long-press contextmenu (Android Chrome) open it at the same edge anchor right
 * away instead of at the finger, so the menu never opens twice or jumps. The
 * click that follows the finger lifting is swallowed so the long-press never
 * also activates the trigger (opening the pressed row). Mouse right-click is
 * unchanged.
 */
const ContextMenuTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>
>(
  (
    {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
      onContextMenu,
      ...props
    },
    ref,
  ) => {
    const timer = React.useRef<number | undefined>(undefined);
    /** The pending touch press's edge anchor; null when no long-press is pending. */
    const pending = React.useRef<{ target: HTMLElement; clientX: number; clientY: number } | null>(
      null,
    );
    const dispatching = React.useRef(false);
    const longPressOpened = React.useRef(false);
    const cancel = () => {
      window.clearTimeout(timer.current);
      pending.current = null;
    };
    const openAtEdge = () => {
      const press = pending.current;
      cancel();
      if (!press) return;
      longPressOpened.current = true;
      dispatching.current = true;
      try {
        press.target.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: press.clientX,
            clientY: press.clientY,
          }),
        );
      } finally {
        dispatching.current = false;
      }
    };
    React.useEffect(() => cancel, []);
    return (
      <ContextMenuPrimitive.Trigger
        ref={ref}
        {...props}
        onContextMenu={(event) => {
          if (!dispatching.current && pending.current) {
            // The browser's own long-press menu (at the finger): open at the edge now.
            event.preventDefault();
            openAtEdge();
            return;
          }
          onContextMenu?.(event);
        }}
        onClickCapture={(event) => {
          if (longPressOpened.current) {
            longPressOpened.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onClickCapture?.(event);
        }}
        onPointerDown={(event) => {
          longPressOpened.current = false;
          onPointerDown?.(event);
          if (event.defaultPrevented || event.pointerType === 'mouse') return;
          // Skips Radix's finger-anchored long-press; ours dispatches the open.
          event.preventDefault();
          const target = event.currentTarget;
          cancel();
          pending.current = {
            target,
            clientX: target.getBoundingClientRect().left + TOUCH_ANCHOR_INSET_PX,
            clientY: event.clientY,
          };
          timer.current = window.setTimeout(openAtEdge, LONG_PRESS_MS);
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event);
          cancel();
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          cancel();
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          cancel();
        }}
      />
    );
  },
);
ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName;

const ContextMenuPortal = ContextMenuPrimitive.Portal;

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPortal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        'z-[220] min-w-[10rem] overflow-hidden rounded-md border bg-[#EEEFF2]/90 dark:bg-[#1a1a1a]/90 backdrop-blur-[12px] p-1 shadow-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', ...props.style }}
      {...props}
    />
  </ContextMenuPortal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive = false, onPointerUp, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
      'focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      destructive && 'text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400',
      className,
    )}
    onPointerUp={(event) => {
      onPointerUp?.(event);
      // Opening a context menu must not select an item under the released right button.
      if (event.button !== 0) event.preventDefault();
    }}
    {...props}
  />
));
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
};
