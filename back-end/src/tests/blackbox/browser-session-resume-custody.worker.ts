/** Independent process: production resume boundary; only native/CDP effects are fixtures. */
import Module from 'node:module';
const { createRequire } = Module;
import path from 'node:path';
const providerPath = path.resolve(__dirname, '../../providers/browser/browserUse.ts');
const resumePath = path.resolve(__dirname, '../../providers/browserSessionResume.ts');
const kernelPath = path.resolve(__dirname, '../../providers/browser/kernel.ts');
const recoveryPath = path.resolve(__dirname, '../../providers/browser/resumeRecovery.ts');
const local = createRequire(providerPath);
const { prisma } = local('../database');
const original = Module._load;
const api = process.env.BROWSER_USE_API_BASE_URL;
const browser = {
  contexts: () => [
    {
      storageState: async () => ({ cookies: [], origins: [] }),
      pages: () => [{ goto: async () => {}, close: async () => {} }],
      newPage: async () => ({ goto: async () => {}, close: async () => {} }),
    },
  ],
  close: async () => {},
};
async function request(endpoint, init = {}) {
  const res = await fetch(api + endpoint, init);
  if (!res.ok) throw new Error('fixture native failure');
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
    if (id === 'playwright') return { chromium: { connectOverCDP: async () => browser } };
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
    const result = await local(resumePath).resumeBrowserSession(process.argv[2], {
      forceFreshProfile: process.env.CUSTODY_FRESH === '1',
    });
    process.send?.({ ok: true, sessionId: result.session_id, pid: process.pid });
  } catch (error) {
    process.send?.({ ok: false, error: error.message, pid: process.pid });
  } finally {
    await prisma.$disconnect();
  }
})();
