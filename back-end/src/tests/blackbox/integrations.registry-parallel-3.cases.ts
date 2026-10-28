import {
  testLocalStorageUpload_notObjectByOrigin,
  testLocalStorageUpload_orphanSurrogates,
  testLocalStorageUpload_compressedTrue,
  testIndexedDBUpload_missingFields,
  testIndexedDBUpload_invalidEncryption,
  testIndexedDBUpload_missingOrigins,
  testIndexedDBUpload_originsNotArray,
  testIndexedDBUpload_erroredOriginsFiltered,
  testIndexedDBUpload_nulCharactersStripped,
  testFingerprintUpload_invalidEncryption,
} from './integrations.browser-uploads-1.cases';
import {
  testPermissionsUpload_missingFields,
  testPermissionsUpload_invalidEncryption,
  testPermissionsUpload_missingGrants,
  testPermissionsUpload_grantsNotArray,
  testPermissionsUpload_emptyGrants,
  testCacheStorageUpload_missingFields,
  testCacheStorageUpload_invalidEncryption,
  testCacheStorageUpload_missingOrigins,
  testCacheStorageUpload_originsNotArray,
  testPasswordsUpload_invalidEncryption,
  testPasswordsUpload_missingPasswords,
  testPasswordsUpload_passwordsNotArray,
  testPasswordsUpload_emptyPasswords,
} from './integrations.browser-uploads-2.cases';
import {
  testClaudeCodeUpload_missingFields,
  testClaudeCodeUpload_happyPath,
  testClaudeCodeUpload_rejectsUndecryptable,
  testClaudeCodeToken_notFound,
  testClaudeCodeRateLimited_forbidden,
  testClaudeCodePoolRateLimited_forbidden,
  testEmailStart_invalidProvider,
  testEmailMessages_missingSince,
  testEmailMessages_invalidSince,
  testEmailMessages_gmailNotConnected,
} from './integrations.email-credentials-1.cases';
import {
  testPasswordsRequest_missingRequest,
  testPasswordsRequest_emptyRequest,
} from './integrations.email-credentials-3.cases';
import {
  testOAuthCallback_invalidProvider,
  testOAuthCallback_missingCode,
  testOAuthCallback_missingState,
} from './integrations.lifecycle-boundaries-1.cases';
import {
  testOAuthCallback_stateNotFound,
  testEmailStart_gmailHappyPath,
  testEmailStart_yahooHappyPath,
  testEmailSend_missingTo,
  testEmailSend_missingSubject,
  testEmailSend_missingBody,
  testEmailSend_missingFromEmail,
  testEmailSend_idempotencyKeyRequiresAgentId,
} from './integrations.upload-validation-1.cases';

export function parallelTestsPart3() {
  return [
    {
      name: 'POST /localStorage/upload byOrigin not object -> 400',
      fn: testLocalStorageUpload_notObjectByOrigin,
    },
    {
      name: 'POST /localStorage/upload orphan UTF-16 surrogates',
      fn: testLocalStorageUpload_orphanSurrogates,
    },
    {
      name: 'POST /localStorage/upload compressed=true happy path',
      fn: testLocalStorageUpload_compressedTrue,
    },
    {
      name: 'POST /indexedDB/upload missing fields -> 400',
      fn: testIndexedDBUpload_missingFields,
    },
    {
      name: 'POST /indexedDB/upload bad encryption -> 400',
      fn: testIndexedDBUpload_invalidEncryption,
    },
    {
      name: 'POST /indexedDB/upload missing origins -> 400',
      fn: testIndexedDBUpload_missingOrigins,
    },
    {
      name: 'POST /indexedDB/upload origins not array -> 400',
      fn: testIndexedDBUpload_originsNotArray,
    },
    {
      name: 'POST /indexedDB/upload errored origins filtered',
      fn: testIndexedDBUpload_erroredOriginsFiltered,
    },
    {
      name: 'POST /indexedDB/upload NUL characters stripped, not 500',
      fn: testIndexedDBUpload_nulCharactersStripped,
    },
    {
      name: 'POST /fingerprint/upload bad encryption -> 400',
      fn: testFingerprintUpload_invalidEncryption,
    },
    {
      name: 'POST /permissions/upload missing fields -> 400',
      fn: testPermissionsUpload_missingFields,
    },
    {
      name: 'POST /permissions/upload bad encryption -> 400',
      fn: testPermissionsUpload_invalidEncryption,
    },
    {
      name: 'POST /permissions/upload missing grants -> 400',
      fn: testPermissionsUpload_missingGrants,
    },
    {
      name: 'POST /permissions/upload grants not array -> 400',
      fn: testPermissionsUpload_grantsNotArray,
    },
    { name: 'POST /permissions/upload empty grants', fn: testPermissionsUpload_emptyGrants },
    {
      name: 'POST /cacheStorage/upload missing fields -> 400',
      fn: testCacheStorageUpload_missingFields,
    },
    {
      name: 'POST /cacheStorage/upload bad encryption -> 400',
      fn: testCacheStorageUpload_invalidEncryption,
    },
    {
      name: 'POST /cacheStorage/upload missing origins -> 400',
      fn: testCacheStorageUpload_missingOrigins,
    },
    {
      name: 'POST /cacheStorage/upload origins not array -> 400',
      fn: testCacheStorageUpload_originsNotArray,
    },
    {
      name: 'POST /passwords/upload bad encryption -> 400',
      fn: testPasswordsUpload_invalidEncryption,
    },
    {
      name: 'POST /passwords/upload missing passwords -> 400',
      fn: testPasswordsUpload_missingPasswords,
    },
    {
      name: 'POST /passwords/upload passwords not array -> 400',
      fn: testPasswordsUpload_passwordsNotArray,
    },
    { name: 'POST /passwords/upload empty passwords', fn: testPasswordsUpload_emptyPasswords },
    // Claude Code
    {
      name: 'POST /claude-code/credentials/upload missing fields -> 400',
      fn: testClaudeCodeUpload_missingFields,
    },
    { name: 'POST /claude-code/credentials/upload happy path', fn: testClaudeCodeUpload_happyPath },
    {
      name: 'POST /claude-code/credentials/upload rejects undecryptable envelope -> 400',
      fn: testClaudeCodeUpload_rejectsUndecryptable,
    },
    {
      name: 'GET /claude-code/credentials/token not found -> 404',
      fn: testClaudeCodeToken_notFound,
    },
    {
      name: 'POST /claude-code/token/rate-limited forbidden -> 403',
      fn: testClaudeCodeRateLimited_forbidden,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited forbidden -> 403',
      fn: testClaudeCodePoolRateLimited_forbidden,
    },
    // Email endpoints
    { name: 'POST /email/start invalid provider -> 400', fn: testEmailStart_invalidProvider },
    { name: 'GET /email/messages missing since -> 400', fn: testEmailMessages_missingSince },
    { name: 'GET /email/messages invalid since -> 400', fn: testEmailMessages_invalidSince },
    {
      name: 'GET /email/messages gmail not connected -> 404',
      fn: testEmailMessages_gmailNotConnected,
    },
    { name: 'POST /passwords/request missing -> 400', fn: testPasswordsRequest_missingRequest },
    { name: 'POST /passwords/request empty -> 400', fn: testPasswordsRequest_emptyRequest },
    // OAuth callback (public)
    { name: 'GET /email/callback invalid provider -> 400', fn: testOAuthCallback_invalidProvider },
    { name: 'GET /email/callback missing code -> 400', fn: testOAuthCallback_missingCode },
    { name: 'GET /email/callback missing state -> 400', fn: testOAuthCallback_missingState },
    { name: 'GET /email/callback state not found', fn: testOAuthCallback_stateNotFound },
    // Email send validation
    { name: 'POST /email/start gmail happy path', fn: testEmailStart_gmailHappyPath },
    { name: 'POST /email/start yahoo happy path', fn: testEmailStart_yahooHappyPath },
    { name: 'POST /email/send missing to -> 400', fn: testEmailSend_missingTo },
    { name: 'POST /email/send missing subject -> 400', fn: testEmailSend_missingSubject },
    { name: 'POST /email/send missing body -> 400', fn: testEmailSend_missingBody },
    { name: 'POST /email/send missing from_email', fn: testEmailSend_missingFromEmail },
    {
      name: 'POST /email/send idempotency_key requires agent_id',
      fn: testEmailSend_idempotencyKeyRequiresAgentId,
    },
  ];
}
