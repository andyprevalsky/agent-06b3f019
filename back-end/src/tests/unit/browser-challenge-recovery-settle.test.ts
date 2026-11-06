#!/usr/bin/env tsx
/**
 * H-20 (descend 2026-11-06): every recover-challenge candidate probe cost
 * 62-74 s because the classifier settle waited for Playwright `networkidle`
 * (capped at 60 s) before its only classification. Real storefronts keep
 * beacons/long-polls running and never go network-idle, so a candidate that
 * was already clean still waited the full cap, and a serial 8-config search
 * outran the worker's 300 s recover-challenge read deadline.
 *
 * Real Chromium against a local page whose network never goes idle; the LLM
 * classifier is stubbed through the `classify` seam.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import {
  CHALLENGE_LLM_SETTLE_MS,
  classifyPageAfterSettle,
  type ChallengeClassifierContext,
  type ChallengeClassificationWithUsage,
} from '../../providers/browser/challengeLlmClassifier';

// A usable page that polls forever (analytics/long-poll shape): never networkidle.
const BUSY_PAGE = `<!doctype html><title>Fresh Groceries</title><body><h1>Shop</h1>
<script>setInterval(() => fetch('/beacon?' + Date.now()).catch(() => {}), 150);</script></body>`;
// A static block page: goes network-idle immediately.
const STATIC_BLOCK_PAGE = `<!doctype html><title>Attention Required!</title><body>Blocked</body>`;

async function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/beacon')) {
      // Each beacon stays in flight briefly, like a real analytics call.
      setTimeout(() => res.end('ok'), 120);
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/static' ? STATIC_BLOCK_PAGE : BUSY_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function scriptedClassifier(verdicts: boolean[]) {
  const calls: ChallengeClassifierContext[] = [];
  const classify = async (
    context: ChallengeClassifierContext
  ): Promise<ChallengeClassificationWithUsage> => {
    calls.push(context);
    const challenged = verdicts[Math.min(calls.length - 1, verdicts.length - 1)];
    return {
      challenged,
      reason: challenged ? 'still challenged' : 'clean',
      usage: {
        call_site: 'challenge_llm_classifier',
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        actual_model: 'stub',
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as ChallengeClassificationWithUsage;
  };
  return { calls, classify };
}

async function classifyAt(
  browser: Browser,
  url: string,
  verdicts: boolean[],
  settleTimeoutMs = CHALLENGE_LLM_SETTLE_MS
) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const scripted = scriptedClassifier(verdicts);
    const started = Date.now();
    const result = await classifyPageAfterSettle(
      page,
      response,
      settleTimeoutMs,
      {},
      {
        classify: scripted.classify,
      }
    );
    return { result, elapsedMs: Date.now() - started, calls: scripted.calls.length };
  } finally {
    await context.close();
  }
}

/** The production failure: a clean page that never goes network-idle. */
async function testCleanBusyPageIsAcceptedWithoutWaitingOutTheSolverBudget(
  browser: Browser,
  base: string
): Promise<void> {
  const { result, elapsedMs, calls } = await classifyAt(browser, `${base}/`, [false]);
  assert.equal(result.clean, true);
  assert.equal(calls, 1, 'a clean first classification is final');
  assert.ok(
    elapsedMs < 20_000,
    `clean busy page took ${elapsedMs} ms before acceptance (60 s networkidle cap wasted)`
  );
}

/** A busy page still challenged early keeps the full solver budget for a second look. */
async function testBusyChallengedPageGetsSecondClassificationAfterSolverBudget(
  browser: Browser,
  base: string
): Promise<void> {
  const { result, elapsedMs, calls } = await classifyAt(browser, `${base}/`, [true, false], 12_000);
  assert.equal(calls, 2, 'challenged busy page must be re-classified after the solver budget');
  assert.equal(result.clean, true, 'a later clean classification wins');
  assert.equal(result.usages?.length, 2, 'both classifier calls are billed');
  assert.ok(elapsedMs >= 10_000, `second look came before the solver budget: ${elapsedMs} ms`);
}

/** A static block page goes idle quickly: one classification, no extra wait. */
async function testQuietChallengedPageIsClassifiedOnce(
  browser: Browser,
  base: string
): Promise<void> {
  const { result, elapsedMs, calls } = await classifyAt(browser, `${base}/static`, [true]);
  assert.equal(result.clean, false);
  assert.equal(calls, 1, 'a network-quiet page has nothing left to wait for');
  assert.ok(elapsedMs < 10_000, `quiet block page took ${elapsedMs} ms`);
}

async function run(): Promise<void> {
  const { server, base } = await startServer();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    await testCleanBusyPageIsAcceptedWithoutWaitingOutTheSolverBudget(browser, base);
    process.stdout.write('PASS clean busy page accepted without the 60 s networkidle wait\n');
    await testBusyChallengedPageGetsSecondClassificationAfterSolverBudget(browser, base);
    process.stdout.write('PASS busy challenged page re-classified after the solver budget\n');
    await testQuietChallengedPageIsClassifiedOnce(browser, base);
    process.stdout.write('PASS quiet block page classified once\n');
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
