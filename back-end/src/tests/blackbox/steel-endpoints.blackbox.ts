#!/usr/bin/env tsx

import {
  releaseSteelRemoteSession,
  steel,
  steelApiUrl,
  steelCdpConnectionUrl,
  steelCdpUrl,
  steelDebugUrl,
  steelPublicCdpUrl,
} from '../../providers/steel/session';
import { releaseSupersededBrowser } from '../../providers/browser/sessionCleanup';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function assertReleaseRetriesAreBounded(): Promise<void> {
  const sessions = steel.sessions as unknown as {
    release: (sessionId: string) => Promise<unknown>;
  };
  const originalRelease = sessions.release;
  try {
    let attempts = 0;
    sessions.release = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient release failure');
      return {};
    };
    await releaseSteelRemoteSession('retry-session');
    assert(attempts === 3, `Steel release used ${attempts} attempts instead of 3`);

    attempts = 0;
    sessions.release = async () => {
      attempts += 1;
      const notFound = new Error('already released') as Error & { status: number };
      notFound.status = 404;
      throw notFound;
    };
    await releaseSteelRemoteSession('already-released-session');
    assert(attempts === 1, 'Steel 404 release should be treated as idempotent success');
  } finally {
    sessions.release = originalRelease;
  }
}

async function assertSupersededProviderCleanupIsExplicit(): Promise<void> {
  const released: string[] = [];
  const dependencies = {
    releaseKernel: async (sessionId: string) => {
      released.push(`kernel:${sessionId}`);
    },
    releaseSteel: async (sessionId: string) => {
      released.push(`steel:${sessionId}`);
    },
  };
  const kernelReleased = await releaseSupersededBrowser(
    {
      taskId: 'task-1',
      previousProvider: 'kernel',
      previousSessionId: 'kernel-old',
      operation: 'rotation',
    },
    dependencies
  );
  const steelReleased = await releaseSupersededBrowser(
    {
      taskId: 'task-2',
      previousProvider: 'steel',
      previousSessionId: 'steel-old',
      operation: 'resume',
    },
    dependencies
  );
  assert(kernelReleased && steelReleased, 'superseded provider cleanup reported failure');
  assert(
    released.join(',') === 'kernel:kernel-old,steel:steel-old',
    `superseded cleanup selected the wrong provider: ${released.join(',')}`
  );

  const exhausted = await releaseSupersededBrowser(
    {
      taskId: 'task-3',
      previousProvider: 'steel',
      previousSessionId: 'steel-unreleasable',
      operation: 'rotation',
    },
    {
      ...dependencies,
      releaseSteel: async () => {
        throw new Error('bounded retries exhausted');
      },
    }
  );
  assert(exhausted === false, 'cleanup exhaustion was not surfaced to the caller');
}

async function main(): Promise<void> {
  const previous = process.env.STEEL_API_KEY;
  process.env.STEEL_API_KEY = 'steel-test-key';
  try {
    assert(
      steelApiUrl('/v1/sessions/session-1') ===
        'https://connect.steelbrowser.com/v1/sessions/session-1',
      'Steel HTTP helper used a stale origin'
    );
    const cdpUrl = new URL(steelCdpUrl('session-1'));
    assert(cdpUrl.protocol === 'wss:', 'Steel CDP helper did not use WebSocket TLS');
    assert(cdpUrl.hostname === 'connect.steelbrowser.com', 'Steel CDP helper used a stale origin');
    assert(cdpUrl.searchParams.get('apiKey') === null, 'persisted Steel CDP URL leaked its key');
    assert(cdpUrl.searchParams.get('sessionId') === 'session-1', 'Steel session ID missing');
    const connectionUrl = new URL(steelCdpConnectionUrl(cdpUrl.toString()));
    assert(
      connectionUrl.searchParams.get('apiKey') === 'steel-test-key',
      'Steel CDP connection key missing'
    );
    const legacyPublicUrl = new URL(
      steelPublicCdpUrl('wss://connect.steel.dev?sessionId=legacy-session&APIKEY=legacy-secret')
    );
    assert(
      legacyPublicUrl.searchParams.get('apiKey') === null,
      'legacy Steel key was not redacted'
    );
    assert(
      legacyPublicUrl.searchParams.get('sessionId') === 'legacy-session',
      'legacy Steel session ID was lost while redacting'
    );
    const debugUrl = new URL(
      steelDebugUrl('https://api.steel.dev/v1/sessions/session-1/player?legacy=true')
    );
    assert(debugUrl.hostname === 'connect.steelbrowser.com', 'Steel live view used a stale origin');
    assert(
      debugUrl.searchParams.get('legacy') === 'true',
      'Steel live-view query parameters were lost'
    );
    assert(
      debugUrl.searchParams.get('interactive') === 'false',
      'Steel live view was not read-only'
    );
    await assertReleaseRetriesAreBounded();
    await assertSupersededProviderCleanupIsExplicit();
    console.log('PASS Steel URLs keep API keys local to the CDP connection boundary');
  } finally {
    if (previous === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
