import {
  testTenantIsolation_separateUsers,
  testTenantIsolation_patchOtherUserIntegration,
  testTenantIsolation_deleteOtherUserIntegration,
  testErrorSurface_401sHaveErrorField,
  testErrorSurface_400sHaveErrorField,
} from './integrations.crud-1.cases';
import { testErrorSurface_404sHaveErrorField } from './integrations.crud-2.cases';
import {
  testImessageUpload_emptyContacts,
  testImessageUpload_missingContacts,
  testImessageUpload_happyPath,
  testWhatsappUpload_emptyContacts,
  testWhatsappUpload_happyPath,
  testWhatsappConnect_happyPath,
  testWhatsappConnect_preservesExistingConfig,
  testTelegramConnect_happyPath,
  testTelegramUpload_emptyContacts,
  testTelegramUpload_happyPath,
} from './integrations.messaging-1.cases';
import {
  testCookiesUpload_missingFields,
  testCookiesUpload_invalidBrowser,
  testCookiesUpload_invalidEncryption,
  testCookiesUpload_happyPath,
  testMachineDataIngest_rejectsImpersonatedSession,
  testCookiesUpload_impersonatedSessionWritesNothing,
  testCookiesUpload_ownSessionStillAccepted,
  testLocalStorageUpload_missingFields,
  testLocalStorageUpload_happyPath,
  testIndexedDBUpload_happyPath,
  testFingerprintUpload_missingFields,
  testFingerprintUpload_invalidPayload,
  testFingerprintUpload_happyPath,
  testPermissionsUpload_happyPath,
  testCacheStorageUpload_happyPath,
  testPasswordsUpload_missingFields,
  testPasswordsUpload_happyPath,
  testPasswordsUpload_appleSourceMarksApplePasswordsIntegration,
} from './integrations.impersonation-1.cases';
import {
  testDocumentsUpload_happyPath,
  testDocumentsUpload_idempotentUpsert,
  testDocumentsUpload_dryRunDoesNotPersist,
} from './integrations.documents-service-1.cases';
import {
  testCookiesUpload_decodedNotArray,
  testCookiesUpload_largeBatchWithDuplicates,
  testCookiesUpload_emptyNameValueFiltered,
  testCookiesUpload_alternateBrowser,
  testCookiesUpload_safariBrowser,
  testLocalStorageUpload_invalidEncryption,
  testLocalStorageUpload_missingByOrigin,
  testLocalStorageUpload_nullByOrigin,
} from './integrations.browser-uploads-1.cases';

export function parallelTestsPart2() {
  return [
    // Tenant isolation
    { name: 'tenant isolation -- separate user lists', fn: testTenantIsolation_separateUsers },
    {
      name: 'tenant isolation -- cross-user patch -> 404',
      fn: testTenantIsolation_patchOtherUserIntegration,
    },
    {
      name: 'tenant isolation -- cross-user delete -> 404',
      fn: testTenantIsolation_deleteOtherUserIntegration,
    },
    // Error surface
    { name: 'error surface -- 401s have error field', fn: testErrorSurface_401sHaveErrorField },
    { name: 'error surface -- 400s have error field', fn: testErrorSurface_400sHaveErrorField },
    { name: 'error surface -- 404s have error field', fn: testErrorSurface_404sHaveErrorField },
    // Messaging uploads
    { name: 'POST /imessage/upload empty contacts -> 400', fn: testImessageUpload_emptyContacts },
    {
      name: 'POST /imessage/upload missing contacts -> 400',
      fn: testImessageUpload_missingContacts,
    },
    { name: 'POST /imessage/upload happy path', fn: testImessageUpload_happyPath },
    { name: 'POST /whatsapp/upload empty contacts -> 400', fn: testWhatsappUpload_emptyContacts },
    { name: 'POST /whatsapp/upload happy path', fn: testWhatsappUpload_happyPath },
    { name: 'POST /whatsapp/connect happy path', fn: testWhatsappConnect_happyPath },
    {
      name: 'POST /whatsapp/connect preserves existing config',
      fn: testWhatsappConnect_preservesExistingConfig,
    },
    { name: 'POST /telegram/connect happy path', fn: testTelegramConnect_happyPath },
    { name: 'POST /telegram/upload empty contacts -> 400', fn: testTelegramUpload_emptyContacts },
    { name: 'POST /telegram/upload happy path', fn: testTelegramUpload_happyPath },
    // Encrypted uploads
    { name: 'POST /cookies/upload missing fields -> 400', fn: testCookiesUpload_missingFields },
    { name: 'POST /cookies/upload invalid browser -> 400', fn: testCookiesUpload_invalidBrowser },
    { name: 'POST /cookies/upload bad encryption -> 400', fn: testCookiesUpload_invalidEncryption },
    { name: 'POST /cookies/upload happy path', fn: testCookiesUpload_happyPath },
    {
      name: 'machine-data ingest rejects an impersonated session (all routes)',
      fn: testMachineDataIngest_rejectsImpersonatedSession,
    },
    {
      name: 'POST /cookies/upload writes nothing for an impersonated session',
      fn: testCookiesUpload_impersonatedSessionWritesNothing,
    },
    {
      name: 'POST /cookies/upload still accepted for an ordinary session',
      fn: testCookiesUpload_ownSessionStillAccepted,
    },
    {
      name: 'POST /localStorage/upload missing fields -> 400',
      fn: testLocalStorageUpload_missingFields,
    },
    { name: 'POST /localStorage/upload happy path', fn: testLocalStorageUpload_happyPath },
    { name: 'POST /indexedDB/upload happy path', fn: testIndexedDBUpload_happyPath },
    {
      name: 'POST /fingerprint/upload missing fields -> 400',
      fn: testFingerprintUpload_missingFields,
    },
    {
      name: 'POST /fingerprint/upload invalid payload -> 400',
      fn: testFingerprintUpload_invalidPayload,
    },
    { name: 'POST /fingerprint/upload happy path', fn: testFingerprintUpload_happyPath },
    { name: 'POST /permissions/upload happy path', fn: testPermissionsUpload_happyPath },
    { name: 'POST /cacheStorage/upload happy path', fn: testCacheStorageUpload_happyPath },
    { name: 'POST /passwords/upload missing fields -> 400', fn: testPasswordsUpload_missingFields },
    { name: 'POST /passwords/upload happy path', fn: testPasswordsUpload_happyPath },
    {
      name: 'POST /passwords/upload apple source marks Apple Passwords connected',
      fn: testPasswordsUpload_appleSourceMarksApplePasswordsIntegration,
    },
    { name: 'POST /documents/upload happy path', fn: testDocumentsUpload_happyPath },
    { name: 'POST /documents/upload idempotent upsert', fn: testDocumentsUpload_idempotentUpsert },
    { name: 'POST /documents/upload dry run', fn: testDocumentsUpload_dryRunDoesNotPersist },
    // Encrypted upload error-path coverage (decryption-failure + shape-validation branches)
    {
      name: 'POST /cookies/upload decoded not array -> 400',
      fn: testCookiesUpload_decodedNotArray,
    },
    {
      name: 'POST /cookies/upload large batch + duplicates',
      fn: testCookiesUpload_largeBatchWithDuplicates,
    },
    {
      name: 'POST /cookies/upload empty name/value filtered',
      fn: testCookiesUpload_emptyNameValueFiltered,
    },
    {
      name: 'POST /cookies/upload alternate browser (edge)',
      fn: testCookiesUpload_alternateBrowser,
    },
    {
      name: 'POST /cookies/upload Safari browser',
      fn: testCookiesUpload_safariBrowser,
    },
    {
      name: 'POST /localStorage/upload bad encryption -> 400',
      fn: testLocalStorageUpload_invalidEncryption,
    },
    {
      name: 'POST /localStorage/upload missing byOrigin -> 400',
      fn: testLocalStorageUpload_missingByOrigin,
    },
    {
      name: 'POST /localStorage/upload null byOrigin -> 400',
      fn: testLocalStorageUpload_nullByOrigin,
    },
  ];
}
