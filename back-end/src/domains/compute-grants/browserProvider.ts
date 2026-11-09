/**
 * Remote-browser selection for the compute-grants domain.
 *
 * Tilion is the fresh-session default. Other providers stay selectable via
 * `COMPUTE_GRANT_BROWSER_PROVIDER` so a provider outage does not block
 * account connect or grant recovery -- the two paths that, when broken, silently
 * push every request onto paid models.
 *
 * Selection lives here rather than at each call site so the connect flow and the
 * minter can never diverge onto different providers: a session captured on one
 * provider must be replayable by the other, and mixing them is how a working
 * connect produces grants that fail to mint.
 */

import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import type { CdpProvider } from './minter';
import { kernelCdpProvider, computeGrantBrowserProvider, openKernelCdpSession } from './kernelCdp';
import { steelCdpProvider } from './steelCdp';
import { browserUseCdpProvider, openBrowserUseCdpSession } from './browserUseCdp';
import { openTilionCdpSession, tilionCdpProvider } from './tilionCdp';

export { computeGrantBrowserProvider };

/** CdpProvider for minting, honouring the configured provider. */
export function computeGrantCdpProvider(): CdpProvider {
  const provider = computeGrantBrowserProvider();
  if (provider === 'tilion') return tilionCdpProvider();
  return provider === 'steel'
    ? steelCdpProvider()
    : provider === 'browser-use'
      ? browserUseCdpProvider()
      : kernelCdpProvider();
}

export interface ComputeGrantBrowser {
  cdpBase: string;
  /** INTERACTIVE live view (never read-only) -- the user types their credentials here. */
  liveViewUrl: string;
  sessionId: string;
  release: () => Promise<void>;
}

/**
 * Open a remote browser for the connect flow, on the configured provider.
 *
 * Returns the same shape for all providers so the connect flow has no
 * provider-specific branches: all providers must stay interchangeable because a
 * session captured on one can be replayed by another during minting.
 */
export async function openComputeGrantBrowser(label: string): Promise<ComputeGrantBrowser> {
  if (computeGrantBrowserProvider() === 'browser-use') return openBrowserUseCdpSession(label);
  if (computeGrantBrowserProvider() === 'tilion') return openTilionCdpSession(label);
  if (computeGrantBrowserProvider() === 'steel') {
    const [{ createSteelRecoverySession }, { releaseSteelRemoteSession }] = await Promise.all([
      import('../../providers/steel/sessionRecovery'),
      import('../../providers/steel/session'),
    ]);
    const s = await createSteelRecoverySession({
      proxyLocation: DEFAULT_GEOLOCATION,
      proxyMode: 'managed',
    });
    let released = false;
    return {
      cdpBase: s.wsUrl,
      liveViewUrl: s.debugUrl ?? '',
      sessionId: s.sessionId,
      release: async () => {
        if (released) return;
        released = true;
        await releaseSteelRemoteSession(s.sessionId).catch(() => undefined);
      },
    };
  }
  return openKernelCdpSession(label);
}
