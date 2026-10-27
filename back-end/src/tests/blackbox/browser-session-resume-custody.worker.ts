/** Independent process: production resume boundary; only native/CDP effects are fixtures. */
import Module from 'node:module';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
const { createRequire } = Module;
import path from 'node:path';
const providerPath = path.resolve(__dirname, '../../providers/browser/browserUse.ts');
const resumePath = path.resolve(__dirname, '../../providers/browserSessionResume.ts');
const kernelPath = path.resolve(__dirname, '../../providers/browser/kernel.ts');
const checkpointPath = path.resolve(__dirname, '../../providers/browser/checkpoint.ts');
const indexPath = path.resolve(__dirname, '../../providers/browser/index.ts');
const recoveryPath = path.resolve(__dirname, '../../providers/browser/resumeRecovery.ts');
const local = createRequire(providerPath);
const { prisma } = local('../database');
if (process.env.CUSTODY_OBSERVE_ACTIVE === '1') {
  const findUnique = prisma.toolSideEffect.findUnique.bind(prisma.toolSideEffect);
  let observed = false;
  prisma.toolSideEffect.findUnique = async (query: unknown) => {
    const row = await findUnique(query);
    if (
      !observed &&
      row?.operationKey === `steel-browser-task-lifecycle:${process.argv[2]}` &&
      row.operationType === 'browser_task_resume' &&
      row.status === 'STARTED' &&
      row.request?.phase === 'creating'
    ) {
      observed = true;
      process.send?.({ custodyObserved: row.operationKey, pid: process.pid });
    }
    return row;
  };
}

const original = Module._load;
const api = process.env.BROWSER_USE_API_BASE_URL;
const browser = {
  contexts: () => [
    {
      storageState: async () => ({ cookies: [], origins: [] }),
      setStorageState: async () => request('/restore', { method: 'POST' }),
      pages: () => [{ url: () => 'about:blank', goto: async () => {}, close: async () => {} }],
      newPage: async () => ({
        url: () => 'about:blank',
        goto: async () => {},
        close: async () => {},
      }),
    },
  ],
  close: async () => {},
};
// Cover both require() and import(): native/CDP effects are fixture-owned.
const playwright = { chromium: { connectOverCDP: async () => browser } };
mock.module('playwright', { namedExports: playwright });
async function request(endpoint, init = {}) {
  const res = await fetch(api + endpoint, init);
  // Mirror the provider SDKs: an HTTP rejection carries its status.
  if (!res.ok) throw Object.assign(new Error('fixture native failure'), { status: res.status });
  return res.json();
}
const kernel = {
  browsers: {
    create: (body) => request('/kernel/browsers', { method: 'POST', body: JSON.stringify(body) }),
    retrieve: (id) => request('/kernel/browsers/' + id),
    list: async function* (query) {
      for (const row of await request('/kernel/browsers?' + new URLSearchParams(query.tags)))
        yield row;
    },
  },
};
Module._load = function (id, parent, isMain) {
  if (parent?.filename === indexPath && id === './sessionAuthPersist')
    return { persistSignedInBrowserState: () => request('/legacy-harvest') };
  if (parent?.filename === indexPath && id === './worldState')
    return { mergeSessionWorldState: () => request('/legacy-harvest') };
  if (parent?.filename === checkpointPath && id === '../steel/sessionConnection')
    return { connectValidatedBrowser: async () => browser };
  if (parent?.filename === resumePath && id === './browser')
    return {
      resumeSession: async (taskId, options) => {
        const result = await (process.env.CUSTODY_PROVIDER === 'kernel'
          ? local(kernelPath).resumeKernelSession(taskId, {
              ...options,
              keepValidationConnection: true,
            })
          : local(providerPath).resumeBrowserUseSession(taskId, {
              ...options,
              keepValidationConnection: true,
            }));
        if (process.env.CUSTODY_STALE === '1')
          await prisma.browserSession.update({
            where: { id: taskId },
            data: { sessionId: 'competing-binding-' + taskId },
          });
        return result;
      },
      getBrowserSessionHealth: async () => request('/health'),
      injectUserData: async () => {
        await request('/hydrate', { method: 'POST' });
        return {
          cookies: { injected: 0, cookieCount: 0, authSource: null, credentialRef: null },
          fingerprint: { injected: false },
        };
      },
      closeSession: async (id) => request('/cleanup/' + id, { method: 'DELETE' }),
      getFingerprintInjectionData: async () => null,
    };
  if ([providerPath, kernelPath].includes(parent?.filename)) {
    if (id === 'playwright') return playwright;
    if (id === '../steel/sessionConnection')
      return { connectValidatedBrowser: async () => browser };
    if (id === './context') return { getProviderProfile: async () => 'fixture-profile' };
    if (id === './sessionBindingAnnounce') return { announceBrowserSessionBinding: async () => {} };
    if (id === './kernelSessionIo') return { ensureKernelSessionFileDirectories: async () => {} };
    if (id === './kernelSessionDelete')
      return {
        releaseKernelRemoteSession: (id) => request('/kernel/browsers/' + id, { method: 'DELETE' }),
      };
    if (id === './captchaSolveIndicator') return { installCaptchaSolveIndicator: async () => {} };
  }
  if ([kernelPath, recoveryPath].includes(parent?.filename) && id === './kernelClient')
    return { kernelClient: () => kernel };
  return original.call(this, id, parent, isMain);
};
(async () => {
  try {
    assert.ok(
      (await import('playwright')).chromium === playwright.chromium,
      'custody fixture must own Playwright ESM as well as CommonJS'
    );
    const result = await local(resumePath).resumeBrowserSession(process.argv[2], {
      forceFreshProfile: process.env.CUSTODY_FRESH === '1',
    });
    if (process.env.CUSTODY_LOGICAL_PAUSE === '1')
      await local(indexPath).closeSession(result.session_id, true);
    const state = await prisma.browserSession.findUniqueOrThrow({ where: { id: process.argv[2] } });
    process.send?.({
      ok: true,
      sessionId: result.session_id,
      status: state.status,
      pid: process.pid,
    });
  } catch (error) {
    process.send?.({ ok: false, error: error.message, pid: process.pid });
  } finally {
    await prisma.$disconnect();
  }
})();
