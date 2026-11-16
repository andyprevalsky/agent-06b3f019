#!/usr/bin/env tsx
/**
 * Black-box tests for /api/send-sms
 *
 * Domain surface:
 *   POST /api/send-sms           — send SMS via Surge API (auth required, internal)
 *   POST /api/send-sms/direct    — send SMS by user_id lookup (auth required, internal)
 *   POST /api/send-sms/notify    — lifecycle SMS notifications (auth required, internal)
 *
 * Boundary capture coverage:
 *   Every endpoint that triggers an outbound Surge API call is captured and asserted on:
 *   - Surge Messages API (POST /): exact URL, method, headers, body params {to, body}
 *   - Surge Messages API (POST /direct): same via sendSms() helper
 *   - Surge Messages API (POST /notify): same via outbound event handlers -> sendSms()
 *   Validation failures are verified to produce 0 outbound calls.
 *
 * Invariants covered:
 *   - auth boundary: all endpoints require API key authentication
 *   - error-surface: all error responses include { error: string }
 *   - concurrency: 10 parallel validation requests return consistent 400s
 *   - same-input reproducibility: 3 identical requests return identical responses
 *   - boundary param: exact params sent to Surge API are captured and asserted
 *   - cleanup: shortcode records created by write_lock events are the only mutable state;
 *     they auto-expire after 24h and use unique codes (no collision with other tests)
 *   - harness independence: no background jobs involved
 *   - observability: covered by the runner's manifest and artifact directory
 *
 * Invariants not applicable:
 *   - idempotency/retry: repeated completion events send at most one SMS per agent
 *   - read-after-write: no read endpoints; responses are immediate
 *   - state transition: only /notify agent deletion check; tested via contract tests
 *   - ordering/pagination: no list endpoints
 *   - atomicity: no multi-step transactions (shortcode + SMS are independent)
 *   - referential integrity: SmsShortcode has no FKs; agent lookup is a soft check
 *   - event/job cardinality: no async events emitted by these endpoints
 *   - scope: kickoff and completion notifications go only to agents the
 *     SMS/WhatsApp agent created, replied to, or raised the budget of; relays
 *     are not touches (behavior-6)
 *   - duplication prevention: completion notifications are deduplicated per agent;
 *     write_lock notifications send only the initial SMS per attention
 *     request and skip reminder payloads plus duplicate initial sends
 *   - tenant isolation: all endpoints are internal (API key auth), not user-scoped
 *   - time/clock: no timestamps in response
 *   - call ordering: each endpoint makes at most 1 outbound Surge call
 *
 * Usage:
 *   npx tsx src/tests/blackbox/send-sms.blackbox.ts
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/send-sms.blackbox.ts
 */

import {
  cleanupTestUser,
  BASE_URL,
  CASE_CONCURRENCY,
  checkCaptureAvailable,
  type TestResult,
  runTest,
  createTestUser,
  prisma,
} from './send-sms.support';
import {
  testSend_noAuth,
  testSend_missingPhone,
  testSend_missingMessage,
  testSend_emptyPhone,
  testSend_emptyMessage,
  testSend_happyPath,
  testSend_surgeApiError,
  testSend_surgeNetworkFailure,
  testSend_responseContentType,
  testDirect_noAuth,
  testDirect_missingBothFields,
  testDirect_missingUserId,
  testDirect_missingMessage,
  testDirect_unknownUser,
  testDirect_happyPath,
  testNotify_noAuth,
  testNotify_emptyBody,
  testNotify_invalidEventType,
  testNotify_missingUserId,
  testNotify_missingAgentId,
  testNotify_missingEventType,
  testNotify_zodErrorShape,
  testNotify_allValidEventTypes,
  testNotify_completionHappyPath,
  testNotify_unknownAgentSkipped,
  testNotify_deletedAgentSkipped,
  testNotify_responseContentType,
} from './send-sms.behavior-1';
import {
  testAuth_allEndpointsRequireAuth,
  testAuth_invalidApiKey,
  testErrorSurface_wrongMethodsSend,
  testErrorSurface_wrongMethodsDirect,
  testErrorSurface_wrongMethodsNotify,
  testErrorSurface_allValidationErrorsHaveErrorField,
  testConcurrency_parallelSendValidation,
  testConcurrency_parallelNotifyValidation,
  testReproducibility_sameInputSameOutput,
  testBoundary_sendCallsSurgeApi,
  testBoundary_directCallsSurgeApi,
  testBoundary_notifyCompletionCallsSurgeApi,
  testBoundary_notifyAgentStartedCallsSurgeApi,
} from './send-sms.behavior-2';
import {
  testBoundary_sendValidationNoOutbound,
  testBoundary_directValidationNoOutbound,
  testBoundary_notifyValidationNoOutbound,
  testBoundary_directUnknownUserNoOutbound,
  testBoundary_notifyWriteLockPaymentCardEnriched,
  testBoundary_notifyAgentStartedSuppressedForBenchmark,
  testBoundary_notifyCompletionPreviewForBenchmark,
} from './send-sms.behavior-5';
import {
  testBoundary_notifyAgentStartedKeepsLongGoalInsideAgent,
  testBoundary_notificationRepairsProviderRejection,
  testBoundary_notificationSummarizesInternalGoalLinks,
  testBoundary_notificationRequiresCanonicalActionLink,
  testBoundary_notificationDoesNotRewriteNonContentRejections,
  testBoundary_notificationRepairsHttp400BodyRejection,
  testBoundary_notificationDoesNotRetryAmbiguousFailure,
  testRealLlm_notificationKeepsDeliveryContract,
  testBoundary_notifyCostLimitIncludesTaskGoal,
} from './send-sms.behavior-3';
import {
  testBoundary_startTextIsComposedWithTrailingShareLink,
  testBoundary_finishTextIsComposedFromBoundedResults,
} from './send-sms.behavior-7';
import {
  testBoundary_notifyWriteLockNaturalLanguageOnly,
  testBoundary_notifyWriteLockSendsInitialOnly,
  testBoundary_notifyWriteLockStripsMarkdownAndKeepsFullDraft,
  testBoundary_notifyAgentCardSetupIncludesSetupLink,
  testBoundary_notifyWriteLockStructuredMms,
  testBoundary_notifyWriteLockGenericWriteReturn,
} from './send-sms.behavior-4';
import {
  testCompletionScope_smsCreatedAgentNotified,
  testCompletionScope_smsSupervisorReplyNotified,
  testCompletionScope_smsBudgetIncreaseNotified,
  testCompletionScope_smsReplyToChildNotifiesRoot,
  testCompletionScope_replyToChildWithoutBusIdNotifiesRoot,
  testCompletionScope_whatsappCreatedAgentNotified,
  testCompletionScope_whatsappSupervisorReplyNotified,
  testCompletionScope_untouchedWebAgentNotNotified,
  testTouchScope_relaysAreNotTouches,
  testTouchScope_replyOverridesLegacyRelayMarker,
  testKickoffScope_untouchedAgentSilentQuestionsStillSent,
  testKickoffScope_messagingCreatedAgentKickoffSent,
} from './send-sms.behavior-6';

// ==================== RUNNER ====================
interface TestGroup {
  name: string;
  tests: { name: string; fn: () => Promise<void> }[];
}

async function runAll() {
  console.log('Send SMS Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}`);
  console.log(`Case concurrency: ${CASE_CONCURRENCY}\n`);

  const captureAvailable = await checkCaptureAvailable();

  const parallelGroups: TestGroup[] = [
    {
      name: 'POST / (send) -- contract',
      tests: [
        { name: 'no auth -> 401', fn: testSend_noAuth },
        { name: 'missing phone -> 400', fn: testSend_missingPhone },
        { name: 'missing message -> 400', fn: testSend_missingMessage },
        { name: 'empty phone -> 400', fn: testSend_emptyPhone },
        { name: 'empty message -> 400', fn: testSend_emptyMessage },
        {
          name: 'happy path (200 or Surge error)',
          fn: testSend_happyPath,
        },
        ...(captureAvailable
          ? [
              {
                name: 'Surge API error -> provider status',
                fn: testSend_surgeApiError,
              },
              {
                name: 'Surge network failure -> 500',
                fn: testSend_surgeNetworkFailure,
              },
            ]
          : []),
        {
          name: 'response Content-Type: application/json',
          fn: testSend_responseContentType,
        },
      ],
    },
    {
      name: 'POST /direct -- contract',
      tests: [
        { name: 'no auth -> 401', fn: testDirect_noAuth },
        {
          name: 'missing both fields -> 400',
          fn: testDirect_missingBothFields,
        },
        { name: 'missing user_id -> 400', fn: testDirect_missingUserId },
        { name: 'missing message -> 400', fn: testDirect_missingMessage },
        {
          name: 'unknown user -> 400 (no phone)',
          fn: testDirect_unknownUser,
        },
        { name: 'happy path', fn: testDirect_happyPath },
      ],
    },
    {
      name: 'POST /notify -- contract',
      tests: [
        { name: 'no auth -> 401', fn: testNotify_noAuth },
        { name: 'empty body -> 400', fn: testNotify_emptyBody },
        {
          name: 'invalid event type -> 400',
          fn: testNotify_invalidEventType,
        },
        { name: 'missing user_id -> 400', fn: testNotify_missingUserId },
        {
          name: 'missing agent_id -> 400',
          fn: testNotify_missingAgentId,
        },
        {
          name: 'missing event_type -> 400',
          fn: testNotify_missingEventType,
        },
        { name: 'Zod error includes details', fn: testNotify_zodErrorShape },
        {
          name: 'all valid event types -> 200',
          fn: testNotify_allValidEventTypes,
        },
        {
          name: 'completion happy path',
          fn: testNotify_completionHappyPath,
        },
        {
          name: 'unknown agent -> skipped',
          fn: testNotify_unknownAgentSkipped,
        },
        {
          name: 'deleted agent -> skipped',
          fn: testNotify_deletedAgentSkipped,
        },
        {
          name: 'response Content-Type: application/json',
          fn: testNotify_responseContentType,
        },
      ],
    },
    {
      name: 'Auth boundary',
      tests: [
        {
          name: 'all endpoints require auth',
          fn: testAuth_allEndpointsRequireAuth,
        },
        { name: 'invalid API key rejected', fn: testAuth_invalidApiKey },
      ],
    },
    {
      name: 'Error surface',
      tests: [
        {
          name: 'wrong methods on / rejected',
          fn: testErrorSurface_wrongMethodsSend,
        },
        {
          name: 'wrong methods on /direct rejected',
          fn: testErrorSurface_wrongMethodsDirect,
        },
        {
          name: 'wrong methods on /notify rejected',
          fn: testErrorSurface_wrongMethodsNotify,
        },
        {
          name: 'all validation errors include error field',
          fn: testErrorSurface_allValidationErrorsHaveErrorField,
        },
      ],
    },
    {
      name: 'Concurrency',
      tests: [
        {
          name: '10 parallel send validations -> 400',
          fn: testConcurrency_parallelSendValidation,
        },
        {
          name: '10 parallel notify validations -> 400',
          fn: testConcurrency_parallelNotifyValidation,
        },
      ],
    },
    {
      name: 'Reproducibility',
      tests: [
        {
          name: 'same input -> same output (3x)',
          fn: testReproducibility_sameInputSameOutput,
        },
      ],
    },
  ];

  const sequentialGroups: TestGroup[] = [];

  if (captureAvailable) {
    sequentialGroups.push({
      name: 'Boundary capture',
      tests: [
        {
          name: 'send validation -> 0 outbound calls',
          fn: testBoundary_sendValidationNoOutbound,
        },
        {
          name: 'direct validation -> 0 outbound calls',
          fn: testBoundary_directValidationNoOutbound,
        },
        {
          name: 'notify validation -> 0 outbound calls',
          fn: testBoundary_notifyValidationNoOutbound,
        },
        {
          name: 'direct unknown user -> 0 outbound calls',
          fn: testBoundary_directUnknownUserNoOutbound,
        },
        {
          name: 'send calls Surge API with exact params',
          fn: testBoundary_sendCallsSurgeApi,
        },
        {
          name: 'direct calls Surge API with exact params',
          fn: testBoundary_directCallsSurgeApi,
        },
        {
          name: 'notify completion calls Surge API',
          fn: testBoundary_notifyCompletionCallsSurgeApi,
        },
        {
          name: 'notify agent_started calls Surge API',
          fn: testBoundary_notifyAgentStartedCallsSurgeApi,
        },
        {
          name: 'notify agent_started keeps long goal inside agent',
          fn: testBoundary_notifyAgentStartedKeepsLongGoalInsideAgent,
        },
        {
          name: 'notify agent_started sends one composed sentence with the share link last',
          fn: testBoundary_startTextIsComposedWithTrailingShareLink,
        },
        {
          name: 'notify completion composes a short outcome from bounded results',
          fn: testBoundary_finishTextIsComposedFromBoundedResults,
        },
        {
          name: 'notify feeds provider rejection to model and sends correction',
          fn: testBoundary_notificationRepairsProviderRejection,
        },
        {
          name: 'notify summarizes internal goal links while preserving the task',
          fn: testBoundary_notificationSummarizesInternalGoalLinks,
        },
        {
          name: 'notify repairs omission of the exact canonical action link',
          fn: testBoundary_notificationRequiresCanonicalActionLink,
        },
        {
          name: 'notify does not rewrite auth, routing, or rate-limit rejections',
          fn: testBoundary_notificationDoesNotRewriteNonContentRejections,
        },
        {
          name: 'notify repairs an explicit HTTP 400 body rejection',
          fn: testBoundary_notificationRepairsHttp400BodyRejection,
        },
        {
          name: 'notify does not retry ambiguous gateway failure',
          fn: testBoundary_notificationDoesNotRetryAmbiguousFailure,
        },
        {
          name: 'real notification model keeps delivery contract (opt-in)',
          fn: testRealLlm_notificationKeepsDeliveryContract,
        },
        {
          name: 'notify cost_limit includes task goal',
          fn: testBoundary_notifyCostLimitIncludesTaskGoal,
        },
        {
          name: 'notify write_lock uses natural language only',
          fn: testBoundary_notifyWriteLockNaturalLanguageOnly,
        },
        {
          name: 'notify write_lock sends only the initial SMS',
          fn: testBoundary_notifyWriteLockSendsInitialOnly,
        },
        {
          name: 'notify write_lock strips markdown and keeps full draft',
          fn: testBoundary_notifyWriteLockStripsMarkdownAndKeepsFullDraft,
        },
        {
          name: 'notify agentcard_setup includes setup link',
          fn: testBoundary_notifyAgentCardSetupIncludesSetupLink,
        },
        {
          name: 'notify write_lock sends structured MMS with image',
          fn: testBoundary_notifyWriteLockStructuredMms,
        },
        {
          name: 'notify write_lock renders generic_write return details',
          fn: testBoundary_notifyWriteLockGenericWriteReturn,
        },
        {
          name: 'notify write_lock renders payment card (merchant/reviews/cost/link)',
          fn: testBoundary_notifyWriteLockPaymentCardEnriched,
        },
        {
          name: 'notify agent_started suppressed for benchmark agent',
          fn: testBoundary_notifyAgentStartedSuppressedForBenchmark,
        },
        {
          name: 'notify completion renders benchmark preview without outbound SMS',
          fn: testBoundary_notifyCompletionPreviewForBenchmark,
        },
      ],
    });
    sequentialGroups.push({
      name: 'Kickoff and completion scope (touched from the phone)',
      tests: [
        { name: 'SMS-created agent -> notified', fn: testCompletionScope_smsCreatedAgentNotified },
        {
          name: 'web agent the SMS agent replied to -> notified',
          fn: testCompletionScope_smsSupervisorReplyNotified,
        },
        {
          name: 'web agent whose budget the SMS agent raised -> notified',
          fn: testCompletionScope_smsBudgetIncreaseNotified,
        },
        {
          name: 'web root whose child the SMS agent replied to -> notified (tree marker only)',
          fn: testCompletionScope_smsReplyToChildNotifiesRoot,
        },
        {
          name: 'reply to a child without busId still notifies the root',
          fn: testCompletionScope_replyToChildWithoutBusIdNotifiesRoot,
        },
        {
          name: 'WhatsApp-created agent -> notified on WhatsApp',
          fn: testCompletionScope_whatsappCreatedAgentNotified,
        },
        {
          name: 'web agent the WhatsApp agent replied to -> notified on WhatsApp',
          fn: testCompletionScope_whatsappSupervisorReplyNotified,
        },
        {
          name: 'untouched web agent (kickoff only) -> no completion notice',
          fn: testCompletionScope_untouchedWebAgentNotNotified,
        },
        {
          name: 'relayed question/approval/cost limit/card setup -> delivered, not a touch',
          fn: testTouchScope_relaysAreNotTouches,
        },
        {
          name: 'legacy relay marker -> skipped until an SMS reply replaces it',
          fn: testTouchScope_replyOverridesLegacyRelayMarker,
        },
        {
          name: 'untouched web/Mac agent -> no kickoff, questions still sent',
          fn: testKickoffScope_untouchedAgentSilentQuestionsStillSent,
        },
        {
          name: 'SMS/WhatsApp-created agent -> kickoff sent on both channels',
          fn: testKickoffScope_messagingCreatedAgentKickoffSent,
        },
      ],
    });
  }

  const allGroups = [...parallelGroups, ...sequentialGroups];

  // Flatten parallel tests for concurrent execution
  const parallelTests: {
    groupName: string;
    name: string;
    fn: () => Promise<void>;
  }[] = [];
  for (const group of parallelGroups) {
    for (const test of group.tests) {
      parallelTests.push({
        groupName: group.name,
        name: test.name,
        fn: test.fn,
      });
    }
  }

  const allResults: (TestResult & { groupName: string })[] = [];
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= parallelTests.length) return;
      const t = parallelTests[idx];
      const result = await runTest(`${t.groupName} -- ${t.name}`, t.fn);
      allResults[idx] = { ...result, groupName: t.groupName };
    }
  }

  const workerCount = Math.min(CASE_CONCURRENCY, parallelTests.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (!captureAvailable) {
    console.log(
      '\n  [info] Capture not available ' +
        '(BLACKBOX_TEST_CAPTURE_OUTBOUND!=1) -- skipping boundary tests'
    );
  }

  for (const group of sequentialGroups) {
    for (const test of group.tests) {
      const result = await runTest(`${group.name} -- ${test.name}`, test.fn);
      allResults.push({ ...result, groupName: group.name });
    }
  }

  // Print results grouped
  for (const group of allGroups) {
    console.log(`\n  ${group.name}`);
    for (const test of group.tests) {
      const result = allResults.find(
        (r) => r.groupName === group.name && r.name.endsWith(test.name)
      )!;
      const icon = result.passed ? '  PASS' : '  FAIL';
      console.log(
        `${icon}  ${test.name}` +
          `${result.passed ? '' : ` -- ${result.error}`} ` +
          `(${result.duration}ms)`
      );
    }
  }

  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${passed} passed, ${failed} failed, ` +
      `${allResults.length} total (caseConcurrency=${workerCount})`
  );
  if (failed > 0) {
    console.log('\nFAILURES:');
    allResults.filter((r) => !r.passed).forEach((r) => console.log(`   ${r.name}: ${r.error}`));
    throw new Error(`${failed} send-sms black-box test(s) failed`);
  }
  console.log('\nALL BLACK-BOX TESTS PASSED\n');
}

async function runWithFixture(): Promise<void> {
  try {
    await createTestUser();
    await runAll();
  } finally {
    try {
      await cleanupTestUser();
    } finally {
      await prisma.$disconnect();
    }
  }
}

runWithFixture().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exitCode = 1;
});
