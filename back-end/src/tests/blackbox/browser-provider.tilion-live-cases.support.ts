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
import { quarantine } from '../helpers/quarantine';

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
  const { withBrowserProviderServer } = await import('./browser-provider.fixture-server.support');
  await withBrowserProviderServer('tilion', runConfiguredTilionChallengeRecovery);
}

async function runConfiguredTilionChallengeRecovery(): Promise<void> {
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

/**
 * The deploy gate override that holds the live cases needing a Kernel
 * residential proxy (Kernel's upstream answered 403 to residential country
 * validation from 2026-10-23).
 */
export const KERNEL_RESIDENTIAL_LIVE_OVERRIDE = 'browser-provider:kernel-residential-live';

/** Prints the loud skip line for a user-overridden live case; never a pass. */
export function logOverriddenLiveCase(label: string, gate: string, reason: string): void {
  console.log(
    `⚠️⚠️ SKIPPED ${label} -- explicitly overridden by DEPLOY_GATE_OVERRIDES=${gate} ` +
      `(${reason}); NOT a pass: rerun once the provider is restored`
  );
}

export function gateOverridden(gate: string): boolean {
  return (process.env.DEPLOY_GATE_OVERRIDES ?? '')
    .split(',')
    .map((value) => value.trim())
    .includes(gate);
}

// FLAKY, NOT_INTRODUCED (PR #1975): the Steel residential tunnel refused example.com.
const liveUnit = 'browser-provider';
const steelAuthPersist = quarantine(
  {
    since: '2026-11-12',
    repair: 'https://boxes.dev/thread/thr_825d565448b04195abc146b228ecdba5',
    error:
      'FAIL live Kernel/Steel auth persist: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/',
    evidence:
      'PR #1975 live-probes round 1 on 910dd40a14: browser-provider FLAKY (rerun passed); the PR changes no browser/provider code; same signature on PR #1658 (2026-10-31) reproduced standalone as Kernel residential proxy egress',
  },
  () => runLiveKernelSteelAuthPersist('steel'),
  { unit: liveUnit }
);

// FLAKY, NOT_INTRODUCED (PR #1990, PR #2023): the live-probes gate uses the prod AgentPhone
// key, and the prod AgentPhone account is at its 50 of 50 number cap. Tilion provider parity
// /init then saw an uncertain agent creation and could not reconcile it within the 10000-agent
// scan bound, so init returned 500; the same case passed on its rerun. The case still runs and
// reports; the repair thread owns the AgentPhone number cap and the reconcile scan bound, and
// the marker is released after five consecutive passes. Bound to the same domain unit as above.
const tilionParityUnit = 'browser-provider';
const tilionProviderParity = quarantine(
  {
    since: '2026-11-15',
    repair: 'https://boxes.dev/thread/thr_b5c1359b7cac4edc8341b4a8dd614b17',
    error:
      'FAIL live Tilion provider parity: /init 500: {"error":"AgentPhone agent creation is uncertain; reconciliation failed: AgentPhone reconciliation exceeded the 10000-agent scan bound"}',
    evidence:
      'PR #1990 live-probes round 2 on 2897e06746: browser-provider FLAKY 4418c14313bc4d9d81e98ca09490aa3f (rerun passed); same signature on PR #2023; prod AgentPhone at 50/50 numbers',
  },
  runLiveTilionProviderParity,
  { unit: tilionParityUnit }
);

/**
 * The live auth-handoff and Tilion cases of the /deploy-run browser-provider
 * domain, in order. Returns the failure count so the runner keeps going.
 * Cases that pin a Tilion or Kernel residential exit are skipped, loudly and
 * never as a pass, only when a user explicitly overrides them for a deploy (the
 * Tilion pilot's residential allowance can be used up: 402
 * premium_egress_exhausted; Kernel's upstream answered 403 to residential
 * country validation from 2026-10-23).
 */
export async function runLiveCrossProviderCases(): Promise<number> {
  if (!process.env.TEST_BASE_URL) return 0;
  const kernel = KERNEL_RESIDENTIAL_LIVE_OVERRIDE;
  const tilion = TILION_RESIDENTIAL_LIVE_OVERRIDE;
  const cases: Array<[string, () => Promise<void>, string | null]> = [
    ['live Kernel/Steel auth persist', steelAuthPersist, kernel],
    ['live Tilion provider parity', tilionProviderParity, tilion],
    ['live Kernel/Tilion auth persist', () => runLiveKernelSteelAuthPersist('tilion'), tilion],
    ['live Tilion challenge recovery', runLiveTilionChallengeRecovery, tilion],
    ['live Tilion concurrency cap', runLiveTilionConcurrency, null],
  ];
  const reasons: Record<string, string> = {
    [kernel]: 'Kernel residential proxy unavailable',
    [tilion]: 'Tilion residential egress unavailable',
  };
  let failed = 0;
  for (const [label, run, holdGate] of cases) {
    if (holdGate !== null && gateOverridden(holdGate)) {
      logOverriddenLiveCase(label, holdGate, reasons[holdGate]);
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
