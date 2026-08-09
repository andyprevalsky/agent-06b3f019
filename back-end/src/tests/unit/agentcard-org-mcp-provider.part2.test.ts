#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
  orgRetryDeadlineAtMs,
} from '../../providers/agentcard/org-runtime';
import { AgentCardOrgMcpProvider } from '../../providers/card-provider';

const ORG_RUNTIME_ENV_NAMES = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
] as const;

type TimeoutFn = typeof globalThis.setTimeout;

function toolResult(payload: Record<string, unknown>): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Runs `run` on a virtual clock: `Date.now()` advances by exactly the milliseconds code asks
 * `setTimeout` to sleep, and every timer fires immediately.
 *
 * That makes a retry schedule that would take minutes of wall clock measurable in milliseconds,
 * and makes the measurement exact rather than machine-load dependent.
 */
async function onVirtualClock<T>(run: (elapsedMs: () => number) => Promise<T>): Promise<T> {
  const realDateNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const startedAtMs = 1_700_000_000_000;
  let nowMs = startedAtMs;
  Date.now = () => nowMs;
  const virtualSetTimeout = (
    handler: (...args: unknown[]) => void,
    timeoutMs?: number,
    ...args: unknown[]
  ): ReturnType<TimeoutFn> => {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) nowMs += timeoutMs;
    return realSetTimeout(handler, 0, ...args);
  };
  globalThis.setTimeout = virtualSetTimeout as unknown as TimeoutFn;
  try {
    return await run(() => nowMs - startedAtMs);
  } finally {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
  }
}

/** The AgentCard throttle body, verbatim, carrying an ABSOLUTE epoch-ms window reset. */
function throttleBody(windowResetAtMs: number): string {
  return (
    'Streamable HTTP error: Error POSTing to endpoint: {"error":"Rate limit exceeded",' +
    `"message":"Too many requests. Limit: 120 requests per minute.","retryAfter":${windowResetAtMs}}`
  );
}

/**
 * Regression: the org runtime's rate-limit delay budget bounds ONE `callTool`. The transfer
 * visibility poll LOOPS over `callTool` at TWO reads per observation, so a per-call budget
 * multiplied — its 12 production reads could each add their own 30s budget (360s), turning a ~10s
 * poll into a multi-minute mint that overruns the upstream request/activity timeout. The poll now
 * takes ONE deadline before the loop and threads it through every read, and surrenders with the
 * runtime's typed 429 once that single budget is spent.
 *
 * `delayMs: 0` zeroes the poll's own schedule so the measured elapsed time IS the throttle delay
 * the runtime added; the observation count is unchanged.
 */
async function assertTransferVisibilityPollSharesOneRetryBudget(): Promise<void> {
  const originalEnv = Object.fromEntries(
    ORG_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]])
  );
  try {
    for (const name of ORG_RUNTIME_ENV_NAMES) delete process.env[name];
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'direct-org-token';

    await onVirtualClock(async (elapsedMs) => {
      const budgetMs = orgRetryDeadlineAtMs() - Date.now();
      // A window that re-throttles as soon as it refills: every `list_transfers` read is refused
      // with the reset measured in production (13.8s out) and succeeds on the retry after it. That
      // is the shape that multiplies — each call individually stays inside a 30s budget.
      let windowResetAtMs = 0;
      const runtime = new AgentCardOrgRuntime(async (_token, toolName) => {
        if (toolName === 'create_card') {
          return toolResult({ status: 'created', card_id: 'card-throttled' });
        }
        if (toolName === 'get_card_details') {
          return toolResult({
            pan: '4242424242424242',
            cvv: '123',
            expiry: '07/28',
            balance_cents: 4396,
            status: 'OPEN',
          });
        }
        if (Date.now() < windowResetAtMs) throw new Error(throttleBody(windowResetAtMs));
        windowResetAtMs = Date.now() + 13_800;
        return toolResult({ transfers: [] });
      });
      const provider = new AgentCardOrgMcpProvider(
        'cardholder-123',
        (name, args, deadlineAtMs) => runtime.callTool(name, args, deadlineAtMs),
        { attempts: 20, delayMs: 0 }
      );

      let mintError: unknown;
      try {
        await provider.mintCard({
          amountCents: 4396,
          fundsSource: 'company_flow',
          idempotencyKey: 'purchase:throttled-visibility',
        });
      } catch (error) {
        mintError = error;
      }

      assert.ok(
        elapsedMs() > 0,
        'the throttle must actually have been waited on, or this measures nothing'
      );
      assert.ok(
        elapsedMs() <= budgetMs,
        `a looping caller must never accumulate more than one retry budget: the transfer ` +
          `visibility poll added ${elapsedMs()}ms of throttle delay against a ${budgetMs}ms budget`
      );
      assert.ok(
        mintError instanceof AgentCardOrgRuntimeError &&
          mintError.code === 'agentcard_org_mcp_rate_limited',
        'a spent budget must surrender the poll with the runtime typed 429, not grind on'
      );
    });
  } finally {
    for (const name of ORG_RUNTIME_ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function main(): Promise<void> {
  await assertTransferVisibilityPollSharesOneRetryBudget();
  process.stdout.write('AgentCard organization MCP provider retry-budget tests passed\n');
}

void main();
