import {
  expect,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response as PlaywrightResponse,
} from '@playwright/test';

function resolveLocalSemanticBackendUrl(): string {
  // Prefer BACKEND_PORT when BACKEND_URL is missing or a stale local default.
  // Cloud injections often pin BACKEND_URL to local port 3001 while the deploy
  // worktree listens on CONDUCTOR_PORT. Keep non-local BACKEND_URL values
  // (prod semantic mode) unchanged.
  const port = process.env.BACKEND_PORT;
  const explicit = process.env.BACKEND_URL;
  const explicitIsLocal =
    !!explicit &&
    (explicit.startsWith('http://localhost:') || explicit.startsWith('http://127.0.0.1:'));
  if (port && (!explicit || explicitIsLocal)) {
    return `http://localhost:${port}`;
  }
  return explicit ?? `http://localhost:${port ?? '3001'}`;
}

export const BACKEND_URL = resolveLocalSemanticBackendUrl();
export const FRONTEND_URL =
  process.env.FRONTEND_URL ?? `http://localhost:${process.env.FRONTEND_PORT ?? '3002'}`;

/** Whether tests are running against production (set by run-semantic-tests.sh --prod). */
export const IS_PROD = process.env.SEMANTIC_PROD === '1';

/** One runner-generated session shared by every Playwright worker. */
const INJECTED_SESSION = process.env.SEMANTIC_SESSION ?? process.env.PROD_SESSION ?? '';
export const HAS_INJECTED_SESSION = INJECTED_SESSION !== '';

// Dev-only test credentials. The default key is the shared local-backend
// dev key (also in .claude/commands/loop.md; CLAUDE.md "Credentials and
// environment" holds the dev login and user id); override via env for CI or
// alternate environments.
export const TEST_API_KEY =
  process.env.TEST_API_KEY ?? 'AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=';
export const TEST_USER_ID = process.env.TEST_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
export const TEST_PHONE_DIGITS = process.env.TEST_PHONE_DIGITS ?? '5555550123';
export const TEST_PHONE_E164 = process.env.TEST_PHONE_E164 ?? '+15555550123';
export const TEST_OTP = process.env.TEST_OTP ?? '191919';

let resolvedLocalUserId: Promise<string> | null = null;

async function parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text();
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { raw };
  }
}

export async function resolveTestUserId(): Promise<string> {
  if (IS_PROD || process.env.TEST_USER_ID !== undefined) return TEST_USER_ID;
  resolvedLocalUserId ??= (async () => {
    const sendRes = await fetch(`${BACKEND_URL}/api/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: TEST_PHONE_E164 }),
    });
    if (!sendRes.ok) {
      const body = await sendRes.text();
      throw new Error(`Test user OTP send failed: ${sendRes.status} ${body.slice(0, 500)}`);
    }
    const verifyRes = await fetch(`${BACKEND_URL}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: TEST_PHONE_E164, token: TEST_OTP }),
    });
    const data = await parseJsonResponse(verifyRes);
    const userId = (data.user as { id?: string } | undefined)?.id;
    if (!verifyRes.ok || userId === undefined || userId === '') {
      throw new Error(`Test user OTP verify failed: ${verifyRes.status} ${JSON.stringify(data)}`);
    }
    return userId;
  })();
  return resolvedLocalUserId;
}

/**
 * Wraps a page probe for `expect.poll` and records how long the page took to
 * answer. expect.poll charges a probe that never returns against its timeout,
 * so a renderer frozen by host overload reads exactly like a wrong value
 * (RCA 2026-10-02-semantic-renderer-stall-consumed-chip-poll-budget).
 * `describe()` says which of the two a failure was.
 */
export function trackPageProbe<T>(probe: () => Promise<T>): {
  probe: () => Promise<T>;
  describe: () => string;
} {
  let pendingSince: number | null = null;
  let probes = 0;
  let slowestMs = 0;
  return {
    probe: async () => {
      const startedAt = Date.now();
      pendingSince = startedAt;
      probes += 1;
      try {
        return await probe();
      } finally {
        slowestMs = Math.max(slowestMs, Date.now() - startedAt);
        pendingSince = null;
      }
    },
    describe: () =>
      pendingSince !== null
        ? `RENDERER UNRESPONSIVE: page probe #${probes} still pending after ${Date.now() - pendingSince}ms — value never observed (host stall, not an assertion result)`
        : `page answered ${probes} probe(s); slowest ${slowestMs}ms`,
  };
}

export interface Recorder {
  console: { type: string; text: string }[];
  pageErrors: string[];
  authResponses: { url: string; status: number }[];
}

export function attachRecorder(page: Page): Recorder {
  const rec: Recorder = { console: [], pageErrors: [], authResponses: [] };
  page.on('console', (m: ConsoleMessage) => rec.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e: Error) => rec.pageErrors.push(String(e)));
  page.on('response', (r: PlaywrightResponse) => {
    const u = r.url();
    if (u.includes('/api/auth/')) rec.authResponses.push({ url: u, status: r.status() });
  });
  return rec;
}

export async function clearAppSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sb-') || k === 'rose-session' || k === 'app-user') {
        localStorage.removeItem(k);
      }
    }
  });
}

/**
 * Inject the runner-generated session into localStorage so the app boots as
 * the same authenticated user in every worker. This avoids concurrent OTP
 * churn in local runs and is required because prod has no dev auto-login.
 *
 * Must be called AFTER page.goto() (localStorage requires an origin) but
 * BEFORE the app's auth hook runs — so call it right after goto, then reload.
 */
export async function injectSemanticSession(page: Page): Promise<void> {
  if (!INJECTED_SESSION) {
    throw new Error('SEMANTIC_SESSION env var not set — use run-semantic-tests.sh');
  }
  await page.addInitScript((session) => {
    window.localStorage.setItem('rose-session', session);
  }, INJECTED_SESSION);
  if (page.url() !== 'about:blank') {
    await acrossAppReload(page, () =>
      page.evaluate((session) => {
        window.localStorage.setItem('rose-session', session);
      }, INJECTED_SESSION),
    );
  }
}

const APP_RELOAD_RETRIES = 2;
const LATE_RELOAD_WINDOW_MS = 5_000;

/**
 * Production semantic runs start right after a deploy goes live, and later merges go live
 * while they run. The app then reloads itself once onto the newer build (AppVersion 'load'
 * check, or the index.html entry-load recovery), and an evaluate/reload that straddles that
 * navigation fails with "Execution context was destroyed" (a page.goto/reload it cancels, with
 * net::ERR_ABORTED). Retry `operation` only when a new main-frame document is
 * involved: one requested beyond the operation's own `ownNavigations` during the call or
 * within LATE_RELOAD_WINDOW_MS of the failure (wait for it to load; a cancelled goto rejects
 * before Playwright reports the reload that cancelled it, prod semantic run 43686929632), or
 * one whose request started just before the call and that loads within that window. At most
 * APP_RELOAD_RETRIES retries; any other error still fails the test.
 */
export async function acrossAppReload<T>(
  page: Page,
  operation: () => Promise<T>,
  ownNavigations = 0,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    let documents = 0;
    let loads = 0;
    let awaitingDocument = false;
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents++;
        awaitingDocument = true;
      }
    };
    const onLoaded = () => {
      loads++;
      awaitingDocument = false;
    };
    page.on('request', onRequest);
    page.on('domcontentloaded', onLoaded);
    try {
      return await operation();
    } catch (error) {
      if (retry >= APP_RELOAD_RETRIES) throw error;
      // A reload requested just before the call is visible only once its document loads, and
      // one that cancelled the operation's own navigation may be reported just after it. (A
      // failed navigation of its own can still load: Chrome commits an error page.)
      const deadline = Date.now() + LATE_RELOAD_WINDOW_MS;
      while (documents <= ownNavigations && loads <= ownNavigations && Date.now() < deadline)
        await page.waitForTimeout(100);
      if (documents > ownNavigations) {
        // The old document's context dies before the new one is parsed: wait for the latest
        // requested document itself, not the load state the old document already reached.
        await expect
          .poll(() => awaitingDocument, { message: 'reloaded document never loaded' })
          .toBe(false);
      } else if (loads <= ownNavigations) throw error;
    } finally {
      page.off('request', onRequest);
      page.off('domcontentloaded', onLoaded);
    }
  }
}

export async function expectInjectedSessionRecognized(page: Page): Promise<void> {
  await injectSemanticSession(page);
  await acrossAppReload(page, () =>
    page.evaluate((session) => {
      window.localStorage.setItem('rose-session', session);
    }, INJECTED_SESSION),
  );
  await acrossAppReload(page, () => page.reload({ waitUntil: 'domcontentloaded' }), 1);
  const sessionState = await acrossAppReload(page, () =>
    page.evaluate(() => {
      const raw = window.localStorage.getItem('rose-session');
      if (!raw) return { hasSession: false, isAnonymous: null };
      try {
        const session = JSON.parse(raw);
        return {
          hasSession: !!session?.access_token,
          isAnonymous: session?.user?.is_anonymous ?? null,
        };
      } catch {
        return { hasSession: false, isAnonymous: null };
      }
    }),
  );
  if (!sessionState.hasSession || sessionState.isAnonymous !== false) {
    throw new Error(`Injected session not recognised: ${JSON.stringify(sessionState)}`);
  }
}

export async function expectDevAuthenticated(page: Page, rec: Recorder): Promise<void> {
  await expect
    .poll(
      async () => {
        const authCompleted = rec.console.some(
          (m) =>
            m.text.includes('[Auth] Dev auto-login complete') ||
            m.text.includes('[Auth] Found non-anonymous session') ||
            (m.text.includes('[Auth] State changed') && m.text.includes('isFullySignedIn: true')),
        );
        if (authCompleted) return true;

        return page.evaluate(() => {
          const raw = window.localStorage.getItem('rose-session');
          if (!raw) return false;
          try {
            const session = JSON.parse(raw);
            return Boolean(session?.access_token && session?.user?.is_anonymous === false);
          } catch {
            return false;
          }
        });
      },
      { timeout: 15_000, message: 'Dev authenticated session was not established' },
    )
    .toBe(true);
}

/**
 * Dev builds auto-login with test credentials. To exercise the logged-out
 * flow we block the auto-login endpoints before navigation, then unblock
 * before the real login attempt.
 */
export async function forceLoggedOut(context: BrowserContext): Promise<void> {
  await context.route('**/api/auth/send-otp', (r) => r.abort());
  await context.route('**/api/auth/verify-otp', (r) => r.abort());
  await context.route('**/api/auth/anonymous', (r) => r.abort());
  await context.route('**/auth/v1/signup**', (r) => r.abort());
}

export async function allowAuthEndpoints(context: BrowserContext): Promise<void> {
  await context.unroute('**/api/auth/send-otp').catch(() => {});
  await context.unroute('**/api/auth/verify-otp').catch(() => {});
  await context.unroute('**/api/auth/anonymous').catch(() => {});
  await context.unroute('**/auth/v1/signup**').catch(() => {});
}

export async function createAgent(goal: string, startPhase?: 'plan' | 'execute'): Promise<string> {
  // Omit start_phase entirely to start in chat mode (per .claude/commands/loop.md).
  const body: Record<string, unknown> = { goal };
  if (startPhase) body.start_phase = startPhase;
  const userId = await resolveTestUserId();

  // Retry the specific transient "Failed to create agent" 500 — under
  // concurrent load the interactive create-agent transaction can momentarily
  // fail to acquire a pooled connection ("Unable to start a transaction").
  // The backend now retries this itself (providers/database.ts
  // runTransactionWithRetry), but the semantic gate spins up many agents at
  // once, so keep the same client-side safety net the blackbox helpers use.
  // Only this exact transient 500 is retried; every other failure throws.
  let lastError = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${BACKEND_URL}/api/agents`, {
      method: 'POST',
      headers: {
        'X-API-Key': TEST_API_KEY,
        'X-User-Id': userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json: unknown = raw;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      // Non-JSON body (proxy HTML, empty, etc.) — keep raw text in the error.
    }
    const id =
      (json as { agent_id?: string; id?: string }).agent_id ??
      (json as { agent_id?: string; id?: string }).id;
    if (res.ok && id) return id;

    const detail = typeof json === 'string' ? json.slice(0, 500) : JSON.stringify(json);
    lastError = `${res.status} ${detail}`;
    const transient =
      res.status === 500 &&
      (json as { error?: unknown }).error === 'Failed to create agent' &&
      attempt < 5;
    if (!transient) break;
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  throw new Error(`Agent creation failed: ${lastError}`);
}

interface BenchmarkTask {
  name: string;
  prompt: string;
  start_phase: 'plan' | 'execute' | null;
}

/** Load a benchmark task by name from agents/benchmarks/tasks.json so
 *  semantic tests stay in sync with the smoke suite's goals. */
export async function loadBenchmarkTask(name: string): Promise<BenchmarkTask> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const tasksPath = path.resolve(here, '../../agents/benchmarks/tasks.json');
  const raw = await fs.readFile(tasksPath, 'utf-8');
  const tasks = JSON.parse(raw) as BenchmarkTask[];
  const task = tasks.find((t) => t.name === name);
  if (!task) throw new Error(`Benchmark task not found: ${name}`);
  return task;
}

/**
 * Count rendered `[data-message-id]` rows after opening every collapsed work group.
 *
 * A live agent's assistant/tool rows fold into one collapsed trajectory work
 * group, and only user-facing rows (final answer, display, pinned question)
 * render at the top level. Counting top-level bubbles therefore waited for the
 * agent to FINISH, not for realtime rows to arrive: a slower code-agent CLI
 * (Codex on a healthy GPT lease) kept the count at 1 past the spec timeout.
 * Opening the disclosure renders the live rows themselves, which is what the
 * realtime prerequisites measure. Called from `expect.poll`, so a header that
 * re-renders mid-click is simply retried on the next poll.
 */
export async function countMessageRowsWithWorkExpanded(page: Page): Promise<number> {
  const collapsed = page.locator(
    '[data-testid="trajectory-work-group"] > button[aria-expanded="false"]',
  );
  for (let i = 0; i < 20 && (await collapsed.count()) > 0; i++) {
    await collapsed.first().click();
  }
  return page.locator('[data-message-id]').count();
}

export async function deleteAgent(agentId: string): Promise<void> {
  // Cleanup helper: surface failures via console.warn so leaked agents are
  // visible in CI logs, but don't throw — test teardown must not mask the
  // real assertion failure that caused it to run.
  try {
    const userId = await resolveTestUserId();
    const res = await fetch(`${BACKEND_URL}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': TEST_API_KEY, 'X-User-Id': userId },
    });
    if (!res.ok) {
      console.warn(`deleteAgent(${agentId}) returned ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`deleteAgent(${agentId}) network failure:`, err);
  }
}

export async function waitForTemporalWorkflow(agentId: string, timeoutMs: number): Promise<string> {
  const userId = await resolveTestUserId();
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not fetched';

  // Each poll gets its own short timeout so a single stalled socket (the
  // concurrent Playwright browser is streaming a live cloud agent and can
  // saturate the shared origin / event loop) can't consume the whole budget.
  // A stall or transient visibility response is retried — the backend persists
  // temporal_workflow_id within a few seconds, so any healthy poll in the
  // window resolves it.
  // Production edge stalls have reached ~2.5s while the persisted workflow was
  // already running (docs/rca/cases/2026-07-18-poll-without-per-request-timeout-
  // burns-whole-budget.md). The per-request bound MUST cover that stall window;
  // Aug 2026's 500ms regression made every GH Actions→Render poll abort under
  // load so the loop never observed an already-persisted workflow id (false
  // "did not persist temporal_workflow_id" / fetch-error abort). The 5s
  // FULL_LIFECYCLE_RATCHET_MS assertion is unchanged — this only bounds one
  // poll so retries can still reach a healthy read inside the 15s milestone.
  const PER_REQUEST_TIMEOUT_MS = 2_500;
  const POLL_INTERVAL_MS = 150;

  while (Date.now() < deadline) {
    const url = `${BACKEND_URL}/api/agents/${agentId}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': TEST_API_KEY, 'X-User-Id': userId },
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Aborted (per-request timeout) or transient network error — retry.
      lastState = `fetch-error ${err instanceof Error ? err.message : String(err)}`;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }
    const rawBody = await res.text();
    let data: Record<string, unknown>;
    try {
      data = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      data = { raw: rawBody };
    }
    const agent = data.agent as
      { temporal_workflow_id?: unknown; status?: unknown; status_message?: unknown } | undefined;
    const workflowId = agent?.temporal_workflow_id;
    if (res.ok && typeof workflowId === 'string' && workflowId !== '') return workflowId;

    lastState = `${res.status} ${JSON.stringify({
      temporal_workflow_id: workflowId ?? null,
      status: agent?.status ?? null,
      status_message: agent?.status_message ?? null,
    })}`;
    // A newly-created agent can briefly miss the live row. The archive fallback
    // reports that race as either 404 (absent) or 503 (its compact index is
    // warming). Both are retryable reads; other HTTP failures remain fatal.
    const isRetryableVisibilityResponse = res.status === 404 || res.status === 503;
    if (!res.ok && !isRetryableVisibilityResponse) {
      throw new Error(`Agent ${agentId} Temporal-start check failed: ${lastState}`);
    }
    if (agent?.status === 'FAILED' || agent?.status === 'CANCELLED') {
      throw new Error(`Agent ${agentId} terminated before Temporal startup: ${lastState}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Agent ${agentId} did not persist temporal_workflow_id within ${timeoutMs}ms; last=${lastState}`,
  );
}

export function hasUncaughtErrors(rec: Recorder): string[] {
  const textErrors = rec.console
    .filter((m) => {
      if (m.type !== 'error' && m.type !== 'warning') return false;
      const t = m.text.toLowerCase();
      return (
        t.includes('uncaught') ||
        t.includes('unhandledrejection') ||
        t.includes('unhandled promise rejection')
      );
    })
    .map((m) => m.text);
  return [...rec.pageErrors, ...textErrors];
}

export function has5xxAuth(rec: Recorder): { url: string; status: number }[] {
  return rec.authResponses.filter((r) => r.status >= 500);
}
