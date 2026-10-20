/**
 * STATE MACHINE: UserUiBackgroundLayer + UserUiAppBackdrop
 *
 * UserUiBackgroundLayer (fixed, full viewport, BEHIND the app):
 *   no backdrop (stock / safe mode) → nothing rendered
 *   backdrop                        → theme image <img> and/or `background`
 *                                     slot iframe, pointer-events none
 *
 * UserUiAppBackdrop (wraps the app's own background colour + grid/canvas
 * pattern layers):
 *   no backdrop                     → opacity 1, stock classes untouched
 *   backdrop + no user message yet  → [OPAQUE]  opacity 1, app bg colour here
 *   backdrop + >=1 user message     → [FADED]   opacity = fadeAfterFirstMessage
 *   [OPAQUE] --first user message--> [FADED]   600ms opacity transition
 *   [FADED]  --new agent / home-->   [OPAQUE]
 *
 * Only `opacity` animates (compositor-only); reduced-motion skips the tween.
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { BACKGROUND_FADE_TRANSITION_MS, backdropOpacity } from '../config';
import { useUserUi } from '../hooks';
import { UserUiFrame } from './UserUiFrame';

export function UserUiBackgroundLayer() {
  const { background, slotUrl } = useUserUi();
  const slotSrc = slotUrl('background');
  if (!background) return null;
  return (
    <div
      data-testid="user-ui-background-layer"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
    >
      {background.imageUrl && (
        <img
          data-testid="user-ui-background-image"
          src={background.imageUrl}
          alt=""
          draggable={false}
          decoding="async"
          className="h-full w-full object-cover"
        />
      )}
      {slotSrc && (
        <UserUiFrame
          src={slotSrc}
          title="Background"
          testId="user-ui-slot-background"
          className="absolute inset-0 h-full w-full"
        />
      )}
    </div>
  );
}

interface UserUiAppBackdropProps {
  /** True once the current agent has at least one USER message. */
  hasUserMessage: boolean;
  /** The app's own background classes (applied here only while a backdrop shows). */
  appBackgroundClassName: string;
  children: ReactNode;
}

export function UserUiAppBackdrop({
  hasUserMessage,
  appBackgroundClassName,
  children,
}: UserUiAppBackdropProps) {
  const { background } = useUserUi();
  const opacity = backdropOpacity(background?.fadeOpacity ?? null, hasUserMessage);
  return (
    <div
      data-testid="app-background-layer"
      data-backdrop-state={background ? (opacity < 1 ? 'faded' : 'opaque') : 'stock'}
      className={cn(
        'pointer-events-none absolute inset-0',
        background && appBackgroundClassName,
        background && 'motion-reduce:transition-none',
      )}
      style={
        background
          ? {
              opacity,
              transition: `opacity ${BACKGROUND_FADE_TRANSITION_MS}ms ease`,
              willChange: 'opacity',
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}
