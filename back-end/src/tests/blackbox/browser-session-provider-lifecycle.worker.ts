/** Separate process exercising the shared production restore owner, with fixture-native I/O. */
import Module, { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
const local = createRequire(import.meta.url);
const taskId = process.argv[2]!;
const provider = process.argv[3]!;
const api = process.argv[4]!;
async function request(path: string, method = 'GET') {
  const response = await fetch(api + path, { method });
  if (!response.ok)
    throw Object.assign(new Error('native fixture rejected'), { status: response.status });
  return response.json();
}
const read = prisma.toolSideEffect.findUnique.bind(prisma.toolSideEffect);
prisma.toolSideEffect.findUnique = (async (args) => {
  const row = await read(args);
  if (row?.operationKey === `steel-browser-task-lifecycle:${taskId}` && row.status === 'STARTED')
    process.send?.({ type: 'joined' });
  return row;
}) as typeof read;
const original = Module._load;
Module._load = function (id, parent, isMain) {
  if (parent?.filename.endsWith('/browserSessionResume.ts') && id === './browser')
    return {
      resumeSession: async () => {
        const { browserResumeScope, resumeNativeCreate } = local(
          '../../providers/steel/lifecycleClaim'
        );
        await browserResumeScope().beforeCreate(provider);
        const native = await resumeNativeCreate(() => request('/allocate', 'POST'));
        await prisma.browserSession.update({
          where: { id: taskId },
          data: {
            sessionId: native.id,
            wsUrl: native.endpoint,
            debugUrl: 'https://fixture.invalid',
            status: 'PAUSED',
            closedAt: null,
          },
        });
        return {
          provider,
          sessionId: native.id,
          wsUrl: native.endpoint,
          debugUrl: 'https://fixture.invalid',
          proxySource: 'fixture',
          proxyLocation: { country: 'US' },
          profileId: null,
          profileSource: 'logical_checkpoint',
          validationBrowser: await chromium.connectOverCDP(native.endpoint),
        };
      },
      getBrowserSessionHealth: (id: string) => request(`/health?id=${encodeURIComponent(id)}`),
      getFingerprintInjectionData: async () => null,
    };
  if (parent?.filename.endsWith('/browser/checkpoint.ts') && id === '../steel/sessionConnection')
    return { connectValidatedBrowser: chromium.connectOverCDP.bind(chromium) };
  return original.call(this, id, parent, isMain);
};
// Load the import graph before the parent's fixed lifecycle window starts.
const { resumeBrowserSession } = local('../../providers/browserSessionResume');
local('../../providers/steel/lifecycleClaim');
(async () => {
  try {
    await prisma.$connect();
    process.send?.({ type: 'ready' });
    const result = await resumeBrowserSession(taskId);
    process.send?.({ type: 'result', ok: true, sessionId: result.session_id });
  } catch (error) {
    process.send?.({ type: 'result', ok: false, error: String(error) });
    process.exitCode = 1;
  } finally {
    Module._load = original;
    await prisma.$disconnect();
  }
})();
