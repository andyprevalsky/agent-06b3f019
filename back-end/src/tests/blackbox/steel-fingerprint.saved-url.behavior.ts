import { navigateToSavedUrl } from '../../providers/steel/sessionResume';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export async function testSavedUrlNavigationAlwaysClosesBrowser(): Promise<void> {
  let closeCount = 0;
  const browser = {
    contexts: () => [
      {
        pages: () => [
          {
            goto: async () => {
              throw new Error('navigation timeout');
            },
          },
        ],
        newPage: async () => {
          throw new Error('unexpected new page');
        },
      },
    ],
    close: async () => {
      closeCount += 1;
    },
  };

  await navigateToSavedUrl(
    'wss://connect.steel.dev?sessionId=session-1',
    'https://example.com/saved',
    async () => browser as unknown as import('playwright').Browser
  );
  assert(closeCount === 1, `failed saved-URL navigation closed browser ${closeCount} times`);
}
