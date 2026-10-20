import {
  testLinkedinSync_noAuth,
  testLinkedinSync_missingAgentId,
  testLinkedinSync_rejectsAnotherUsersAgent,
  testLinkedinSync_runningAgentReadsSyncingThenSettles,
  testLinkedinSync_chatAgentThatNeverStartedSettles,
  testLinkedinSync_runningWorkflowStaysSyncingAndBlocksDuplicate,
} from './integrations.linkedin-sync-1.cases';
import {
  testEmailSend_missingFields,
  testEmailSend_noAuthCoverage,
  testEmailMessages_noAuthCoverage,
  testEmailMessages_empty,
  testPasswordsRequest_basic,
  testClaudeCodeCredentials_upload,
  testClaudeCodeCredentials_getToken,
  testClaudeCodeTokenRateLimited,
  testIntegrationCRUD_fullLifecycle,
  testEmailSend_withCredentials,
} from './integrations.oauth-crud-1.cases';
import {
  testEmailStart_gmailPkceFields,
  testEmailStart_yahooOAuthUrl,
  testOAuthCallback_yahooInvalidState,
  testOAuthCallback_missingBothParams,
  testPatch_isActiveToggle,
  testPatch_statusAndConfigTogether,
  testEmailSend_noFromEmailNoAccounts,
  testEmailMessages_limitClamping,
  testEmailMessages_limitNegative,
  testClaudeCodeRateLimited_poolSource,
  testClaudeCodeRateLimited_invalidSource,
  testClaudeCodeRateLimited_poolMissingId,
  testClaudeCodeRateLimited_userMissingUserId,
  testClaudeCodePoolRateLimited_happyPath,
  testClaudeCodePoolRateLimited_missingPoolTokenId,
} from './integrations.deep-validation-1.cases';
import {
  testClaudeCodeToken_viaApiKeyInternal,
  testClaudeCodeToken_excludePoolTokens,
  testContactsUpload_validVcf,
} from './integrations.claude-lifecycle-1.cases';
import {
  testContactsUpload_emptyVcf,
  testGenericUpload_toolSetupType,
  testList_withApiKey,
  testPasswordsRequest_longRequest,
} from './integrations.claude-lifecycle-2.cases';
import {
  testCreateIntegration_invalidType,
  testUpdateIntegration_invalidStatus,
  testRateLimited_invalidSource,
  testRateLimited_poolMissingId,
  testRateLimited_userMissingUserId,
  testGetIntegrations_noCachedDomains,
  testEmailMessages_noGmail,
  testEmailSend_noGmail,
  testPasswordRequest_happy,
  testClaudeCodeToken_noOnboarding,
} from './integrations.documents-service-1.cases';
import { testComputeTokenDuplicateProviderConstraint_returns400 } from './integrations.compute-rotation-1.cases';

export function parallelTestsPart5() {
  return [
    { name: 'POST /email/send missing all fields -> 400', fn: testEmailSend_missingFields },
    { name: 'POST /email/send no auth -> 401 (coverage)', fn: testEmailSend_noAuthCoverage },
    { name: 'GET /email/messages no auth -> 401 (coverage)', fn: testEmailMessages_noAuthCoverage },
    { name: 'GET /email/messages empty (no gmail) -> 404', fn: testEmailMessages_empty },
    { name: 'POST /passwords/request basic', fn: testPasswordsRequest_basic },
    {
      name: 'POST /claude-code/credentials/upload with payload',
      fn: testClaudeCodeCredentials_upload,
    },
    {
      name: 'GET /claude-code/credentials/token anon -> 404',
      fn: testClaudeCodeCredentials_getToken,
    },
    { name: 'POST /claude-code/token/rate-limited internal', fn: testClaudeCodeTokenRateLimited },
    { name: 'integration CRUD full lifecycle', fn: testIntegrationCRUD_fullLifecycle },
    { name: 'POST /email/send with from_email no gmail', fn: testEmailSend_withCredentials },
    // Deep coverage tests
    {
      name: 'POST /email/gmail/start PKCE fields verification',
      fn: testEmailStart_gmailPkceFields,
    },
    { name: 'POST /email/yahoo/start OAuth URL verification', fn: testEmailStart_yahooOAuthUrl },
    { name: 'GET /email/yahoo/callback invalid state', fn: testOAuthCallback_yahooInvalidState },
    {
      name: 'GET /email/gmail/callback missing both params',
      fn: testOAuthCallback_missingBothParams,
    },
    { name: 'PATCH /:name isActive toggle', fn: testPatch_isActiveToggle },
    {
      name: 'PATCH /:name status + config + isActive together',
      fn: testPatch_statusAndConfigTogether,
    },
    { name: 'POST /email/send no from_email no accounts', fn: testEmailSend_noFromEmailNoAccounts },
    { name: 'GET /email/messages limit clamping (999)', fn: testEmailMessages_limitClamping },
    { name: 'GET /email/messages limit negative (-5)', fn: testEmailMessages_limitNegative },
    {
      name: 'POST /claude-code/token/rate-limited pool source',
      fn: testClaudeCodeRateLimited_poolSource,
    },
    {
      name: 'POST /claude-code/token/rate-limited invalid source',
      fn: testClaudeCodeRateLimited_invalidSource,
    },
    {
      name: 'POST /claude-code/token/rate-limited pool missing id',
      fn: testClaudeCodeRateLimited_poolMissingId,
    },
    {
      name: 'POST /claude-code/token/rate-limited user missing userId',
      fn: testClaudeCodeRateLimited_userMissingUserId,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited happy path',
      fn: testClaudeCodePoolRateLimited_happyPath,
    },
    {
      name: 'POST /claude-code/pool-token/rate-limited missing id',
      fn: testClaudeCodePoolRateLimited_missingPoolTokenId,
    },
    {
      name: 'GET /claude-code/credentials/token via API key (forcePool)',
      fn: testClaudeCodeToken_viaApiKeyInternal,
    },
    {
      name: 'GET /claude-code/credentials/token exclude pool tokens',
      fn: testClaudeCodeToken_excludePoolTokens,
    },
    { name: 'POST /contacts/upload valid VCF', fn: testContactsUpload_validVcf },
    { name: 'POST /contacts/upload empty VCF', fn: testContactsUpload_emptyVcf },
    { name: 'POST /upload tool_setup integration type', fn: testGenericUpload_toolSetupType },
    { name: 'GET / via API key with X-User-Id', fn: testList_withApiKey },
    { name: 'POST /passwords/request long request text', fn: testPasswordsRequest_longRequest },
    // Deep coverage — service paths
    {
      name: 'POST / create with invalid type -> service error',
      fn: testCreateIntegration_invalidType,
    },
    {
      name: 'PATCH /:name update with invalid status -> service error',
      fn: testUpdateIntegration_invalidStatus,
    },
    {
      name: 'POST /claude-code/token/rate-limited invalid source',
      fn: testRateLimited_invalidSource,
    },
    {
      name: 'POST /claude-code/token/rate-limited pool missing poolTokenId',
      fn: testRateLimited_poolMissingId,
    },
    {
      name: 'POST /claude-code/token/rate-limited user missing userId',
      fn: testRateLimited_userMissingUserId,
    },
    { name: 'GET / no cached domains branch', fn: testGetIntegrations_noCachedDomains },
    { name: 'GET /email/messages no Gmail integration', fn: testEmailMessages_noGmail },
    { name: 'POST /email/send no Gmail credentials', fn: testEmailSend_noGmail },
    { name: 'POST /passwords/request happy path (anon session)', fn: testPasswordRequest_happy },
    {
      name: 'GET /claude-code/credentials/token no onboarding -> 404',
      fn: testClaudeCodeToken_noOnboarding,
    },
    {
      name: 'GET /compute-code/credentials/token duplicate tokenType -> 400',
      fn: testComputeTokenDuplicateProviderConstraint_returns400,
    },
    { name: 'POST /linkedin/sync no auth -> 401', fn: testLinkedinSync_noAuth },
    { name: 'POST /linkedin/sync missing agent_id -> 400', fn: testLinkedinSync_missingAgentId },
    {
      name: "POST /linkedin/sync another user's agent -> 404",
      fn: testLinkedinSync_rejectsAnotherUsersAgent,
    },
    {
      name: 'POST /linkedin/sync SYNCING survives re-read, settles when agent ends',
      fn: testLinkedinSync_runningAgentReadsSyncingThenSettles,
    },
    {
      name: 'GET / LinkedIn sync whose chat agent never started reads SYNC_FAILED',
      fn: testLinkedinSync_chatAgentThatNeverStartedSettles,
    },
    {
      name: 'POST /linkedin/sync running workflow stays SYNCING and blocks a duplicate -> 409',
      fn: testLinkedinSync_runningWorkflowStaysSyncingAndBlocksDuplicate,
    },
  ];
}
