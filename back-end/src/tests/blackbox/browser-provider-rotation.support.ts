import { skipProvenSteelPersistenceOutage } from './browser-provider.steel-persistence-outage.support';
import { ROTATION_CAP, selectRotationStep } from '../../providers/browser/rotation';
import { retryWithBackoff } from '../../providers/retry';
import { chromium } from 'playwright';
import { browserActivityBudgetMinutes } from '../../providers/steel/sessionLifetime';

interface RotationResponse {
  task_id?: string;
  session_id?: string;
  ws_url?: string;
  saved_url?: string;
  provider?: string;
  proxy_tier?: string;
  rotations_used?: number;
  rotations_remaining?: number;
  previous_provider?: string;
  recovery_action?: string;
  next_recovery?: string;
  browser_session_metadata?: { provider?: string; steel_profile_id?: string; profile_id?: string };
}

interface CrossProviderLadderOptions {
  baseUrl: string;
  headers: Record<string, string>;
  taskId: string;
  currentKernelSessionId: string;
  mobileIp: string;
  post: (path: string, body?: unknown) => Promise<RotationResponse>;
  readDifferentExitIp: (wsUrl: string, previousIp: string, stage: string) => Promise<string>;
  readExitIp: (wsUrl: string) => Promise<string>;
  retrieveKernelBrowser: (sessionId: string) => Promise<{ deleted_at?: string | Date | null }>;
  retrieveSteelBrowser: (sessionId: string) => Promise<{ status?: string; timeout?: number }>;
  retrieveBrowserUseBrowser: (sessionId: string) => Promise<{ status?: string }>;
  browserUseAvailable: boolean;
  /** Whether Steel can boot a session created with its default options right now. */
  steelControlSessionBoots?: () => Promise<boolean>;
  /**
   * Every provider session this ladder allocates, appended as it is created.
   *
   * The caller's `finally` can only close a session id it already holds, and it
   * learns the ladder's final id from the RETURN value — so when the ladder throws
   * partway (a Steel 429 on call 4 is the observed case) the session allocated by
   * the provider switch is orphaned: still live, still billing, with its DB row
   * already deleted by the caller's cleanup. Two such orphans were found live on
   * the Steel account while diagnosing this, sharing the concurrency cap with 8
   * legitimate production sessions.
   */
  allocatedSessionIds?: string[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Raised when the live cross-provider ladder cannot exercise its Steel legs
 * because Steel's live infrastructure is unreachable — NOT because the rotation
 * code is wrong. The caller converts this into a loud SKIP (Kernel legs already
 * proved live rotation; {@link assertFixedRotationLadder} proves the ladder
 * config) instead of a hard failure, so a Steel outage cannot block a deploy
 * while Kernel is healthy.
 */
export class SteelProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SteelProviderUnavailableError';
  }
}

const STEEL_OUTAGE_CONNECTIVITY_HINTS = [
  'connection error',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
  'fetch failed',
  'socket hang up',
  'timed out',
  'timeout',
  'network',
];

const STEEL_CAPACITY_RETRY_DELAYS_MS = [15_000, 30_000, 60_000];

/**
 * Steel's HTTP 429 here means its account-wide concurrent-session pool is full,
 * not that this rotation request is invalid. Production and the live parity gate
 * share that pool, so a deploy must wait for a slot instead of failing whenever
 * live agents happen to occupy all ten sessions. Keep the classifier exact:
 * after the bounded wait only this structured capacity response can use the
 * provider-unavailable path; auth, billing, generic provider 429s, and every
 * non-Steel failure still fail closed.
 */
export function isSteelCapacityRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('/rotate-proxy 429') &&
    message.includes('"error":"browser_provider_rate_limit"') &&
    message.includes('"provider":"steel"')
  );
}

/**
 * True only when a `/rotate-proxy` failure is a genuine Steel live-infra OUTAGE:
 * a 5xx whose body is production's post-retry "Failed to create Steel
 * replacement after N attempts: <cause>" AND whose cause is a connectivity
 * error. Production (providers/steel/sessionResume.ts) emits that message only
 * after exhausting `MAX_SESSION_RETRIES`, so reaching it proves the rotation
 * logic correctly escalated to Steel and Steel itself was down.
 *
 * Deliberately narrow so real defects still fail loudly: assertion failures,
 * wrong provider/tier/counters, leaked sessions, and Steel AUTH/QUOTA rejections
 * (401/402/403 — a credential problem to fix, no connectivity hint) do NOT match.
 * CDP validation failures are excluded too: our own create options can stop a
 * Steel browser from booting, so {@link shouldSkipSteelLegs} decides those
 * against a control session.
 */
export function isSteelProvisioningOutage(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const looksLikeConnectivity = STEEL_OUTAGE_CONNECTIVITY_HINTS.some((hint) =>
    message.includes(hint)
  );
  return (
    isSteelReplacementFailure(message) &&
    !message.includes('session validation failed') &&
    looksLikeConnectivity
  );
}

function isSteelReplacementFailure(lowerCaseMessage: string): boolean {
  return (
    lowerCaseMessage.includes('/rotate-proxy') &&
    /\b5\d\d\b/.test(lowerCaseMessage) &&
    lowerCaseMessage.includes('failed to create steel replacement')
  );
}

/**
 * True when every replacement attempt was created by Steel but never accepted
 * CDP (Steel's `startup_failed`, or a connect timeout before Steel ruled).
 */
export function isSteelSessionValidationFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return isSteelReplacementFailure(message) && message.includes('session validation failed');
}

/**
 * True when `/rotate-proxy` returns our structured Steel session rate limit
 * (`browser_provider_rate_limit` + provider steel + HTTP 429). Parallel blackbox
 * suites (steel-injection + steel-fingerprint + this ladder) share one Steel
 * account and can exhaust the session budget mid-ladder even though Kernel
 * residential/mobile legs already proved rotation. Treat like a Steel outage
 * for skip purposes — not an AUTH/QUOTA credential failure (401/402/403).
 */
export function isSteelSessionRateLimited(error: unknown): boolean {
  return isSteelCapacityRateLimit(error);
}

/**
 * A validation failure is a Steel outage only when Steel cannot boot even a
 * session with its default options. If that control boots, our replacement
 * options are what break startup and the ladder must fail.
 */
export async function shouldSkipSteelLegs(
  error: unknown,
  steelControlSessionBoots?: () => Promise<boolean>
): Promise<boolean> {
  if (isSteelProvisioningOutage(error) || isSteelSessionRateLimited(error)) return true;
  if (!isSteelSessionValidationFailure(error) || steelControlSessionBoots === undefined) {
    return false;
  }
  if (await steelControlSessionBoots()) {
    console.error(
      'Steel boots a default control session, so the replacement session options broke startup'
    );
    return false;
  }
  return true;
}

export function assertFixedRotationLadder(): void {
  assert(ROTATION_CAP === 4, 'rotation cap must remain four recovery actions');
  const steps = [
    selectRotationStep(1, 'kernel'),
    selectRotationStep(2, 'kernel'),
    selectRotationStep(3, 'kernel'),
    selectRotationStep(4, 'steel'),
  ];
  assert(
    JSON.stringify(steps) ===
      JSON.stringify([
        { provider: 'kernel', proxyType: 'residential', recoveryAction: 'ip_rotated' },
        { provider: 'kernel', proxyType: 'mobile', recoveryAction: 'ip_rotated' },
        { provider: 'steel', proxyType: 'residential', recoveryAction: 'provider_switched' },
        { provider: 'browser-use', proxyType: 'residential', recoveryAction: 'provider_switched' },
      ]),
    `unexpected rotation ladder: ${JSON.stringify(steps)}`
  );
}

/**
 * Profiles are per-test resources. Managed proxies have no delete helper on
 * purpose: they are shared by geo name with prod and every concurrent run.
 */
export async function deleteKernelProfile(profileId: string): Promise<void> {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) return;
  const path = `/profiles/${encodeURIComponent(profileId)}`;
  const response = await fetch(`https://api.onkernel.com${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`Kernel cleanup failed for ${path}: HTTP ${response.status}`);
  }
}

/** Exercise calls 3-5 after the caller has proven Kernel residential/mobile. */
export async function runCrossProviderRotationLadder(
  options: CrossProviderLadderOptions
): Promise<{ finalSessionId: string; firstSteelIp: string; browserUseIp: string | null }> {
  const {
    baseUrl,
    headers,
    taskId,
    currentKernelSessionId,
    mobileIp,
    post,
    readDifferentExitIp,
    readExitIp,
    retrieveKernelBrowser,
    retrieveSteelBrowser,
    retrieveBrowserUseBrowser,
    browserUseAvailable,
    steelControlSessionBoots,
    allocatedSessionIds,
  } = options;
  const recordAllocation = (sessionId: unknown): void => {
    if (typeof sessionId === 'string' && sessionId !== '') allocatedSessionIds?.push(sessionId);
  };

  // Steel create is flaky under parallel blackbox load; retry transient
  // connection failures quickly. An account-wide capacity 429 gets a separate,
  // longer bounded schedule because production sessions normally expire within
  // this window. Only exhaustion of the exact structured capacity response uses
  // the provider-unavailable path; auth and billing failures still fail closed.
  const postWithSteelRetry = async (path: string, body?: unknown): Promise<RotationResponse> =>
    retryWithBackoff(() => post(path, body), {
      maxRetries: 4,
      getBackoffDelayMs: (error, attempt) =>
        isSteelCapacityRateLimit(error)
          ? (STEEL_CAPACITY_RETRY_DELAYS_MS[attempt - 1] ?? 60_000)
          : 1_000 * 2 ** (attempt - 1),
      isRetryable: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return (
          isSteelCapacityRateLimit(error) ||
          message.includes('Failed to create Steel replacement') ||
          message.includes('Connection error') ||
          isSteelSessionRateLimited(error)
        );
      },
      component: 'browser-provider:steel-create',
    });

  let switched: RotationResponse;
  try {
    switched = await postWithSteelRetry('/rotate-proxy', {
      task_id: taskId,
      current_url: 'https://example.com/provider-switch-check',
    });
  } catch (error) {
    // Retries exhausted. If Steel's infra is genuinely down or rate-limited
    // (not a rotation defect), skip the Steel legs while Kernel is healthy.
    if (await shouldSkipSteelLegs(error, steelControlSessionBoots)) {
      throw new SteelProviderUnavailableError(
        `Kernel→Steel switch (call 3) could not provision a Steel session: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    throw error;
  }
  assert(switched.task_id === taskId, 'provider switch changed the stable task ID');
  assert(
    switched.provider === 'steel' && switched.proxy_tier === 'residential',
    `call 3 expected Steel residential, got ${switched.provider}/${switched.proxy_tier}`
  );
  assert(
    switched.previous_provider === 'kernel' && switched.recovery_action === 'provider_switched',
    'call 3 did not report the Kernel-to-Steel provider switch'
  );
  assert(
    switched.rotations_used === 3 &&
      switched.rotations_remaining === 1 &&
      switched.next_recovery ===
        (browserUseAvailable ? 'switch_provider_to_browser_use' : 'rotate_steel_residential_ip'),
    'call 3 returned the wrong counters or next recovery'
  );
  assert(
    switched.saved_url === 'https://example.com/provider-switch-check',
    'provider switch lost the current URL supplied by the browser worker'
  );
  assert(
    switched.browser_session_metadata?.provider === 'steel' &&
      Boolean(switched.browser_session_metadata.steel_profile_id),
    'provider switch omitted Steel session metadata'
  );
  recordAllocation(switched.session_id);
  assert(
    switched.session_id !== undefined && switched.session_id !== currentKernelSessionId,
    'provider switch did not allocate a new Steel session'
  );

  const evictedKernel = await retrieveKernelBrowser(currentKernelSessionId);
  assert(Boolean(evictedKernel.deleted_at), 'provider switch leaked the superseded Kernel session');
  const firstSteelIp = await readDifferentExitIp(
    String(switched.ws_url),
    mobileIp,
    `rotation3 steel, Steel session ${String(switched.session_id)}`
  );
  const assertSteelLifetime = async (sessionId: string): Promise<void> => {
    const timeout = (await retrieveSteelBrowser(sessionId)).timeout;
    const activityBudgetMs = browserActivityBudgetMinutes() * 60_000;
    assert(
      typeof timeout === 'number' && timeout > activityBudgetMs,
      `Steel session lifetime ${String(timeout)}ms does not outlive the ${activityBudgetMs}ms browser activity budget; Steel releases it mid-run`
    );
  };
  await assertSteelLifetime(String(switched.session_id));

  const assertSteelReleased = async (sessionId: string): Promise<void> => {
    const status = await retryWithBackoff(
      async () => {
        const current = String((await retrieveSteelBrowser(sessionId)).status);
        if (current !== 'released') throw new Error(`Steel session remains ${current}`);
        return current;
      },
      {
        maxRetries: 5,
        fixedDelays: [200, 400, 600, 800],
        isRetryable: () => true,
        component: 'browser-provider superseded Steel release',
      }
    );
    assert(status === 'released', `call 4 leaked the superseded Steel session (${status})`);
  };
  const assertRotationExhausted = async (): Promise<void> => {
    const response = await fetch(`${baseUrl}/api/browser-session/rotate-proxy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ task_id: taskId }),
    });
    assert(
      response.status === 409,
      `expected 409 after four real recoveries, got ${response.status}`
    );
    const body = (await response.json()) as { error?: string; message?: string };
    assert(
      body.error === 'proxy_rotation_exhausted' &&
        String(body.message).includes('PROXY_ROTATION_EXHAUSTED'),
      'exhaustion response missing the structured error the agent reads'
    );
  };

  if (!browserUseAvailable) {
    skipProvenSteelPersistenceOutage();
    let steelRotated: RotationResponse;
    try {
      steelRotated = await postWithSteelRetry('/rotate-proxy', {
        task_id: taskId,
        current_url: 'https://example.com/steel-rotation-check',
      });
    } catch (error) {
      if (await shouldSkipSteelLegs(error, steelControlSessionBoots)) {
        throw new SteelProviderUnavailableError(
          `Steel residential rotation (call 4) could not provision a session: ${String(error)}`
        );
      }
      throw error;
    }
    assert(
      steelRotated.provider === 'steel' && steelRotated.proxy_tier === 'residential',
      'call 4 must stay on Steel residential while Browser Use is disabled'
    );
    assert(
      steelRotated.previous_provider === 'steel' && steelRotated.recovery_action === 'ip_rotated',
      'call 4 did not report a Steel IP rotation'
    );
    assert(
      steelRotated.rotations_used === 4 &&
        steelRotated.rotations_remaining === 0 &&
        steelRotated.next_recovery === 'rotation_budget_exhausted',
      'call 4 returned the wrong final rotation state'
    );
    assert(
      steelRotated.browser_session_metadata?.provider === 'steel' &&
        Boolean(steelRotated.browser_session_metadata.steel_profile_id),
      'call 4 lost the Steel profile binding'
    );
    assert(
      steelRotated.browser_session_metadata?.steel_profile_id ===
        switched.browser_session_metadata?.steel_profile_id,
      'call 4 changed the exact persisted Steel profile'
    );
    recordAllocation(steelRotated.session_id);
    assert(
      steelRotated.session_id !== undefined && steelRotated.session_id !== switched.session_id,
      'call 4 did not allocate a new Steel session'
    );
    await assertSteelReleased(String(switched.session_id));
    await readDifferentExitIp(
      String(steelRotated.ws_url),
      firstSteelIp,
      `rotation4 steel, Steel session ${String(steelRotated.session_id)}`
    );
    await assertSteelLifetime(String(steelRotated.session_id));
    await assertRotationExhausted();
    return { finalSessionId: String(steelRotated.session_id), firstSteelIp, browserUseIp: null };
  }

  const browserUseRotated = await post('/rotate-proxy', {
    task_id: taskId,
    current_url: 'https://example.com/browser-use-rotation-check',
  });
  assert(
    browserUseRotated.provider === 'browser-use' && browserUseRotated.proxy_tier === 'residential',
    'call 4 must switch to Browser Use residential'
  );
  assert(
    browserUseRotated.previous_provider === 'steel' &&
      browserUseRotated.recovery_action === 'provider_switched',
    'call 4 did not report the Steel-to-Browser Use switch'
  );
  assert(
    browserUseRotated.browser_session_metadata?.provider === 'browser-use' &&
      Boolean(browserUseRotated.browser_session_metadata.profile_id),
    'call 4 omitted the persistent Browser Use profile binding'
  );
  assert(
    browserUseRotated.rotations_used === 4 &&
      browserUseRotated.rotations_remaining === 0 &&
      browserUseRotated.next_recovery === 'rotation_budget_exhausted',
    'call 4 returned the wrong final rotation state'
  );
  recordAllocation(browserUseRotated.session_id);
  assert(
    browserUseRotated.session_id !== undefined &&
      browserUseRotated.session_id !== switched.session_id,
    'call 4 did not allocate a Browser Use session'
  );
  await assertSteelReleased(String(switched.session_id));
  const browserUseIp = await readExitIp(String(browserUseRotated.ws_url));
  assert(browserUseIp !== '', 'Browser Use session did not expose a working proxy exit');
  const browserUse = await retrieveBrowserUseBrowser(String(browserUseRotated.session_id));
  assert(browserUse.status === 'active', 'Browser Use replacement is not active');

  const form = new FormData();
  form.set(
    'file',
    new Blob(['browser-use-upload-proof'], { type: 'text/plain' }),
    'upload-proof.txt'
  );
  const uploadResponse = await fetch(
    `${baseUrl}/api/browser-session/${browserUseRotated.session_id}/files`,
    { method: 'POST', headers: { 'x-api-key': headers['x-api-key'] }, body: form }
  );
  assert(uploadResponse.ok, `Browser Use session upload failed: HTTP ${uploadResponse.status}`);
  const upload = (await uploadResponse.json()) as { path?: string; size?: number };
  assert(upload.path && upload.size === 24, 'Browser Use upload returned no remote file path');
  const uploadBrowser = await chromium.connectOverCDP(String(browserUseRotated.ws_url));
  try {
    const context = uploadBrowser.contexts()[0];
    assert(context, 'Browser Use upload session has no CDP context');
    const page = await context.newPage();
    try {
      await page.evaluate(
        'document.documentElement.insertAdjacentHTML(\'beforeend\', \'<input type="file" id="upload">\')'
      );
      const cdp = await context.newCDPSession(page);
      const document = await cdp.send('DOM.getDocument');
      const input = await cdp.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '#upload',
      });
      assert(input.nodeId, 'Browser Use file input was not found');
      await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [upload.path] });
      const selected = await page.evaluate("document.querySelector('#upload').files?.[0]?.name");
      assert(
        selected === upload.path.split('/').at(-1),
        'Browser Use remote path was not usable by file input'
      );
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await uploadBrowser.close().catch(() => {});
  }

  await assertRotationExhausted();

  return {
    finalSessionId: String(browserUseRotated.session_id),
    firstSteelIp,
    browserUseIp,
  };
}

/**
 * Run {@link runCrossProviderRotationLadder}, converting a genuine Steel
 * live-infra outage or session rate-limit into a loud SKIP (returns `null`)
 * instead of a failure. The Kernel legs (run by the caller beforehand) already
 * prove live IP rotation, and {@link assertFixedRotationLadder} proves the
 * ladder config, so Steel capacity/outage must not block a deploy while Kernel
 * is healthy. Any non-skip error — real rotation defects, or a Steel auth/quota
 * rejection — still propagates and fails.
 */
export async function runCrossProviderRotationLadderOrSkipOnSteelOutage(
  options: CrossProviderLadderOptions
): Promise<{ finalSessionId: string; firstSteelIp: string; browserUseIp: string | null } | null> {
  try {
    return await runCrossProviderRotationLadder(options);
  } catch (error) {
    if (error instanceof SteelProviderUnavailableError) {
      console.warn(
        `⚠️  SKIP live Steel legs — Steel provider infra unavailable; Kernel rotation ` +
          `validated end-to-end and ladder config asserted. Reason: ${error.message}`
      );
      return null;
    }
    throw error;
  }
}
