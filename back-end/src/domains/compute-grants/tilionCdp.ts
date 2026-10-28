/**
 * Tilion browser for the compute-grants connect flow and minter.
 *
 * Tilion allows ONE CDP client per session, so the create-time validation
 * socket is closed before the connect/mint CDP client (cdp.ts) attaches.
 * The live view is minted fresh (view tokens last 1800 s) and is a viewer,
 * so it never competes for the CDP slot.
 */
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import {
  createTilionRecoverySession,
  getTilionLiveViewUrl,
  releaseTilionRemoteSession,
} from '../../providers/browser/tilion';
import type { CdpProvider } from './minter';

const log = createLogger('ComputeGrants');

export async function openTilionCdpSession(label: string) {
  const session = await createTilionRecoverySession(DEFAULT_GEOLOCATION);
  let released = false;
  const release = async () => {
    if (released) return;
    await releaseTilionRemoteSession(session.sessionId);
    released = true;
  };
  try {
    await session.validationBrowser?.close().catch(() => {});
    const liveViewUrl = await getTilionLiveViewUrl(session.sessionId);
    log.info('grant.browser_session_open', {
      provider: 'tilion',
      session_id: session.sessionId,
      label,
    });
    return { cdpBase: session.wsUrl, liveViewUrl, sessionId: session.sessionId, release };
  } catch (error) {
    // A session that never reached the caller has no other owner to release it.
    await release().catch(() => undefined);
    throw error;
  }
}

export function tilionCdpProvider(): CdpProvider {
  return {
    async open() {
      const session = await openTilionCdpSession('mint');
      return { cdpBase: session.cdpBase, release: session.release };
    },
  };
}
