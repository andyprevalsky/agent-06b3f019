/** Checkpoint and retire an exact logical binding under its existing task owner. */
import { withSteelLifecycleClaim } from '../steel/lifecycleClaim';
import { checkpointLogicalBrowser } from './checkpoint';

export async function withLogicalBrowserPause<T>(
  logical: { id: string; logicalOwnerKey: string | null } | null,
  sessionId: string,
  pause: boolean,
  perform: (providerPause: boolean) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!pause || !logical?.logicalOwnerKey) return perform(pause);
  signal?.throwIfAborted();
  return withSteelLifecycleClaim(logical.id, async (assertOwned, _native, mutate) => {
    await assertOwned();
    await mutate(async (tx) => {
      const changed = await tx.browserSession.updateMany({
        where: {
          id: logical.id,
          sessionId,
          status: 'ACTIVE',
          OR: [{ controlState: 'AGENT' }, { controlLeaseExpiresAt: { lte: new Date() } }],
        },
        data: { status: 'PAUSED' },
      });
      if (changed.count !== 1) throw new Error('Logical browser pause ownership changed');
    });
    try {
      await checkpointLogicalBrowser(sessionId, mutate, signal);
      signal?.throwIfAborted();
    } catch (error) {
      await mutate((tx) =>
        tx.browserSession.updateMany({
          where: { id: logical.id, sessionId, status: 'PAUSED' },
          data: { status: 'ACTIVE' },
        })
      );
      throw error;
    }
    await assertOwned();
    let result: T;
    try {
      result = await perform(false);
    } catch (error) {
      await mutate((tx) =>
        tx.browserSession.updateMany({
          where: { id: logical.id, sessionId },
          data: { status: 'ERROR', closedAt: null },
        })
      );
      throw error;
    }
    await mutate(async (tx) => {
      const changed = await tx.browserSession.updateMany({
        where: { id: logical.id, sessionId },
        data: { status: 'PAUSED', closedAt: null },
      });
      if (changed.count !== 1) throw new Error('Logical browser changed during pause');
    });
    return result;
  });
}
