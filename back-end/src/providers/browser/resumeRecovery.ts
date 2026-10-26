import type { BrowserSession } from '@prisma/client';
import { browserUseEnabled } from './config';
import type { ProxyGeoLocation } from '../geoip';
import { browserResumeScope, resumeNativeCreate } from '../steel/lifecycleClaim';
/** Read-only native lookup by the locator durably recorded before POST. */
import { randomUUID } from 'node:crypto';
import { kernelClient } from './kernelClient';
import { request } from './browserUseClient';

export async function inspectResumeCandidate(provider: string, marker: string, identity: string) {
  if (provider === 'kernel') {
    const matches = [];
    for await (const browser of kernelClient().browsers.list(
      {
        status: 'all',
        tags: {
          rose_session_request: marker,
          rose_lifecycle_owner: identity,
        },
      },
      { maxRetries: 0 }
    )) {
      if (
        browser.tags?.rose_session_request === marker &&
        browser.tags?.rose_lifecycle_owner === identity
      ) {
        matches.push({ id: browser.session_id, status: browser.deleted_at ? 'stopped' : 'active' });
      }
      if (matches.length > 1)
        throw new Error('Browser resume locator matched multiple native sessions');
    }
    return matches[0] ?? null;
  }
  if (provider === 'browser-use') {
    const query = new URLSearchParams({ pageSize: '100', pageNumber: '1' });
    query.append('metadata', `rose_session_request=${marker}`);
    query.append('metadata', `rose_lifecycle_owner=${identity}`);
    const list = await request<{
      items: Array<{ id: string; status: string; metadata?: Record<string, string> }>;
      totalItems: number;
    }>(`/browsers?${query}`);
    if (list.totalItems > 1)
      throw new Error('Browser resume locator matched multiple native sessions');
    const browser = list.items[0];
    if (
      !browser ||
      browser.metadata?.rose_session_request !== marker ||
      browser.metadata?.rose_lifecycle_owner !== identity
    )
      return null;
    return { id: browser.id, status: browser.status };
  }
  return null;
}

export function kernelResumeTags(
  agentId: string,
  intent?: { marker: string; ownershipIdentity: string }
) {
  return {
    rose_agent_id: agentId,
    rose_session_request: intent?.marker ?? randomUUID(),
    ...(intent ? { rose_lifecycle_owner: intent.ownershipIdentity } : {}),
  };
}

export type BrowserUseSession = {
  id: string;
  status: string;
  cdpUrl: string | null;
  liveUrl: string | null;
  startedAt: string;
  timeoutAt: string;
};

export async function allocateBrowserUseSession(
  location: ProxyGeoLocation,
  profileId: string | null
): Promise<BrowserUseSession> {
  if (!browserUseEnabled()) {
    throw new Error('Browser Use is disabled by BROWSER_AGENT_BROWSER_USE_ENABLED');
  }
  const resumeScope = browserResumeScope();
  const intent = await resumeScope?.beforeCreate('browser-use');
  const session = intent?.recoveredId
    ? await request<BrowserUseSession>(`/browsers/${encodeURIComponent(intent.recoveredId)}`)
    : await resumeNativeCreate(() =>
        request<BrowserUseSession>('/browsers', {
          method: 'POST',
          body: JSON.stringify({
            ...(profileId ? { profileId } : {}),
            ...(intent
              ? {
                  metadata: {
                    rose_session_request: intent.marker,
                    rose_lifecycle_owner: intent.ownershipIdentity,
                  },
                }
              : {}),
            proxyCountryCode: browserUseProxyCountry(location),
            timeout: 240,
            browserScreenWidth: 1280,
            browserScreenHeight: 800,
            solveCaptchas: true,
            enableRecording: true,
          }),
        })
      );
  return session;
}

export function browserUseProxyCountry(location: ProxyGeoLocation): string {
  // Browser Use's API enumerates UK, while the rest of Rose stores ISO GB.
  const raw = location.country.trim().toLowerCase();
  const country = raw === 'gb' ? 'uk' : raw;
  if (!/^[a-z]{2}$/.test(country)) {
    throw new Error(`Browser Use requires a two-letter proxy country, got ${location.country}`);
  }
  return country;
}

/** A retired logical row cannot be revived by a previously allocated native browser. */
export function replacementBinding(
  taskId: string,
  session: Pick<BrowserSession, 'sessionId' | 'status' | 'logicalOwnerKey'>
) {
  return {
    id: taskId,
    sessionId: session.sessionId,
    ...(session.logicalOwnerKey ? { status: session.status } : {}),
  };
}
