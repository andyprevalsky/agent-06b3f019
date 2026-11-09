import {
  testEmailSend_idempotentInternalPathRequiresConnectedGmail,
  testEmailSend_invalidIdempotencyKeyRejected,
  testEmailSend_accountNotFound,
  testEmailMessages_validSinceEmptyAccount,
  testApplePasswordsUpload_noFile,
  testGenericUpload_noFile,
  testLinkedinUpload_noFile,
  testContactsUpload_noFile,
  testEmailArchiveUpload_noFile,
} from './integrations.upload-validation-1.cases';
import {
  testEmailGmailAccountDelete_removesOneCredential,
  testGoogleRevocationFailure_retainsDurableRetry,
  testGoogleExternalRevocation_queuesPurgeAndReconnect,
} from './integrations.email-credentials-2.cases';
import {
  testEmailOAuthStart_preservesConnectedEmailsOnAbandonedFlow,
  testGetIntegrations_derivesConnectedEmailsFromCredentials,
  testEmailOAuthStart_concurrentStartsPreserveConfig,
  testGetIntegrations_primaryConnectedEmailIsStable,
} from './integrations.email-credentials-1.cases';
import {
  testListIntegrations_exposesPerAccountHealth,
  testEmailGmailAccountResync_notFound,
  testEmailGmailAccountResync_reportsNeedsReauth,
} from './integrations.email-credentials-3.cases';
import {
  testApplePasswordsUpload_validCsv,
  testApplePasswordsUpload_tabDelimited,
  testApplePasswordsUpload_noValidPasswords,
  testApplePasswordsUpload_headerOnly,
  testApplePasswordsUpload_missingColumns,
  testApplePasswordsUpload_quotedFields,
  testApplePasswordsUpload_duplicateOriginUsername,
  testGenericUpload_withFile,
  testGenericUpload_missingIntegrationType,
  testLinkedinUpload_nonZipFile,
  testLinkedinUpload_firstInstallmentWithoutConnections_422,
  testContactsUpload_nonVcfFile,
  testEmailArchiveUpload_nonZipFile,
  testPasswordsRequest_happyPath,
  testPatch_withStatusChange,
  testPatch_withInvalidStatus,
  testPatch_withConfigUpdate,
} from './integrations.file-uploads-1.cases';
import {
  testOAuthStart_gmail,
  testOAuthStart_yahoo,
  testOAuthStart_invalidProvider,
  testOAuthStart_noAuth,
  testOAuthCallback_noCode,
  testOAuthCallback_invalidState,
  testGetIntegrations_empty,
  testCreateIntegration_basic,
  testUpdateIntegration_status,
  testDeleteIntegration_basic,
} from './integrations.oauth-crud-1.cases';

export function parallelTestsPart4() {
  return [
    {
      name: 'POST /email/send idempotent internal path requires Gmail',
      fn: testEmailSend_idempotentInternalPathRequiresConnectedGmail,
    },
    {
      name: 'POST /email/send invalid idempotency_key rejected',
      fn: testEmailSend_invalidIdempotencyKeyRejected,
    },
    { name: 'POST /email/send account not found', fn: testEmailSend_accountNotFound },
    {
      name: 'GET /email/messages valid since empty account',
      fn: testEmailMessages_validSinceEmptyAccount,
    },
    {
      name: 'DELETE /email/gmail/accounts/:email removes one credential',
      fn: testEmailGmailAccountDelete_removesOneCredential,
    },
    {
      name: 'Google revocation retries after failure',
      fn: testGoogleRevocationFailure_retainsDurableRetry,
    },
    {
      name: 'Google external revocation queues data purge',
      fn: testGoogleExternalRevocation_queuesPurgeAndReconnect,
    },
    {
      name: 'POST /email/gmail/start abandoned flow preserves connectedEmails',
      fn: testEmailOAuthStart_preservesConnectedEmailsOnAbandonedFlow,
    },
    {
      name: 'GET / derives connectedEmails from credentials when config is stripped',
      fn: testGetIntegrations_derivesConnectedEmailsFromCredentials,
    },
    {
      name: 'POST /email/gmail/start concurrent starts preserve config',
      fn: testEmailOAuthStart_concurrentStartsPreserveConfig,
    },
    {
      name: 'GET / primary connectedEmail is stable across requests',
      fn: testGetIntegrations_primaryConnectedEmailIsStable,
    },
    // Per-account email health (needs-reconnection surface)
    {
      name: 'GET / exposes per-account email health without leaking tokens',
      fn: testListIntegrations_exposesPerAccountHealth,
    },
    {
      name: 'POST /email/gmail/accounts/:email/resync unknown account -> 404',
      fn: testEmailGmailAccountResync_notFound,
    },
    {
      name: 'POST /email/gmail/accounts/:email/resync reports needs-reauth and persists it',
      fn: testEmailGmailAccountResync_reportsNeedsReauth,
    },
    // File upload validation
    { name: 'POST /passwords/apple/upload no file -> 400', fn: testApplePasswordsUpload_noFile },
    { name: 'POST /upload no file -> 400', fn: testGenericUpload_noFile },
    { name: 'POST /linkedin/upload no file -> 400', fn: testLinkedinUpload_noFile },
    { name: 'POST /contacts/upload no file -> 400', fn: testContactsUpload_noFile },
    { name: 'POST /email/upload no file -> 400', fn: testEmailArchiveUpload_noFile },
    // Apple passwords CSV upload
    { name: 'POST /passwords/apple/upload valid CSV', fn: testApplePasswordsUpload_validCsv },
    {
      name: 'POST /passwords/apple/upload tab delimited',
      fn: testApplePasswordsUpload_tabDelimited,
    },
    {
      name: 'POST /passwords/apple/upload no valid passwords -> 400',
      fn: testApplePasswordsUpload_noValidPasswords,
    },
    {
      name: 'POST /passwords/apple/upload header only -> 400',
      fn: testApplePasswordsUpload_headerOnly,
    },
    {
      name: 'POST /passwords/apple/upload missing columns -> 400',
      fn: testApplePasswordsUpload_missingColumns,
    },
    {
      name: 'POST /passwords/apple/upload quoted fields',
      fn: testApplePasswordsUpload_quotedFields,
    },
    {
      name: 'POST /passwords/apple/upload dedup origin+username',
      fn: testApplePasswordsUpload_duplicateOriginUsername,
    },
    // Generic file upload
    { name: 'POST /upload with file happy path', fn: testGenericUpload_withFile },
    {
      name: 'POST /upload missing integrationType -> 400',
      fn: testGenericUpload_missingIntegrationType,
    },
    // File type validation
    { name: 'POST /linkedin/upload non-zip -> 400', fn: testLinkedinUpload_nonZipFile },
    {
      name: 'POST /linkedin/upload first installment without Connections.csv -> 422',
      fn: testLinkedinUpload_firstInstallmentWithoutConnections_422,
    },
    { name: 'POST /contacts/upload non-vcf -> 400', fn: testContactsUpload_nonVcfFile },
    { name: 'POST /email/upload non-zip -> 400', fn: testEmailArchiveUpload_nonZipFile },
    // Passwords request
    { name: 'POST /passwords/request happy path', fn: testPasswordsRequest_happyPath },
    // Integration CRUD edge cases
    { name: 'PATCH /:name with status change', fn: testPatch_withStatusChange },
    { name: 'PATCH /:name with invalid status', fn: testPatch_withInvalidStatus },
    { name: 'PATCH /:name with config update', fn: testPatch_withConfigUpdate },
    // Additional coverage tests (OAuth, CRUD, email, Claude Code)
    { name: 'POST /email/gmail/start with returnUrl', fn: testOAuthStart_gmail },
    { name: 'POST /email/yahoo/start', fn: testOAuthStart_yahoo },
    {
      name: 'POST /email/outlook/start invalid provider -> 400',
      fn: testOAuthStart_invalidProvider,
    },
    { name: 'POST /email/gmail/start no auth -> 401', fn: testOAuthStart_noAuth },
    { name: 'GET /email/gmail/callback no code -> 400', fn: testOAuthCallback_noCode },
    { name: 'GET /email/gmail/callback invalid state', fn: testOAuthCallback_invalidState },
    { name: 'GET / empty for new anon user', fn: testGetIntegrations_empty },
    { name: 'POST / create basic DATA_SOURCE', fn: testCreateIntegration_basic },
    { name: 'PATCH /:name update status to CONNECTED', fn: testUpdateIntegration_status },
    { name: 'DELETE /:name basic delete + verify', fn: testDeleteIntegration_basic },
  ];
}
