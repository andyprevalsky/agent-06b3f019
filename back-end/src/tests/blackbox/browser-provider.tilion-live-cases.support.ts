/**
 * Live Tilion cases beyond the core parity: the worker's recover-challenge path,
 * the (opt-in) account concurrency cap, and the ordered runner the /deploy-run
 * browser-provider domain calls. See browser-provider.tilion-live.support.ts.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import {
  createTilionRecoverySession,
  listLiveTilionSessionIds,
  releaseTilionRemoteSession,
  TilionRateLimitError,
} from '../../providers/browser/tilion';
import { steelCdpConnectionUrl } from '../../providers/steel/urls';
import { runLiveKernelSteelAuthPersist } from './browser-provider.auth-persist.live';
import {
  assert,
  type BrowserApiResponse,
  navigateKernelPage,
  retryBackendFetch,
} from './browser-provider.helpers';
import {
  LOCATION,
  runLiveTilionProviderParity,
  tilionApi,
  withPage,
} from './browser-provider.tilion-live.support';

const RECOVERY_URL = 'https://en.wikipedia.org/wiki/Web_browser';

/** User, agent and a Tilion-pinned browser context for one live case. */
async function createTilionPinnedFixture(label: string) {
  const userId = `tilion-${label}-${randomUUID()}`;
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, name: `Tilion ${label} blackbox` } });
  await prisma.browserContext.create({
    data: {
      userId,
      preferredBrowserConfig: {
        ...buildPreferredBrowserConfig(
          { provider: 'tilion', proxyMode: 'residential_country', tilionProxyType: 'residential' },
          LOCATION
        ),
      },
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      userId,
      goal: `Validate Tilion ${label}`,
      proxyCountry: LOCATION.country,
      proxyState: LOCATION.state,
      proxyCity: LOCATION.city,
    },
  });
  const cleanup = async () => {
    await prisma.browserSession.deleteMany({ where: { agentId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await prisma.user.deleteMany({ where: { userId } });
  };
  return { userId, agentId, cleanup };
}

/**
 * The worker's real recovery path on a live Tilion row: `POST /recover-challenge`
 * with the storage_state the worker captured over its own CDP socket. The winner
 * must be drivable and carry that state; the replaced Tilion session must end.
 */
export async function runLiveTilionChallengeRecovery(): Promise<void> {
  const baseUrl = process.env.TEST_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.BACKEND_API_KEY?.trim();
  if (!baseUrl || !apiKey) return;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };
  const fixture = await createTilionPinnedFixture('recovery');
  const allocated = new Set<string>();
  const post = async (path: string, body: unknown): Promise<BrowserApiResponse> => {
    const response = await retryBackendFetch(`${baseUrl}/api/browser-session${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as BrowserApiResponse;
    if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(json)}`);
    if (json.session_id) allocated.add(String(json.session_id));
    return json;
  };
  let current: string | undefined;
  try {
    const init = await post('/init', {
      user_id: fixture.userId,
      agent_id: fixture.agentId,
      start_url: 'https://example.com',
    });
    current = String(init.session_id);
    assert(init.browser_session_metadata?.provider === 'tilion', 'recovery init was not Tilion');
    // Like the worker: state is captured on the page that hit the challenge.
    const storageState = await withPage(String(init.ws_url), async (page, browser) => {
      await navigateKernelPage(page, RECOVERY_URL);
      await page.evaluate(() => localStorage.setItem('rose_tilion_recovery', 'carried'));
      return browser.contexts()[0]!.storageState();
    });
    const recovered = await post('/recover-challenge', {
      task_id: String(init.task_id),
      // A real article: the recovery gate judges whether the target content came back,
      // and rejects a placeholder page such as example.com as "not the target".
      current_url: RECOVERY_URL,
      storage_state: storageState,
      recovery_reason:
        'The article page returned an access-denied interstitial instead of its text',
    });
    const winner = String(recovered.session_id);
    current = winner;
    console.log(
      `[tilion recover-challenge] winner provider=${String(recovered.provider)} config=${String(
        (recovered as { config_key?: unknown }).config_key
      )} replaced=${winner !== String(init.session_id)}`
    );
    // The winner can be any provider; Steel needs its key added at this CDP boundary.
    const carried = await withPage(
      steelCdpConnectionUrl(String(recovered.ws_url)),
      async (page) => {
        await navigateKernelPage(page, RECOVERY_URL);
        return page.evaluate(() => localStorage.getItem('rose_tilion_recovery'));
      }
    );
    assert(carried === 'carried', 'recover-challenge winner lost the worker storage_state');
    if (winner !== String(init.session_id)) {
      const replaced = await tilionApi('GET', `/v1/session/${String(init.session_id)}/status`);
      const state = (replaced.body as { state?: string } | null)?.state;
      assert(
        state === 'closed' || state === 'expired',
        `replaced Tilion session is still ${String(state)} after recovery (paid leak)`
      );
    }
    await post('/close', { session_id: winner, pause: false });
    current = undefined;
    console.log(`PASS live Tilion challenge recovery (winner=${String(recovered.provider)})`);
  } finally {
    if (current) await post('/close', { session_id: current, pause: false }).catch(() => undefined);
    for (const sessionId of allocated) {
      await releaseTilionRemoteSession(sessionId).catch(() => undefined);
    }
    const live = new Set(await listLiveTilionSessionIds());
    await fixture.cleanup();
    const leaked = [...allocated].filter((sessionId) => live.has(sessionId));
    assert(leaked.length === 0, `Tilion sessions still live after recovery: ${leaked.join(', ')}`);
  }
}

/**
 * K1: the create past the account cap is a typed rate-limit error. The Tilion
 * account is shared with production, so filling it is opt-in
 * (RUN_TILION_CONCURRENCY_LIVE=1) and holds the cap for only a few seconds.
 */
export async function runLiveTilionConcurrency(): Promise<void> {
  if (process.env.RUN_TILION_CONCURRENCY_LIVE !== '1') {
    console.log('SKIP live Tilion concurrency cap (set RUN_TILION_CONCURRENCY_LIVE=1)');
    return;
  }
  const usage = await tilionApi('GET', '/v1/usage');
  const cap = Number((usage.body as { concurrency_limit?: number } | null)?.concurrency_limit);
  assert(
    Number.isInteger(cap) && cap > 0,
    `Tilion usage has no concurrency_limit: ${usage.status}`
  );
  const opened: string[] = [];
  try {
    const live = await listLiveTilionSessionIds();
    const toOpen = cap - live.length;
    assert(toOpen > 0, `Tilion account already at its cap (${live.length}/${cap})`);
    const created = await Promise.allSettled(
      Array.from({ length: toOpen }, () =>
        tilionApi('POST', '/v1/session', { idle_timeout: 60, ttl: 300 })
      )
    );
    for (const result of created) {
      const id =
        result.status === 'fulfilled'
          ? (result.value.body as { session_id?: string })?.session_id
          : undefined;
      if (id) opened.push(id);
    }
    // Production code path: the adapter's create must surface the typed error.
    let refusal: unknown;
    try {
      const session = await createTilionRecoverySession(DEFAULT_GEOLOCATION);
      opened.push(session.sessionId);
      await session.validationBrowser?.close().catch(() => undefined);
    } catch (error) {
      refusal = error;
    }
    assert(
      refusal instanceof TilionRateLimitError && refusal.slug === 'concurrency_limit',
      `create past the cap (${opened.length}/${cap} open) was not a typed concurrency_limit: ${String(refusal)}`
    );
  } finally {
    await Promise.allSettled(opened.map((id) => releaseTilionRemoteSession(id)));
  }
  const live = new Set(await listLiveTilionSessionIds());
  assert(
    opened.every((id) => !live.has(id)),
    'Tilion concurrency sessions are still live after release'
  );
  console.log(
    `PASS live Tilion concurrency cap (${cap} live, next create typed concurrency_limit)`
  );
}

/** The deploy gate override that holds the live cases needing Tilion residential egress. */
export const TILION_RESIDENTIAL_LIVE_OVERRIDE = 'browser-provider:tilion-residential-live';

function gateOverridden(gate: string): boolean {
  return (process.env.DEPLOY_GATE_OVERRIDES ?? '')
    .split(',')
    .map((value) => value.trim())
    .includes(gate);
}

/**
 * The live auth-handoff and Tilion cases of the /deploy-run browser-provider
 * domain, in order. Returns the failure count so the runner keeps going.
 * Cases that pin a Tilion residential exit are skipped, loudly and never as a
 * pass, only when a user explicitly overrides them for a deploy (the pilot's
 * residential allowance can be used up: Tilion answers 402 premium_egress_exhausted).
 */
export async function runLiveCrossProviderCases(): Promise<number> {
  if (!process.env.TEST_BASE_URL) return 0;
  const cases: Array<[string, () => Promise<void>, boolean]> = [
    ['live Kernel/Steel auth persist', () => runLiveKernelSteelAuthPersist('steel'), false],
    ['live Tilion provider parity', runLiveTilionProviderParity, true],
    ['live Kernel/Tilion auth persist', () => runLiveKernelSteelAuthPersist('tilion'), true],
    ['live Tilion challenge recovery', runLiveTilionChallengeRecovery, true],
    ['live Tilion concurrency cap', runLiveTilionConcurrency, false],
  ];
  const holdResidential = gateOverridden(TILION_RESIDENTIAL_LIVE_OVERRIDE);
  let failed = 0;
  for (const [label, run, needsResidential] of cases) {
    if (needsResidential && holdResidential) {
      console.log(
        `⚠️⚠️ SKIPPED ${label} -- explicitly overridden by DEPLOY_GATE_OVERRIDES=` +
          `${TILION_RESIDENTIAL_LIVE_OVERRIDE} (Tilion residential egress unavailable); ` +
          'NOT a pass: rerun once residential usage is confirmed'
      );
      continue;
    }
    try {
      await run();
    } catch (error) {
      failed++;
      console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed;
}
