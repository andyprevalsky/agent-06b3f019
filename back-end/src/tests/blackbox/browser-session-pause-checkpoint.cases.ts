/** Provider-boundary regressions: a stopped browser is not necessarily durably paused. */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

export async function runBrowserPauseCheckpointCases(): Promise<void> {
  const providerPath = new URL('../../providers/browser/browserUse.ts', import.meta.url).pathname;
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as {
    _load: (id: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
  };
  const originalLoad = loader._load;
  const previousProvider = require.cache[providerPath];
  let savedStatus = 'ACTIVE';
  let profileReads = 0;
  let stops = 0;
  let mode: 'saved' | 'save-failed' | 'metadata-failed' | 'stop-failed' = 'saved';
  const announcements: string[] = [];
  const sessionId = 'owned-provider-session';
  const profileId = 'owned-profile';
  const database = {
    browserSession: {
      findUnique: async () => ({ providerProfileId: profileId, wsUrl: 'wss://fixture.invalid' }),
      update: async ({
        where,
        data,
      }: {
        where: { sessionId: string };
        data: { status: string };
      }) => {
        assert.equal(where.sessionId, sessionId, 'pause must retain the same provider binding');
        savedStatus = data.status;
      },
    },
  };
  loader._load = function (id, parent, isMain) {
    if (parent?.filename === providerPath) {
      if (id === '../database') return { prisma: database };
      if (id === '../logger') return { createLogger: () => ({ info() {}, warn() {} }) };
      if (id === './sessionBindingAnnounce')
        return { announceBrowserSessionBinding: async () => announcements.push(savedStatus) };
      if (id === './browserUseClient')
        return {
          request: async (path: string, options?: { method?: string }) => {
            if (options?.method === 'PATCH') {
              assert.equal(path, `/browsers/${sessionId}`);
              stops += 1;
              if (mode === 'stop-failed') throw new Error('Browser Use HTTP 400: stop rejected');
              return {};
            }
            assert.equal(path, `/profiles/${profileId}`);
            profileReads += 1;
            if (mode === 'metadata-failed' || (mode === 'save-failed' && profileReads > 1)) {
              throw new Error('profile read failed');
            }
            return { updatedAt: profileReads === 1 ? 'before' : 'after' };
          },
        };
      if (id === '../retry')
        return { retryWithBackoff: async (action: () => Promise<unknown>) => action() };
      if (id === 'playwright')
        return {
          chromium: {
            connectOverCDP: async () => ({
              contexts: () => [{ storageState: async () => ({ cookies: [], origins: [] }) }],
              close: async () => undefined,
            }),
          },
        };
      // Creation/replacement dependencies are outside this close-path regression.
      if (
        [
          '../geoip',
          '../steel/sessionConnection',
          './benchmarkProfileIsolation',
          './config',
          './context',
          './sessionPersist',
        ].includes(id)
      )
        return {};
    }
    return originalLoad.call(this, id, parent, isMain);
  };
  try {
    delete require.cache[providerPath];
    const { closeBrowserUseSession } = require(providerPath) as {
      closeBrowserUseSession: (id: string, pause: boolean) => Promise<void>;
    };
    const reset = (next: typeof mode) => {
      mode = next;
      savedStatus = 'ACTIVE';
      stops = 0;
      profileReads = 0;
      announcements.length = 0;
    };

    reset('save-failed');
    await assert.rejects(closeBrowserUseSession(sessionId, true), /profile read failed/);
    assert.equal(stops, 1, 'provider stop completed before save verification failed');
    assert.equal(savedStatus, 'ERROR', 'failed checkpoint must never persist PAUSED');
    assert.deepEqual(announcements, ['ERROR'], 'live-view status must report the failed pause');

    reset('saved');
    await closeBrowserUseSession(sessionId, true);
    assert.equal(stops, 1);
    assert.equal(profileReads, 2, 'unknown baseline needs a before/after save confirmation');
    assert.equal(savedStatus, 'PAUSED');
    assert.deepEqual(announcements, ['PAUSED']);

    reset('metadata-failed');
    await assert.rejects(closeBrowserUseSession(sessionId, true), /profile read failed/);
    assert.equal(stops, 0, 'keep the live browser if no checkpoint can be verified');
    assert.equal(savedStatus, 'ACTIVE');
    assert.deepEqual(announcements, []);

    reset('stop-failed');
    await assert.rejects(closeBrowserUseSession(sessionId, true), /stop rejected/);
    assert.equal(savedStatus, 'ACTIVE', 'failed stop keeps the live session retryable');
    assert.deepEqual(announcements, ['ACTIVE']);
  } finally {
    loader._load = originalLoad;
    delete require.cache[providerPath];
    if (previousProvider) require.cache[providerPath] = previousProvider;
  }
}
