/**
 * Semantic Test: Agent Realtime Updates.
 *
 * Creates an agent via the backend API, navigates to the agent page, and
 * verifies that realtime broadcast messages flow into the DOM through the
 * Supabase channel subscription. Asserts the no-duplicate-messages invariant
 * by checking unique `data-message-id` count against total rendered bubbles.
 *
 * Grounded against the running app — selectors and console log patterns were
 * verified against live Chromium before being committed here.
 */
import { expect, test } from '@playwright/test';

import {
  FRONTEND_URL,
  HAS_INJECTED_SESSION,
  attachRecorder,
  countMessageRowsWithWorkExpanded,
  createAgent,
  deleteAgent,
  expectDevAuthenticated,
  expectInjectedSessionRecognized,
  hasUncaughtErrors,
  injectSemanticSession,
  loadBenchmarkTask,
} from './helpers';
import { quarantine } from '../src/tests/gate-progress/quarantine';

const REALTIME_UNIT =
  'tests-e2e/agent-realtime.spec.ts > agent-realtime > new agent produces realtime messages with no duplicates';

test.describe('agent-realtime', () => {
  test('new agent produces realtime messages with no duplicates', async ({ page }) => {
    await quarantine(
      {
        since: '2026-11-12',
        repair: 'pending-handoff:62c43bbeac124a3391c8ab3206e6e888',
        error:
          "SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.",
        evidence:
          'PR1865 round 63 semantic-stack agent-realtime FLAKY: agent-authored display HTML in the sandboxed DisplayMediaGroup iframe read localStorage; child-frame pageerror counted by hasUncaughtErrors',
      },
      async () => {
        const rec = attachRecorder(page);
        // Reuse the `claude-code-agent` smoke prompt so semantic stays in lockstep
        // with the benchmark suite. Start in chat mode (omit start_phase) — the
        // agent's chat-mode reply streams enough bubbles to exercise the dedup
        // invariant without needing the full Temporal workflow to complete.
        const task = await loadBenchmarkTask('claude-code-agent');
        const agentId = await createAgent(task.prompt);

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

          // ── Step 1: Channel subscribes ─────────────────────────────────────
          await expect
            .poll(
              () =>
                rec.console.some(
                  (m) =>
                    m.text.includes(`agent:${agentId.slice(0, 10)}`) &&
                    m.text.includes('status: SUBSCRIBED'),
                ),
              { timeout: 30_000, message: 'Agent channel never reached SUBSCRIBED' },
            )
            .toBe(true);

          // ── Step 2: Wait for user + assistant bubbles ─────────────────────
          // Chat mode produces: user goal bubble, then an assistant stream that
          // updates a single message_id over time. ≥2 is enough to prove realtime
          // broadcasts flowed AND to exercise the dedup invariant over streaming.
          // Live assistant/tool rows fold into a collapsed work group, so open it
          // to count the rows themselves rather than waiting for the final answer.
          const messageLocator = page.locator('[data-message-id]');
          await expect
            .poll(() => countMessageRowsWithWorkExpanded(page), {
              timeout: 180_000,
              message: 'Agent never produced ≥2 realtime message bubbles',
            })
            .toBeGreaterThanOrEqual(2);

          // Grace period for trailing streaming events before snapshot so the
          // dedup invariant also covers end-of-stream rendering.
          await page.waitForTimeout(10_000);

          // ── Step 3: Dedup invariant (NO DUPLICATE MESSAGE IDS) ────────────
          const rendered = await messageLocator.evaluateAll((els) =>
            els.map((e) => ({
              id: e.getAttribute('data-message-id'),
              role: e.getAttribute('data-message-role'),
              text: (e.textContent ?? '').trim().slice(0, 120),
            })),
          );

          const ids = rendered.map((r) => r.id).filter((id): id is string => !!id);
          const unique = new Set(ids);
          const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
          expect(
            duplicates,
            `Duplicate message bubbles rendered: ${duplicates.join(', ')}`,
          ).toEqual([]);
          expect(unique.size, 'Mismatch between unique and total message ids').toBe(ids.length);

          // ── Step 4: Substantive agent output ──────────────────────────────
          // At least one non-user bubble with body text — proves the assistant
          // stream reached the UI, not just the user's goal echo.
          const nonUserWithText = rendered.filter(
            (r) => r.role && r.role !== 'user' && r.text && r.text.length > 0,
          );
          expect(
            nonUserWithText.length,
            `Expected ≥1 non-user bubble with content; got: ${JSON.stringify(rendered)}`,
          ).toBeGreaterThanOrEqual(1);

          // ── Invariants ─────────────────────────────────────────────────────
          const channelErrors = rec.console.filter(
            (m) =>
              m.text.includes(`agent:${agentId.slice(0, 10)}`) && m.text.includes('CHANNEL_ERROR'),
          );
          expect(
            channelErrors.map((m) => m.text),
            'Agent channel emitted CHANNEL_ERROR',
          ).toEqual([]);

          const firstSignedInIndex = rec.console.findIndex(
            (m) =>
              m.text.includes('[Auth] State changed') && m.text.includes('isFullySignedIn: true'),
          );
          const authMessagesAfterSignIn =
            firstSignedInIndex === -1 ? [] : rec.console.slice(firstSignedInIndex + 1);
          const anonRegression = authMessagesAfterSignIn.filter(
            (m) => m.text.includes('[Auth] State changed') && m.text.includes('isAnonymous: true'),
          );
          expect(
            anonRegression.map((m) => m.text),
            'Auth regressed to anonymous after initial login',
          ).toEqual([]);

          expect(hasUncaughtErrors(rec), 'Uncaught errors during agent-realtime flow').toEqual([]);
        } finally {
          await deleteAgent(agentId);
        }
      },
      { unit: REALTIME_UNIT },
    )({});
  });
});
