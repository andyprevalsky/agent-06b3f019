#!/usr/bin/env tsx
/**
 * Black-box tests for /api/agents
 *
 * Cases run serially within this domain. Several routes start background work
 * and the suite also asserts shared capture buffers, so serial execution keeps
 * the same contract coverage without cross-case cleanup races.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/agents.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/agents.blackbox.ts
 */

import {
  BASE_URL,
  EFFECTIVE_CASE_CONCURRENCY,
  RUN_ID,
  checkCaptureAvailable,
  prisma,
  runTest,
  runWithConcurrency,
  tests,
  trackedAgentIds,
  type TestResult,
} from './agents-blackbox-harness';

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runAll(): Promise<void> {
  await import('./agents-account.cases');
  await import('./agents-list-create.cases');
  await import('./agents-sidebar-speed.cases');
  await import('./agents-messages.cases');
  await import('./agents-message-storage.cases');
  await import('./agents-message-resume.cases');
  await import('./agents-status-bootstrap.cases');
  await import('./agents-lifecycle.cases');
  await import('./agents-sidebar-organization.cases');
  await import('./agents-last-user-message.cases');
  await import('./agents-search.cases');
  await import('./agents-cost-resume.cases');
  await import('./agents-configuration.cases');
  await import('./agents-edge-routes.cases');
  await import('./agents-batch.cases');
  await import('./agents-liveness-reconcile.cases');
  await import('./agents-stuck-bug-report.cases');
  await import('./agents-followup-cleanup-obligation.cases');
  await import('./agents-terminal-browser-release.cases');
  await import('./agents-cutover-subagent-close.cases');
  await import('./agents-cutover-replace-not-failed.cases');
  await import('./agents-agent-messages.cases');
  await import('./agents-agent-messages-code.cases');
  await import('./agents-agent-message-guard.cases');
  await import('./agents-agent-tree.cases');
  await import('./agents-agent-address.cases');
  await import('./agents-agent-control.cases');
  const {
    testBoundary_createAgentModelPricing,
    testBoundary_createAgentGeoip,
    testBoundary_createAgentGithubRepo,
    testBoundary_createAgentCallOrdering,
    testBoundary_validationShortCircuitNoOutbound,
  } = await import('./agents-boundary.cases');

  console.log(
    `Agents Black-box Tests (${tests.length} cases, concurrency=${EFFECTIVE_CASE_CONCURRENCY}, runId=${RUN_ID})\n`
  );
  console.log(`Testing against: ${BASE_URL}\n`);

  // Phase 1: Route contract tests
  console.log(
    `Running ${tests.length} route contract tests (concurrency=${EFFECTIVE_CASE_CONCURRENCY})...`
  );
  const parallelResults = await runWithConcurrency(
    tests,
    EFFECTIVE_CASE_CONCURRENCY,
    async (tc) => {
      console.log(`  RUN   ${tc.name}`);
      const result = await runTest(tc.name, tc.fn);
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name} (${result.duration}ms)`);
      return result;
    }
  );

  // Phase 2: Sequential boundary capture tests (shared capture buffer)
  const captureAvailable = await checkCaptureAvailable();
  const sequentialTests: { name: string; fn: () => Promise<void> }[] = [];

  if (captureAvailable) {
    sequentialTests.push(
      {
        name: 'boundary — create agent calls OpenRouter for model pricing',
        fn: testBoundary_createAgentModelPricing,
      },
      {
        name: 'boundary — create agent calls ip-api for geolocation',
        fn: testBoundary_createAgentGeoip,
      },
      {
        name: 'boundary — create agent calls GitHub for repo creation',
        fn: testBoundary_createAgentGithubRepo,
      },
      {
        name: 'boundary — create agent call ordering (sync before fire-and-forget)',
        fn: testBoundary_createAgentCallOrdering,
      },
      {
        // Run last: Phase 1 fire-and-forget handlers (GitHub, chat) may still be
        // making outbound calls when Phase 2 starts. Running this test last gives
        // those background calls time to drain before we assert zero outbound calls.
        name: 'boundary — validation short-circuit makes no outbound calls',
        fn: testBoundary_validationShortCircuitNoOutbound,
      }
    );
  } else {
    console.log(
      '\n  [info] Capture not available (BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) — skipping boundary tests'
    );
  }

  const sequentialResults: TestResult[] = [];
  if (sequentialTests.length > 0) {
    console.log(`\nRunning ${sequentialTests.length} sequential boundary tests...`);
    for (const tc of sequentialTests) {
      const result = await runTest(tc.name, tc.fn);
      sequentialResults.push(result);
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name} (${result.duration}ms)`);
    }
  }

  // Summary
  const allResults = [...parallelResults, ...sequentialResults];
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(60));
  for (const r of allResults) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name} (${r.duration}ms)`);
  }

  if (failed > 0) {
    console.log(`\nFAILURES (${failed}):`);
    for (const r of allResults.filter((r) => !r.passed)) {
      console.log(`  ${r.name}: ${r.error}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${allResults.length} total\n`);

  // Best-effort cleanup of any tracked agents that were not deleted by their test
  for (const agentId of trackedAgentIds) {
    try {
      await prisma.agent.update({
        where: { id: agentId },
        data: { deletedAt: new Date() },
      });
    } catch {
      // Agent may already be cleaned up or not exist
    }
  }

  await prisma.$disconnect();

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runAll().catch((error) => {
  console.error('\nCrashed:', error);
  process.exit(1);
});
