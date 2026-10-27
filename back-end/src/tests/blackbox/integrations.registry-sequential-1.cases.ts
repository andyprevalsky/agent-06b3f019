import { testLanternCredentials } from './integrations.context';
import {
  testMessagingUpload_survivesProcessExitAfterAck,
  testMessagingUpload_largeLegacyBodyIngestsInBoundedParts,
  testMessagingUpload_nonFinalChunkKeepsCursor,
  testMessagingUpload_exhaustedPartFailsSyncAndKeepsCursor,
  testMessagingUpload_chunkStoreFailureLeavesPartRetryable,
  testContactUpsert_roundTripsScaleWithChunks,
  testMessagingUpload_splitContactFrequencyUsesFullHistory,
  testMessagingUpload_idlessMessageRetryStoresOnce,
  testIntegrationDelete_removesQueuedUploadParts,
} from './integrations.messaging-ingestion.cases';
import { testGoogleRevocationFailures_doNotStarveLaterPurge } from './integrations.email-credentials-2.cases';
import { testStateTransition_fullLifecycle } from './integrations.lifecycle-boundaries-1.cases';
import {
  testAnthropicApiKeyCooldown_markThenOnCooldown,
  testGptApiKeyCooldown_markThenOnCooldown,
} from './integrations.auth-cooldowns-1.cases';
import { testClaudeCodeBillingFailure_backsOffFundedApiKey } from './integrations.claude-lifecycle-1.cases';

export function sequentialTestsPart1() {
  return [
    {
      name: 'Lantern refreshable credentials: encrypted tenant-bound upload and serialized rotation',
      fn: testLanternCredentials,
    },
    // This case drains the global purge queue, so keep it after parallel cases.
    {
      name: 'Google revocation failures do not starve later purges',
      fn: testGoogleRevocationFailures_doNotStarveLaterPurge,
    },
    { name: 'state transition -- full lifecycle', fn: testStateTransition_fullLifecycle },
    {
      name: 'anthropic api-key cooldown -- mark then on-cooldown',
      fn: testAnthropicApiKeyCooldown_markThenOnCooldown,
    },
    {
      name: 'gpt api-key cooldown -- mark then on-cooldown',
      fn: testGptApiKeyCooldown_markThenOnCooldown,
    },
    {
      name: 'claude-code billing-failure -- funded API key backed off globally',
      fn: testClaudeCodeBillingFailure_backsOffFundedApiKey,
    },
    {
      name: 'messaging upload -- acknowledged upload survives process exit after the 200',
      fn: testMessagingUpload_survivesProcessExitAfterAck,
    },
    {
      name: 'messaging upload -- large legacy body ingests once in bounded parts',
      fn: testMessagingUpload_largeLegacyBodyIngestsInBoundedParts,
    },
    {
      name: 'messaging upload -- non-final chunk keeps the incremental cursor',
      fn: testMessagingUpload_nonFinalChunkKeepsCursor,
    },
    {
      name: 'messaging upload -- exhausted part fails the sync and keeps the cursor',
      fn: testMessagingUpload_exhaustedPartFailsSyncAndKeepsCursor,
    },
    {
      name: 'messaging upload -- chunk store failure leaves the part retryable',
      fn: testMessagingUpload_chunkStoreFailureLeavesPartRetryable,
    },
    {
      name: 'contact upsert -- DB round trips scale with chunks, not contacts',
      fn: testContactUpsert_roundTripsScaleWithChunks,
    },
    {
      name: 'messaging upload -- split contact frequency uses its full stored history',
      fn: testMessagingUpload_splitContactFrequencyUsesFullHistory,
    },
    {
      name: 'messaging upload -- retried part stores ID-less messages once',
      fn: testMessagingUpload_idlessMessageRetryStoresOnce,
    },
    {
      name: 'integration delete -- removes queued messaging upload parts',
      fn: testIntegrationDelete_removesQueuedUploadParts,
    },
  ];
}
