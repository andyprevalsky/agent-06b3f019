import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import {
  createBrowserUseRecoverySession,
  releaseBrowserUseRemoteSession,
} from '../../providers/browser/browserUse';
import type { CdpProvider } from './minter';

export async function openBrowserUseCdpSession(_label: string) {
  const session = await createBrowserUseRecoverySession(DEFAULT_GEOLOCATION);
  await session.validationBrowser.close().catch(() => {});
  let released = false;
  return {
    cdpBase: session.wsUrl,
    liveViewUrl: session.debugUrl,
    sessionId: session.sessionId,
    release: async () => {
      if (released) return;
      await releaseBrowserUseRemoteSession(session.sessionId);
      released = true;
    },
  };
}

export function browserUseCdpProvider(): CdpProvider {
  return {
    async open() {
      const session = await openBrowserUseCdpSession('mint');
      return { cdpBase: session.cdpBase, release: session.release };
    },
  };
}
