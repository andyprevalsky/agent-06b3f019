/** Test harness: a published user background behind a stock app backdrop. */
import { UserUiAppBackdrop, UserUiBackgroundLayer, UserUiProvider } from '@/features/user-ui';

export function BackdropHarness({ hasUserMessage }: { hasUserMessage: boolean }) {
  return (
    <UserUiProvider userId="test-user">
      <UserUiBackgroundLayer />
      <UserUiAppBackdrop hasUserMessage={hasUserMessage} appBackgroundClassName="bg-background">
        <svg data-testid="pattern" />
      </UserUiAppBackdrop>
    </UserUiProvider>
  );
}
