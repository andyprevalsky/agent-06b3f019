#!/usr/bin/env tsx

/** Live proxy custody: reuse the existing shared geo proxy without allocating or deleting one.
 * Deleted-cache recovery is covered deterministically in kernel-stale-cache.support.ts.
 */
import nodeAssert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestError, InternalServerError, type Kernel } from '@onkernel/sdk';
import {
  KERNEL_CREATE_REQUEST_OPTIONS,
  type KernelProxyCandidate,
  kernelProxyCandidates,
  managedKernelProxyFromSource,
} from '../../providers/browser/kernelProxy';
import { prisma } from '../../providers/database';
import type { ProxyGeoLocation } from '../../providers/geoip';
import { retryWithBackoff } from '../../providers/retry';
import {
  assert,
  type BrowserApiResponse,
  type BrowserMetadataResponse,
} from './browser-provider.helpers';

export async function assertResumeReusesExistingProxy(options: {
  kernel: Kernel;
  taskId: string;
  sessionId: string;
  proxySource: string | undefined;
  proxyLocation: BrowserMetadataResponse['proxy_location'];
  post: (path: string, body?: unknown) => Promise<BrowserApiResponse>;
}): Promise<string> {
  const { kernel, taskId, sessionId, proxySource, proxyLocation, post } = options;
  const before = await kernel.browsers.retrieve(sessionId, { include_deleted: true });
  assert(
    typeof before.proxy_id === 'string' && before.proxy_id !== '',
    'live browser must name its existing proxy'
  );
  await post('/close', {
    session_id: sessionId,
    pause: true,
    current_url: 'https://example.com/proxy-reuse-check',
  });
  const resumed = await post('/resume', { task_id: taskId });
  const resumedId = String(resumed.session_id);
  try {
    const metadata = resumed.browser_session_metadata ?? {};
    assert(
      metadata.proxy_source === proxySource &&
        JSON.stringify(metadata.proxy_location) === JSON.stringify(proxyLocation),
      'resume changed the existing proxy tier or location'
    );
    const after = await kernel.browsers.retrieve(resumedId, { include_deleted: true });
    assert(after.proxy_id === before.proxy_id, 'resume must reuse the existing shared proxy');
  } catch (error) {
    // The caller cannot learn this replacement ID on a failed assertion.
    // Close only the exact browser created by this leg; shared proxies stay intact.
    await post('/close', { session_id: resumedId, pause: false }).catch(() => {});
    throw error;
  }
  return resumedId;
}

/**
 * The parity FAIL line prints only `error.message`, and a bare Kernel SDK error
 * (`400 proxy configuration validation failed: …`) names neither the call that
 * made it nor the proxy tier/config Kernel was validating. Attributing such a
 * line took an hour of backend-log forensics on 2026-10-28 (Kernel's mobile
 * proxy vendor answered 403; residential creates were fine). Label the
 * throwaway create at its throw site so the next FAIL line is self-diagnosing;
 * the original SDK error stays attached as `cause`.
 */
function labelThrowawayCreateFailure(candidate: KernelProxyCandidate, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `stale-proxy leg: Kernel proxies.create(${candidate.type} ${JSON.stringify(
      candidate.config
    )}) rejected: ${detail}`,
    { cause: error }
  );
}

// Only the fake-SDK diagnostic below calls this helper. Live parity uses
// assertResumeReusesExistingProxy and never creates or deletes shared proxies.
async function assertResumeReprovisionsDeletedProxy(options: {
  kernel: Kernel;
  taskId: string;
  sessionId: string;
  proxySource: string | undefined;
  proxyLocation: BrowserMetadataResponse['proxy_location'];
  post: (path: string, body?: unknown) => Promise<BrowserApiResponse>;
}): Promise<string> {
  const { kernel, taskId, sessionId, proxySource, proxyLocation, post } = options;
  const mode = managedKernelProxyFromSource(proxySource ?? null);
  assert(mode !== undefined, `no managed proxy mode for source ${String(proxySource)}`);
  // The cached row to poison is the one for the proxy the session actually
  // uses. After a rotation that is another US state than the agent's own, so
  // the key comes from the session's reported location, not the agent's.
  assert(
    proxyLocation !== undefined && typeof proxyLocation.country === 'string',
    `session reported no proxy location: ${JSON.stringify(proxyLocation)}`
  );
  const sessionLocation: ProxyGeoLocation = {
    country: proxyLocation.country,
    ...(proxyLocation.state ? { state: proxyLocation.state } : {}),
    ...(proxyLocation.city ? { city: proxyLocation.city } : {}),
  };
  const candidate = kernelProxyCandidates(sessionLocation, mode.type).find(
    (c) => c.source === proxySource
  );
  assert(candidate !== undefined, `no managed proxy candidate for source ${String(proxySource)}`);

  // Kernel intermittently answers a valid proxy create with `500 failed to
  // apply proxy config`; only that provider-side 5xx is retried.
  const doomed = await retryWithBackoff(
    () =>
      kernel.proxies.create(
        {
          type: candidate.type,
          name: `rose-blackbox-stale-${randomUUID()}`,
          config: candidate.config,
        },
        KERNEL_CREATE_REQUEST_OPTIONS
      ),
    {
      maxRetries: 3,
      fixedDelays: [1_000, 2_000],
      isRetryable: (error) => error instanceof InternalServerError,
      component: 'browser-provider:stale-proxy-create',
    }
  ).catch((error: unknown) => {
    throw labelThrowawayCreateFailure(candidate, error);
  });
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

/**
 * Offline regression: a rejected throwaway create surfaces the call, tier,
 * config and the exact Kernel body, is not retried (4xx), keeps the SDK error
 * as `cause`, and happens before any backend call (nothing to clean up).
 */
export async function assertStaleProxyCreateFailureIsLabeled(): Promise<void> {
  const kernelBody = {
    code: 'validation_error',
    message:
      'proxy configuration validation failed: failed to validate country: pingproxy: unexpected status 403: You do not have permission to perform this action.',
  };
  const creates: Array<{ type?: string; config?: unknown }> = [];
  const kernel = {
    proxies: {
      create: async (body: { type?: string; config?: unknown }) => {
        creates.push(body);
        throw new BadRequestError(400, kernelBody, kernelBody.message, new Headers());
      },
      delete: async () => {
        throw new Error('proxies.delete must not run when the create failed');
      },
    },
    browsers: {
      retrieve: async () => {
        throw new Error('browsers.retrieve must not run when the create failed');
      },
    },
  } as unknown as Kernel;
  const backendCalls: string[] = [];
  await nodeAssert.rejects(
    assertResumeReprovisionsDeletedProxy({
      kernel,
      taskId: randomUUID(),
      sessionId: 'kernel-session-never-paused',
      proxySource: 'kernel_mobile_state',
      proxyLocation: { country: 'US', state: 'IL' },
      post: async (path) => {
        backendCalls.push(path);
        return {} as BrowserApiResponse;
      },
    }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const fragment of [
        'stale-proxy leg',
        'proxies.create',
        'mobile {"country":"US","state":"IL"}',
        `400 ${kernelBody.message}`,
      ]) {
        assert(
          message.includes(fragment),
          `labelled failure lacks ${JSON.stringify(fragment)}: ${message}`
        );
      }
      assert(
        error instanceof Error && error.cause instanceof BadRequestError,
        'the original Kernel SDK error must be preserved as cause'
      );
      return true;
    }
  );
  assert(
    creates.length === 1 && creates[0]?.type === 'mobile',
    `a Kernel 4xx must not be retried (creates=${creates.length})`
  );
  assert(
    backendCalls.length === 0,
    `no backend call may precede the throwaway create: ${backendCalls.join(',')}`
  );
}
