#!/usr/bin/env tsx

/**
 * Live leg: a cached managed proxy is deleted between pause and resume.
 *
 * Geo proxies are shared by name across the Kernel project, so prod sessions and
 * concurrent runs hold the same cached ID and any of them can lose it. Resume
 * must re-provision the same geo instead of downgrading city → state. The proxy
 * deleted here is a uniquely named one this leg created, so no other run or
 * prod session can have resolved it.
 */

import { randomUUID } from 'node:crypto';
import type Kernel from '@onkernel/sdk';
import {
  KERNEL_CREATE_REQUEST_OPTIONS,
  kernelProxyCandidates,
} from '../../providers/browser/kernelProxy';
import { prisma } from '../../providers/database';
import type { ProxyGeoLocation } from '../../providers/geoip';
import {
  assert,
  type BrowserApiResponse,
  type BrowserMetadataResponse,
} from './browser-provider.helpers';

export async function assertResumeReprovisionsDeletedProxy(options: {
  kernel: Kernel;
  taskId: string;
  sessionId: string;
  agentLocation: ProxyGeoLocation;
  proxySource: string | undefined;
  proxyLocation: BrowserMetadataResponse['proxy_location'];
  post: (path: string, body?: unknown) => Promise<BrowserApiResponse>;
}): Promise<string> {
  const { kernel, taskId, sessionId, agentLocation, proxySource, proxyLocation, post } = options;
  const candidate = kernelProxyCandidates(agentLocation).find((c) => c.source === proxySource);
  assert(candidate !== undefined, `no managed proxy candidate for source ${String(proxySource)}`);

  const doomed = await kernel.proxies.create(
    {
      type: candidate.type,
      name: `rose-blackbox-stale-${randomUUID()}`,
      config: candidate.config,
    },
    KERNEL_CREATE_REQUEST_OPTIONS
  );
  const key = { provider: 'kernel', proxyKey: candidate.proxyKey };
  let doomedDeleted = false;
  try {
    await prisma.browserProviderProxy.upsert({
      where: { provider_proxyKey: key },
      create: { ...key, proxyId: doomed.id, proxyType: candidate.type, config: candidate.config },
      update: { proxyId: doomed.id },
    });
    await post('/close', {
      session_id: sessionId,
      pause: true,
      current_url: 'https://example.com/stale-proxy-check',
    });
    await kernel.proxies.delete(doomed.id);
    doomedDeleted = true;

    const resumed = await post('/resume', { task_id: taskId });
    const resumedId = String(resumed.session_id);
    const metadata = resumed.browser_session_metadata ?? {};
    assert(
      metadata.proxy_source === proxySource &&
        JSON.stringify(metadata.proxy_location) === JSON.stringify(proxyLocation),
      `resume after a deleted cached proxy downgraded ${String(proxySource)} to ${String(
        metadata.proxy_source
      )}`
    );
    const remote = await kernel.browsers.retrieve(resumedId, { include_deleted: true });
    assert(
      remote.proxy_id !== undefined && remote.proxy_id !== null && remote.proxy_id !== doomed.id,
      'resume reused the deleted proxy ID'
    );
    const cached = await prisma.browserProviderProxy.findUnique({
      where: { provider_proxyKey: key },
    });
    assert(cached?.proxyId === remote.proxy_id, 'the stale cache row was not replaced');
    return resumedId;
  } finally {
    if (!doomedDeleted) await kernel.proxies.delete(doomed.id).catch(() => {});
    await prisma.browserProviderProxy.deleteMany({
      where: { provider: 'kernel', proxyId: doomed.id },
    });
  }
}
