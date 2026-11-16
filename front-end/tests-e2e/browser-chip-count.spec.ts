/**
 * Semantic Test: Browser chip count == active browser agents.
 *
 * Regression for prod agent 85530622-66ed-4a88-8c51-bd50370bcd8e (2026-07-18):
 * four browser status chips stayed visible after every browser agent had
 * finished, because the worker's generic tool-error path posts the terminal
 * ERROR at tool-call scope (toolCallId only — no task_id/action_type) and the
 * panel derivation only recognized task-scoped terminal messages.
 *
 * Seeds real spawn_browser_agent TOOL messages through the same backend
 * endpoint the worker uses (POST /api/agents/:id/messages) and asserts the
 * rendered chip count tracks the number of active browser agents at every
 * lifecycle step:
 *   2 active tasks -> 2 chips
 *   task-scoped task_complete for A -> 1 chip
 *   tool-call-scoped ERROR for B (the prod failure shape) -> 0 chips
 */
import { expect, test, type Page } from '@playwright/test';

import {
  BACKEND_URL,
  FRONTEND_URL,
  HAS_INJECTED_SESSION,
  TEST_API_KEY,
  attachRecorder,
  createAgent,
  deleteAgent,
  expectDevAuthenticated,
  expectInjectedSessionRecognized,
  hasUncaughtErrors,
  injectSemanticSession,
  trackPageProbe,
} from './helpers';
import { quarantine } from '../src/tests/gate-progress/quarantine';

const LIVE_VIEW_URL = 'https://example.com/semantic-browser-live-view';
/** Per-wait budget for every chip-count step and the post-reload hydration gate. */
const CHIP_SETTLE_TIMEOUT_MS = 30_000;

async function postToolMessage(
  agentId: string,
  text: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, role: 'TOOL', metadata }),
  });
  if (!res.ok) {
    throw new Error(`postToolMessage failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

/**
 * Chip count must SETTLE at `expected` — poll until it reaches the value,
 * then hold through a grace period so late realtime events can't sneak a
 * phantom chip back in.
 */
async function expectChipCount(page: Page, expected: number, step: string): Promise<void> {
  const chips = page.locator('[data-testid="browser-status-chip"]');
  const tracked = trackPageProbe(() => chips.count());
  try {
    await expect
      .poll(tracked.probe, {
        timeout: CHIP_SETTLE_TIMEOUT_MS,
        message: `${step}: browser chip count never reached ${expected}`,
      })
      .toBe(expected);
  } catch (err) {
    // A frozen renderer never answers the probe, which otherwise reads exactly
    // like a wrong chip count. Name which one happened.
    throw new Error(`${tracked.describe()}\n${err instanceof Error ? err.message : String(err)}`);
  }
  await page.waitForTimeout(2_000);
  expect(await chips.count(), `${step}: chip count did not hold at ${expected}`).toBe(expected);
}

type ChipCountTest = (fixtures: { page: Page }) => Promise<void>;

const chipCountTest = 'visible browser chips always equal active browser agents';
/** FLAKY occurrence 764c43fc (PR #2259, NOT_INTRODUCED): still runs and reports, never blocks. */
const quarantinedChipCount = (run: ChipCountTest): ChipCountTest =>
  quarantine(
    {
      since: '2026-11-16',
      repair: 'pending-handoff:764c43fceeb84b16abc375a8b14cc00f',
      error: 'Error: page answered 32 probe(s); slowest 39ms',
      evidence: '.context/deploy-pipeline/rca/764c43fceeb84b16abc375a8b14cc00f.json',
    },
    run,
    { unit: `tests-e2e/browser-chip-count.spec.ts > browser-chip-count > ${chipCountTest}` },
  );

const chipCountRun = quarantinedChipCount(async ({ page }) => {
  const rec = attachRecorder(page);
  const agentId = await createAgent('Semantic test: browser chip count invariant (no real work).');

  try {
    if (HAS_INJECTED_SESSION) {
      await injectSemanticSession(page);
    }
    await page.goto(`${FRONTEND_URL}/?agent-id=${agentId}`, {
      waitUntil: 'domcontentloaded',
    });
    if (HAS_INJECTED_SESSION) {
      await expectInjectedSessionRecognized(page);
    } else {
      await expectDevAuthenticated(page, rec);
    }

    // ── Step 0: no browser agents -> no chips ─────────────────────────
    await expectChipCount(page, 0, 'before any browser task');

    // ── Step 1: two browser tasks start -> two chips ──────────────────
    await postToolMessage(agentId, '', {
      toolCallId: 'call-chip-a',
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      action_type: 'browser',
      task_id: 'chip-task-a',
      browser_url: `${LIVE_VIEW_URL}/a`,
    });
    await postToolMessage(agentId, '', {
      toolCallId: 'call-chip-b',
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      action_type: 'browser',
      task_id: 'chip-task-b',
      browser_url: `${LIVE_VIEW_URL}/b`,
    });
    await expectChipCount(page, 2, 'two active browser tasks');

    // ── Step 2: task A completes (task-scoped terminal) -> one chip ───
    await postToolMessage(agentId, '**Status**: ✅ COMPLETE', {
      toolCallId: 'call-chip-a',
      toolName: 'spawn_browser_agent',
      toolStatus: 'FINISHED',
      action_type: 'task_complete',
      task_id: 'chip-task-a',
    });
    await expectChipCount(page, 1, 'task A completed');

    // ── Step 3: task B's tool call fails at tool-call scope -> zero ───
    // Exact shape of the worker's generic tool-error message from the prod
    // incident: toolCallId only, no task_id, no action_type.
    await postToolMessage(agentId, "HTTPStatusError: Server error '500 Internal Server Error'", {
      toolCallId: 'call-chip-b',
      toolName: 'spawn_browser_agent',
      toolStatus: 'ERROR',
      title: 'spawn_browser_agent failed',
      error: true,
    });
    await expectChipCount(page, 0, 'task B failed via tool-call-scoped error');

    // ── Step 4: a retried logical tool call still owns one chip ───────
    // Production shape from e0c3c42e-2d4c-4b11-bb10-42d54280fc0e:
    // Temporal initialized a new task id under the same toolCallId. This
    // deliberately omits an old-attempt terminal event to cement the UI
    // invariant; the exact reason it was absent in the report is preliminary.
    await postToolMessage(agentId, '', {
      toolCallId: 'call-retried-browser',
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      action_type: 'browser',
      task_id: 'retry-task-old',
      browser_url: `${LIVE_VIEW_URL}/retry-old`,
    });
    await expectChipCount(page, 1, 'first attempt of retried browser call');
    await postToolMessage(agentId, '', {
      toolCallId: 'call-retried-browser',
      toolName: 'spawn_browser_agent',
      toolStatus: 'IN_PROGRESS',
      action_type: 'browser',
      task_id: 'retry-task-new',
      browser_url: `${LIVE_VIEW_URL}/retry-new`,
    });
    await expectChipCount(page, 1, 'replacement attempt supersedes stale chip');
    await postToolMessage(agentId, '**Status**: ✅ COMPLETE', {
      toolCallId: 'call-retried-browser',
      toolName: 'spawn_browser_agent',
      toolStatus: 'FINISHED',
      action_type: 'task_complete',
      task_id: 'retry-task-new',
    });
    await expectChipCount(page, 0, 'replacement attempt completed');

    // ── Invariant: reload agrees with realtime ────────────────────────
    // The chip count must be derived purely from persisted messages, so a
    // fresh hydration renders the same zero-chip state. Zero chips is also
    // true before the persisted messages load, so first wait for the
    // persisted terminal Browser Agent rows (A and the retried call done, B
    // failed); otherwise this step can pass before hydration has happened at
    // all. Rose Desktop folds them into one trajectory row carrying their
    // tool identity.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(
      page.locator(
        '[data-testid="trajectory-work-group"][data-tool-statuses~="spawn_browser_agent:FINISHED"][data-tool-statuses~="spawn_browser_agent:ERROR"]',
      ),
      'after reload: persisted browser terminal rows never hydrated',
    ).toHaveCount(1, { timeout: CHIP_SETTLE_TIMEOUT_MS });
    await expectChipCount(page, 0, 'after reload');

    expect(hasUncaughtErrors(rec), 'Uncaught errors during chip-count flow').toEqual([]);
  } finally {
    await deleteAgent(agentId);
  }
});

test.describe('browser-chip-count', () => {
  // Playwright resolves fixtures from a destructured first parameter.
  test(chipCountTest, async ({ page }) => chipCountRun({ page }));
});
