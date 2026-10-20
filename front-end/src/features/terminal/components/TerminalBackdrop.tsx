/**
 * STATE MACHINE: TerminalBackdrop
 *
 * Layers behind the terminal content, back to front:
 *   [USER BACKGROUND] fixed per-user image / background slot (absent in stock
 *                     UI and safe mode)
 *   [APP BACKDROP]    app background colour + BackgroundPattern grid/canvas
 *
 *   no per-user background            → APP BACKDROP renders exactly as stock
 *   per-user background, no USER msg  → APP BACKDROP fully opaque
 *   per-user background, >=1 USER msg → APP BACKDROP fades to the theme's
 *                                       fadeAfterFirstMessage (600ms opacity)
 */
import type { ComponentProps } from 'react';

import { UserUiAppBackdrop, UserUiBackgroundLayer } from '@/features/user-ui';

import { BackgroundPattern } from './BackgroundPattern';

type TerminalBackdropProps = ComponentProps<typeof BackgroundPattern> & {
  hasUserMessage: boolean;
};

export function TerminalBackdrop({ hasUserMessage, ...patternProps }: TerminalBackdropProps) {
  return (
    <>
      <UserUiBackgroundLayer />
      <UserUiAppBackdrop
        hasUserMessage={hasUserMessage}
        appBackgroundClassName="bg-background dark:bg-navi-black"
      >
        <BackgroundPattern {...patternProps} />
      </UserUiAppBackdrop>
    </>
  );
}
