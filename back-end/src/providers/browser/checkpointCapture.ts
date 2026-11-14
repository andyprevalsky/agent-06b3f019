/** Exact temporary-target and CDP custody for one private checkpoint capture. */
import type { Browser, CDPSession, Page } from 'playwright';

export type CapturePages = {
  create(create: () => Promise<Page>): Promise<Page>;
  close(page: Page): Promise<void>;
  session(create: () => Promise<CDPSession>): Promise<CDPSession>;
  detach(session: CDPSession): Promise<void>;
};

export function checkpointCaptureOwner(browser: Browser, signal?: AbortSignal) {
  const ownedPages = new Set<Promise<Page>>();
  const pageCloses = new Map<Page, Promise<void>>();
  const pendingSessions = new Set<Promise<CDPSession>>();
  const sessions = new Map<
    CDPSession,
    {
      closed: boolean;
      ended: Promise<void>;
      detach?: Promise<void>;
    }
  >();
  const pages: CapturePages = {
    session(create) {
      signal?.throwIfAborted();
      if (!signal) return create();
      const pending = create().then((session) => {
        let end!: () => void;
        const held = {
          closed: false,
          ended: new Promise<void>((resolve) => {
            end = resolve;
          }),
        };
        session.once('close', () => {
          held.closed = true;
          end();
        });
        sessions.set(session, held);
        return session;
      });
      pendingSessions.add(pending);
      return pending.then((session) => {
        signal.throwIfAborted();
        return session;
      });
    },
    detach(session) {
      const held = sessions.get(session);
      if (!held) return session.detach();
      if (held.closed) return Promise.resolve();
      held.detach ??= (async () => {
        try {
          // Target closure can precede the SDK's detach response indefinitely.
          // The exact session's close event proves retirement without a timer.
          await Promise.race([session.detach(), held.ended]);
        } catch (error) {
          if (!held.closed) await held.ended;
          throw error;
        }
      })();
      return held.detach;
    },
    create(create) {
      signal?.throwIfAborted();
      const pending = create();
      ownedPages.add(pending);
      return pending.then((page) => {
        signal?.throwIfAborted();
        return page;
      });
    },
    close(page) {
      let closing = pageCloses.get(page);
      if (!closing) {
        closing = (async () => {
          try {
            await page.close();
          } catch (error) {
            if (!page.isClosed())
              await new Promise<void>((resolve) => page.once('close', () => resolve()));
            throw error;
          }
        })();
        pageCloses.set(page, closing);
      }
      return closing;
    },
  };
  let storageCapture: Promise<unknown> | undefined;
  // Closing a connected-over-CDP client disconnects only this capture transport.
  // Join that same close in finally before the lifecycle owner can be released.
  let closing: Promise<void> | undefined;
  const disconnect = () => {
    closing ??= (async () => {
      // Retain the transport until all exact scratch targets are gone. The SDK
      // can create hidden storageState targets; its own work must settle while
      // still connected so its finally can retire those targets too.
      const created = await Promise.allSettled(ownedPages);
      const attached = await Promise.allSettled(pendingSessions);
      const closed = await Promise.allSettled([
        ...attached.flatMap((result) =>
          result.status === 'fulfilled' ? [pages.detach(result.value)] : []
        ),
        ...created.flatMap((result) =>
          result.status === 'fulfilled' ? [pages.close(result.value)] : []
        ),
      ]);
      await storageCapture?.catch(() => undefined);
      try {
        await browser.close();
      } catch (error) {
        // A failed close is not proof that the capture transport is gone.
        if (browser.isConnected())
          await new Promise<void>((resolve) => browser.once('disconnected', () => resolve()));
        throw error;
      }
      const failedClose = closed.find((result) => result.status === 'rejected');
      if (failedClose?.status === 'rejected') throw failedClose.reason;
    })();
    return closing;
  };
  const onAbort = () => {
    void disconnect().catch(() => {
      // The owner below joins this rejection; never detach cleanup from custody.
    });
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    pages,
    storage<T>(capture: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      const pending = capture();
      storageCapture = pending;
      return pending;
    },
    async dispose(): Promise<void> {
      signal?.removeEventListener('abort', onAbort);
      await disconnect();
      signal?.throwIfAborted();
    },
  };
}
