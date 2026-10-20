/**
 * STATE MACHINE: UserUiSlot / UserUiShell
 *
 * UserUiSlot(name):
 *   slot not published / safe mode → nothing (stock layout unchanged)
 *   slot published                 → sandboxed frame mounted in place
 *     autoHeight  → height follows rose:resize (clamped 60..900px)
 *     !autoHeight → fills its container
 *
 * UserUiShell:
 *   no shell / safe mode → children (stock app chrome)
 *   shell published      → full-viewport frame INSTEAD of the app chrome;
 *                          SafeModeControl (rendered by the provider) stays above
 */
import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { clampInlineHeight, INLINE_VIEW_MIN_HEIGHT } from '../config';
import { useUserUi } from '../hooks';
import type { UserUiSlotName } from '../types';
import { UserUiFrame } from './UserUiFrame';

interface UserUiSlotProps {
  name: Exclude<UserUiSlotName, 'background'>;
  className?: string;
  autoHeight?: boolean;
}

export function UserUiSlot({ name, className, autoHeight = false }: UserUiSlotProps) {
  const { slotUrl } = useUserUi();
  const [height, setHeight] = useState(INLINE_VIEW_MIN_HEIGHT);
  const src = slotUrl(name);
  if (!src) return null;
  return (
    <div data-testid={`user-ui-slot-${name}`} data-user-ui-slot={name} className={className}>
      <UserUiFrame
        src={src}
        title={`Custom ${name}`}
        onResize={autoHeight ? (next) => setHeight(clampInlineHeight(next)) : undefined}
        className={cn('block w-full', !autoHeight && 'h-full')}
        style={autoHeight ? { height } : undefined}
      />
    </div>
  );
}

export function UserUiShell({ children }: { children: ReactNode }) {
  const { shellUrl } = useUserUi();
  if (!shellUrl) return <>{children}</>;
  return (
    <div
      data-testid="user-ui-shell"
      className="fixed inset-0 h-screen w-screen bg-background"
      style={{ height: '100dvh' }}
    >
      <UserUiFrame
        src={shellUrl}
        title="Rose"
        testId="user-ui-shell-frame"
        className="block h-full w-full"
      />
    </div>
  );
}
