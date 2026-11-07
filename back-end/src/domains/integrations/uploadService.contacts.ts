/**
 * Integrations upload service — contacts/file-based uploads.
 * Split from uploadService.ts for max-lines compliance.
 */

// eslint-disable-next-line no-restricted-imports -- temp file read/cleanup for multer uploads
import fs from 'fs';
import { IntegrationType, IntegrationStatus } from './types';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { parseVcfContent, importVcfContacts } from '../../services/integrations/vcfParser';
import { parseEmailZip, importEmailsToDb } from '../../services/integrations/emailParser';
import {
  assertLinkedInArchiveHasConnections,
  importLinkedInData,
} from '../../services/integrations/linkedinParser';

export { LinkedInArchiveWithoutConnectionsError } from '../../services/integrations/linkedinParser';
import { reportProgressBestEffort } from './service.progress';
import { uploadRunProgress } from './service.uploadProgress';
import type { ProgressWriteInput } from './syncAccountsContract';

const log = createLogger('Integrations');

/** Best-effort progress of the user's legacy (`''`) LinkedIn row. */
function reportLinkedInProgress(userId: string, input: ProgressWriteInput): Promise<void> {
  return reportProgressBestEffort({ userId, provider: 'linkedin', accountId: '', input });
}

/**
 * Process generic file upload integration.
 */
export async function processGenericUpload(
  userId: string,
  file: { path: string; originalname: string; size: number },
  integrationType: string
) {
  log.info('File uploaded', {
    fileName: file.originalname,
    fileSize: file.size,
    integrationType,
    filePath: file.path,
  });

  const integration = await repo.upsertIntegrationForUpload({
    userId,
    name: integrationType,
    config: {
      fileName: file.originalname,
      filePath: file.path,
      uploadedAt: new Date().toISOString(),
    },
  });

  // Simulate async processing
  void setTimeout(() => {
    void (async () => {
      try {
        await repo.updateIntegrationStatus(integration.id, IntegrationStatus.CONNECTED, {
          isActive: true,
          lastSyncAt: new Date(),
          lastSuccessfulSyncAt: new Date(),
        });

        // Clean up file
        fs.unlinkSync(file.path);
      } catch (error: unknown) {
        log.error('Error processing integration', {
          error: error instanceof Error ? error.message : String(error),
        });
        await repo.updateIntegrationStatus(integration.id, IntegrationStatus.SYNC_FAILED, {
          lastSyncAt: new Date(),
          lastFailedSyncAt: new Date(),
          failureReason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    })();
  }, 1000);

  return integration;
}

/**
 * Process LinkedIn ZIP upload.
 */
export async function processLinkedInUpload(userId: string, filePath: string, fileName: string) {
  log.info('LinkedIn file uploaded', { fileName, userId });
  // Before any write: a first-installment archive must not mark LinkedIn connected.
  assertLinkedInArchiveHasConnections(filePath);

  const integration = await repo.upsertIntegrationForUpload({
    userId,
    name: 'linkedin',
    config: { fileName, uploadedAt: new Date().toISOString() },
  });

  const jobId = integration.id;
  // Sync progress: the archive bytes received (no total), then the parsed records.
  const runId = `linkedin-upload:${jobId}:${Date.now()}`;
  await reportLinkedInProgress(userId, {
    runId,
    state: 'syncing',
    phase: 'uploaded',
    unit: 'bytes',
    done: fs.statSync(filePath).size,
    total: null,
  });

  let parsedRecords: number | null = null;
  try {
    const result = await importLinkedInData(userId, filePath, jobId, (records) => {
      parsedRecords = records;
      return reportLinkedInProgress(userId, {
        runId,
        state: 'syncing',
        phase: 'importing',
        unit: 'records',
        done: 0,
        total: records,
      });
    });

    await repo.updateIntegrationStatus(integration.id, IntegrationStatus.CONNECTED, {
      isActive: true,
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
    });
    await reportLinkedInProgress(userId, {
      runId,
      state: 'synced',
      ...(parsedRecords !== null && { done: parsedRecords }),
    });

    fs.unlinkSync(filePath);

    return { jobId, contacts: result.contacts, messages: result.messages };
  } catch (parseError: unknown) {
    log.error('LinkedIn parse/import error', {
      error: parseError instanceof Error ? parseError.message : String(parseError),
    });

    await repo.updateIntegrationStatus(integration.id, IntegrationStatus.SYNC_FAILED, {
      lastSyncAt: new Date(),
      lastFailedSyncAt: new Date(),
      failureReason: parseError instanceof Error ? parseError.message : 'Unknown error',
    });
    await reportLinkedInProgress(userId, {
      runId,
      state: 'failed',
      error: parseError instanceof Error ? parseError.message : 'Unknown error',
    });

    try {
      fs.unlinkSync(filePath);
    } catch {
      // expected — file may already be removed
    }

    throw parseError;
  }
}

/**
 * Process VCF contacts upload.
 */
export async function processContactsUpload(userId: string, filePath: string, fileName: string) {
  const vcfContent = fs.readFileSync(filePath, 'utf-8');
  const contacts = parseVcfContent(vcfContent);

  log.info('Parsed contacts from VCF', { count: contacts.length });

  // Sync progress: the parsed contacts, imported in one pass (best-effort).
  const progress = uploadRunProgress({
    userId,
    run: 'contacts-upload',
    unit: 'contacts',
    totals: new Map([['contacts', contacts.length]]),
  });
  await progress.start();
  const result = await progress.step(() => importVcfContacts(userId, contacts));

  fs.unlinkSync(filePath);

  await repo.upsertIntegration({
    userId,
    name: 'contacts',
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: {
      lastUploadedAt: new Date().toISOString(),
      lastFileName: fileName,
      contactsImported: result.created + result.updated,
    },
  });
  await progress.finish();

  return { parsed: contacts.length, ...result };
}

/**
 * Process email ZIP upload.
 */
export async function processEmailZipUpload(
  userId: string,
  userEmail: string,
  filePath: string,
  jobId: string
) {
  log.info('Parsing email ZIP', { jobId });
  const emails = parseEmailZip(filePath);
  log.info('Parsed emails from ZIP', { jobId, count: emails.length });

  const userEmails = [userEmail];
  const result = await importEmailsToDb(userId, userEmails, emails, jobId);

  fs.unlinkSync(filePath);

  return { emailsParsed: emails.length, contacts: result.contacts, messages: result.messages };
}
