import {
  expect,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Response,
} from '@playwright/test';

export const BACKEND_URL =
  process.env.BACKEND_URL ?? `http://localhost:${process.env.BACKEND_PORT ?? '3001'}`;
export const FRONTEND_URL =
  process.env.FRONTEND_URL ?? `http://localhost:${process.env.FRONTEND_PORT ?? '3002'}`;

/** Whether tests are running against production (set by run-semantic-tests.sh --prod). */
export const IS_PROD = process.env.SEMANTIC_PROD === '1';

/** One runner-generated session shared by every Playwright worker. */
const INJECTED_SESSION = process.env.SEMANTIC_SESSION ?? process.env.PROD_SESSION ?? '';
export const HAS_INJECTED_SESSION = INJECTED_SESSION !== '';

// Dev-only test credentials. The default key is the shared local-backend
// dev key (also documented in CLAUDE.md "Test Credentials"); override via
// env for CI or alternate environments.
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

async function resolveTestUserId(): Promise<string> {
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

export interface Recorder {
  console: { type: string; text: string }[];
  pageErrors: string[];
  authResponses: { url: string; status: number }[];
}

export function attachRecorder(page: Page): Recorder {
  const rec: Recorder = { console: [], pageErrors: [], authResponses: [] };
  page.on('console', (m: ConsoleMessage) => rec.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e: Error) => rec.pageErrors.push(String(e)));
  page.on('response', (r: Response) => {
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
    await page.evaluate((session) => {
      window.localStorage.setItem('rose-session', session);
    }, INJECTED_SESSION);
  }
}

export async function expectInjectedSessionRecognized(page: Page): Promise<void> {
  await injectSemanticSession(page);
  await page.evaluate((session) => {
    window.localStorage.setItem('rose-session', session);
  }, INJECTED_SESSION);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  const sessionState = await page.evaluate(() => {
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
  });
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
  // Omit start_phase entirely to start in chat mode (per CLAUDE.md).
  const body: Record<string, unknown> = { goal };
  if (startPhase) body.start_phase = startPhase;
  const userId = await resolveTestUserId();
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
  if (!res.ok || !id) {
    const body = typeof json === 'string' ? json.slice(0, 500) : JSON.stringify(json);
    throw new Error(`Agent creation failed: ${res.status} ${body}`);
  }
  return id;
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

export async function waitForTemporalWorkflow(
  agentId: string,
  timeoutMs: number,
): Promise<string> {
  const userId = await resolveTestUserId();
  const deadline = Date.now() + timeoutMs;
  let lastState = 'not fetched';

  while (Date.now() < deadline) {
    const res = await fetch(`${BACKEND_URL}/api/agents/${agentId}`, {
      headers: { 'X-API-Key': TEST_API_KEY, 'X-User-Id': userId },
    });
    const data = await parseJsonResponse(res);
    const agent = data.agent as
      | { temporal_workflow_id?: unknown; status?: unknown; status_message?: unknown }
      | undefined;
    const workflowId = agent?.temporal_workflow_id;
    if (res.ok && typeof workflowId === 'string' && workflowId !== '') return workflowId;

    lastState = `${res.status} ${JSON.stringify({
      temporal_workflow_id: workflowId ?? null,
      status: agent?.status ?? null,
      status_message: agent?.status_message ?? null,
    })}`;
    if (!res.ok && res.status !== 404) {
      throw new Error(`Agent ${agentId} Temporal-start check failed: ${lastState}`);
    }
    if (agent?.status === 'FAILED' || agent?.status === 'CANCELLED') {
      throw new Error(`Agent ${agentId} terminated before Temporal startup: ${lastState}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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
