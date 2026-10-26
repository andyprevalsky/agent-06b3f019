/**
 * Integrations upload service — cacheStorage, passwords, and Apple passwords.
 * Split from uploadService.ts for max-lines compliance.
 */

import {
  type CacheStoragePayload,
  type PasswordPayload,
  type ApplePasswordEntry,
  IntegrationType,
  IntegrationStatus,
} from './types';
import { createLogger } from '../../providers/logger';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import * as repo from './repo';
import { uploadRunProgress } from './service.uploadProgress';

export { encryptPasswordForStorage };

const log = createLogger('Integrations');

/** Passwords per `<source>_passwords` row: the upload's sync-progress totals. */
function countByIntegration(passwords: Array<{ browserSource: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pwd of passwords) {
    const name = passwordIntegrationName(pwd.browserSource);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function passwordIntegrationName(browserSource: string): string {
  if (browserSource === 'apple_passwords') {
    return 'apple_passwords';
  }
  return `${browserSource}_passwords`;
}

function normalizeBrowserProfile(profile: unknown): string {
  if (typeof profile === 'string') return profile;
  if (profile !== null && profile !== undefined && typeof profile === 'object') {
    const id = (profile as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  }
  return '';
}

/**
 * Process CacheStorage upload.
 */
export async function processCacheStorageUpload(
  userId: string,
  cacheStorageData: CacheStoragePayload
) {
  log.info('Received Cache Storage origins', { count: cacheStorageData.origins.length, userId });

  const origins = cacheStorageData.origins;
  if (origins.length > 0) {
    const values = origins
      .map(
        (_, i) =>
          `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::jsonb, $${i * 4 + 4}, NOW())`
      )
      .join(', ');

    const params: (string | object)[] = [];
    for (const origin of origins) {
      params.push(
        userId,
        origin.origin,
        JSON.stringify(origin.caches),
        cacheStorageData.hashes[origin.origin] ?? ''
      );
    }

    await repo.bulkUpsertCacheStorage(values, params);
  }

  log.info('Upserted Cache Storage origins', { count: origins.length, userId });

  return { originCount: origins.length };
}

/**
 * Process browser passwords upload.
 */
export async function processPasswordsUpload(userId: string, passwordData: PasswordPayload) {
  log.info('Received passwords', { count: passwordData.passwords.length, userId });

  if (passwordData.passwords.length === 0) {
    return { passwordCount: 0 };
  }

  const deduplicatedPasswords = deduplicatePasswordsByOriginUsername(passwordData.passwords);
  log.info('Deduplicated passwords', { count: deduplicatedPasswords.length });

  const totals = countByIntegration(deduplicatedPasswords);
  const progress = uploadRunProgress({
    userId,
    run: 'passwords-upload',
    unit: 'passwords',
    totals,
  });
  await progress.start();
  await progress.step(() => bulkUpsertPasswordEntries(userId, deduplicatedPasswords));
  log.info('Upserted passwords', { count: deduplicatedPasswords.length, userId });

  // Create integration records per browser source
  const browserSources = new Set(deduplicatedPasswords.map((p) => p.browserSource));
  for (const source of browserSources) {
    const sourceCount = deduplicatedPasswords.filter((p) => p.browserSource === source).length;
    const integrationName = passwordIntegrationName(source);
    await repo.upsertIntegration({
      userId,
      name: integrationName,
      type: IntegrationType.DATA_SOURCE,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      lastSyncAt: new Date(),
      lastSuccessfulSyncAt: new Date(),
      config: {
        browserSource: source,
        passwordCount: sourceCount,
        uploadedAt: new Date().toISOString(),
      },
    });
    log.info('Upserted password integration', { integrationName, userId });
  }
  await progress.finish();

  return { passwordCount: deduplicatedPasswords.length };
}

/** Deduplicate passwords by (origin, username), keeping most recently used. */
function deduplicatePasswordsByOriginUsername<
  T extends { origin: string; username: string; dateLastUsed: number },
>(passwords: T[]): T[] {
  const passwordMap = new Map<string, T>();
  for (const pwd of passwords) {
    const key = `${pwd.origin}|${pwd.username}`;
    const existing = passwordMap.get(key);
    if (existing === undefined || pwd.dateLastUsed > existing.dateLastUsed) {
      passwordMap.set(key, pwd);
    }
  }
  return Array.from(passwordMap.values());
}

/** Bulk upsert password entries. */
async function bulkUpsertPasswordEntries(
  userId: string,
  passwords: Array<{
    origin: string;
    username: string;
    encryptedPassword: string;
    dateLastUsed: number | null;
    dateCreated: number | null;
    browserSource: string;
    browserProfile?: { id?: string; path?: string } | string | null;
  }>
) {
  const values = passwords
    .map(
      (_, i) =>
        `(gen_random_uuid(), $${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}::bigint, $${i * 8 + 6}::bigint, $${i * 8 + 7}, $${i * 8 + 8}, NOW(), NULL, NULL)`
    )
    .join(', ');

  const params: (string | number | null)[] = [];
  for (const pwd of passwords) {
    params.push(
      userId,
      pwd.origin,
      pwd.username,
      pwd.encryptedPassword,
      pwd.dateLastUsed,
      pwd.dateCreated,
      pwd.browserSource,
      normalizeBrowserProfile(pwd.browserProfile)
    );
  }

  await repo.bulkUpsertPasswords(values, params);
}

/** Parse the CSV header and return column indices. */
function parseAppleCsvHeader(header: string[]) {
  const normalized = header.map((h) => h.trim().toLowerCase().replace(/"/g, ''));
  return {
    titleIdx: normalized.findIndex((h) => h === 'title'),
    urlIdx: normalized.findIndex((h) => h === 'url'),
    usernameIdx: normalized.findIndex((h) => h === 'username'),
    passwordIdx: normalized.findIndex((h) => h === 'password'),
    notesIdx: normalized.findIndex((h) => h === 'notes'),
    otpAuthIdx: normalized.findIndex((h) => h === 'otpauth'),
  };
}

/** Parse the CSV body into rows, respecting quotes. */
function parseCsvRows(csvContent: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < csvContent.length) {
    const char = csvContent[i];

    if (char === '"') {
      if (inQuotes && csvContent[i + 1] === '"') {
        currentField += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }

    if (!inQuotes) {
      if (char === delimiter) {
        currentRow.push(currentField);
        currentField = '';
        i++;
        continue;
      }
      if (char === '\r') {
        i++;
        continue;
      }
      if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
        continue;
      }
    }

    currentField += char;
    i++;
  }

  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parse Apple Passwords export file.
 */
export function parseApplePasswordsCsv(csvContent: string): ApplePasswordEntry[] {
  const firstNewline = csvContent.indexOf('\n');
  if (firstNewline === -1) {
    throw new Error('File must have at least a header row and one data row');
  }
  const firstLine = csvContent.substring(0, firstNewline).replace(/\r$/, '');
  const delimiter = firstLine.includes('\t') ? '\t' : ',';

  const rows = parseCsvRows(csvContent, delimiter);

  if (rows.length < 2) {
    throw new Error('File must have at least a header row and one data row');
  }

  const { titleIdx, urlIdx, usernameIdx, passwordIdx, notesIdx, otpAuthIdx } = parseAppleCsvHeader(
    rows[0]
  );

  if (urlIdx === -1 || usernameIdx === -1 || passwordIdx === -1) {
    throw new Error('File must contain URL, Username, and Password columns');
  }

  const passwords: ApplePasswordEntry[] = [];

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const values = rows[rowIdx];
    if (values.length === 1 && values[0].trim() === '') continue;

    const url = values[urlIdx]?.trim() ?? '';
    const username = values[usernameIdx]?.trim() ?? '';
    const password = values[passwordIdx]?.trim() ?? '';

    if (url === '' || username === '' || password === '') continue;

    passwords.push({
      title: titleIdx >= 0 ? (values[titleIdx]?.trim() ?? '') : '',
      url,
      username,
      password,
      notes: notesIdx >= 0 ? (values[notesIdx]?.trim() ?? '') : '',
      otpAuth: otpAuthIdx >= 0 ? (values[otpAuthIdx]?.trim() ?? '') : '',
    });
  }

  return passwords;
}

/**
 * Process Apple Passwords CSV upload.
 */
export async function processApplePasswordsUpload(userId: string, csvContent: string) {
  const passwords = parseApplePasswordsCsv(csvContent);

  if (passwords.length === 0) {
    throw new Error('No valid passwords found in CSV');
  }

  log.info('Parsed Apple passwords', { count: passwords.length, userId });

  const now = Date.now();
  const encryptedPasswords = passwords.map((p) => {
    let origin = p.url;
    try {
      const urlObj = new URL(p.url);
      origin = urlObj.origin;
    } catch {
      // Keep original URL if parsing fails
    }

    return {
      origin,
      username: p.username,
      encryptedPassword: encryptPasswordForStorage(p.password),
      dateLastUsed: now,
      dateCreated: now,
      browserSource: 'apple_passwords',
    };
  });

  // Deduplicate by (origin, username)
  const passwordMap = new Map<string, (typeof encryptedPasswords)[0]>();
  for (const pwd of encryptedPasswords) {
    const key = `${pwd.origin}|${pwd.username}`;
    if (!passwordMap.has(key)) {
      passwordMap.set(key, pwd);
    }
  }
  const deduplicatedPasswords = Array.from(passwordMap.values());
  log.info('Deduplicated Apple passwords', { count: deduplicatedPasswords.length });

  const totals = new Map([['apple_passwords', deduplicatedPasswords.length]]);
  const progress = uploadRunProgress({
    userId,
    run: 'passwords-upload',
    unit: 'passwords',
    totals,
  });
  await progress.start();
  if (deduplicatedPasswords.length > 0) {
    await progress.step(() => bulkUpsertPasswordEntries(userId, deduplicatedPasswords));
    log.info('Imported Apple passwords', { count: deduplicatedPasswords.length, userId });
  }

  await repo.upsertIntegration({
    userId,
    name: 'apple_passwords',
    type: IntegrationType.DATA_SOURCE,
    status: IntegrationStatus.CONNECTED,
    isActive: true,
    lastSyncAt: new Date(),
    lastSuccessfulSyncAt: new Date(),
    config: { passwordCount: deduplicatedPasswords.length, lastImportAt: new Date().toISOString() },
  });
  await progress.finish();

  return { passwordCount: deduplicatedPasswords.length };
}
