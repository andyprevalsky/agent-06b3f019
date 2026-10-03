import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';

export interface OriginPayloadTarget {
  writeOriginScript(origin: string, script: string): Promise<unknown>;
}

type BrowserOriginContext = Pick<BrowserContext, 'newPage' | 'newCDPSession'>;
export type OriginPayloadContext = BrowserOriginContext | OriginPayloadTarget;

/** Restore persistent storage without retaining payloads as per-document scripts. */
export function createOriginPayloadWriter(context: BrowserOriginContext, signal?: AbortSignal) {
  let page: Page | undefined;
  let opening: Promise<Page> | undefined;
  let closed = false;
  let navigationUrl = '';
  const checkOpen = () => {
    signal?.throwIfAborted();
    if (closed) throw new Error('Origin storage writer is closed');
  };
  const close = async () => {
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    // Close a known page immediately, including while its setup is pending.
    // If acquisition is still pending, the opening continuation closes it.
    if (page) await page.close();
    else await opening?.catch(() => undefined);
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  async function acquire(): Promise<Page> {
    checkOpen();
    opening ??= (async () => {
      const owned = await context.newPage();
      page = owned;
      try {
        checkOpen();
        await owned.route('**/*', async (route) => {
          const request = route.request();
          if (
            request.isNavigationRequest() &&
            request.frame() === owned.mainFrame() &&
            request.url() === navigationUrl
          ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
          } else {
            await route.abort();
          }
        });
        checkOpen();
        const cdp = await context.newCDPSession(owned);
        checkOpen();
        // A saved service worker must not replace our synthetic document.
        // The page owns this CDP session and retires it when it closes.
        await cdp.send('Network.setBypassServiceWorker', { bypass: true });
        checkOpen();
        return owned;
      } catch (error) {
        await owned.close().catch(() => {});
        throw error;
      }
    })();
    return opening;
  }

  return {
    async writeOriginScript(origin: string, script: string): Promise<unknown> {
      checkOpen();
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
        throw new Error('Origin storage requires an exact HTTP origin');
      }
      const owned = await acquire();
      checkOpen();
      if (new URL(owned.url()).origin !== origin) {
        navigationUrl = `${origin}/.rose-storage-${randomUUID()}`;
        await owned.goto(navigationUrl, { waitUntil: 'domcontentloaded' });
        checkOpen();
      }
      // The bounded script decodes only inside this exact-origin document.
      // Evaluation awaits its completion promise, including storage commits.
      return owned.evaluate(script);
    },
    close,
  };
}
