/**
 * Integrations upload service — cacheStorage, passwords, and Apple passwords.
 * Split from uploadService.ts for max-lines compliance.
 *
 * Passwords (plan row I7): one BrowserPassword row per
 * (origin, username, browserSource, browserProfile). Each source is the
 * provider `<source>_passwords` and each of its profiles one account
 * (`default` = no profile), with upload progress done/total = the batch.
 */

import { type CacheStoragePayload, type PasswordPayload, type ApplePasswordEntry } from './types';
import { createLogger } from '../../providers/logger';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import * as repo from './repo';
import { passwordIntegrationName } from './service.credentialAccounts';
import {
  trackCredentialUpload,
  upsertCredentialAccountRow,
  type CredentialUploadAccount,
  type UploadedCredentialAccount,
} from './uploadService.credentialAccounts';

export { encryptPasswordForStorage };

const log = createLogger('Integrations');
const APPLE_PASSWORDS_SOURCE = 'apple_passwords';

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

interface PasswordRow {
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsed: number | null;
  dateCreated: number | null;
  browserSource: string;
  browserProfile: string;
}

const accountKey = (row: { browserSource: string; browserProfile: string }) =>
  `${passwordIntegrationName(row.browserSource)}\u0000${row.browserProfile}`;

/** Deduplicate by the stored key (origin, username, source, profile), keeping the most recently used. */
function deduplicatePasswordsByStoredKey(passwords: PasswordRow[]): PasswordRow[] {
  const byKey = new Map<string, PasswordRow>();
  for (const pwd of passwords) {
    const key = `${pwd.origin}\u0000${pwd.username}\u0000${pwd.browserSource}\u0000${pwd.browserProfile}`;
    const existing = byKey.get(key);
    if (existing === undefined || (pwd.dateLastUsed ?? 0) > (existing.dateLastUsed ?? 0)) {
      byKey.set(key, pwd);
    }
  }
  return Array.from(byKey.values());
}

interface PasswordUploadAccount extends CredentialUploadAccount {
  browserSource: string;
}

function passwordAccounts(passwords: PasswordRow[]): PasswordUploadAccount[] {
  const accounts = new Map<string, PasswordUploadAccount>();
  for (const pwd of passwords) {
    const key = accountKey(pwd);
    const account = accounts.get(key) ?? {
      provider: passwordIntegrationName(pwd.browserSource),
      accountId: pwd.browserProfile,
      browserSource: pwd.browserSource,
      count: 0,
    };
    account.count += 1;
    accounts.set(key, account);
  }
  return [...accounts.values()];
}

/** Store deduplicated rows with per-account progress and one Integration row per account. */
async function storePasswordUpload(
  userId: string,
  passwords: PasswordRow[],
  configFor: (account: PasswordUploadAccount) => Record<string, string | number>
): Promise<UploadedCredentialAccount[]> {
  const accounts = passwordAccounts(passwords);
  return trackCredentialUpload(userId, accounts, 'passwords', async () => {
    await bulkUpsertPasswordEntries(userId, passwords);
    for (const account of accounts) {
      await upsertCredentialAccountRow(userId, account, configFor(account));
      log.info('Upserted password account', {
        provider: account.provider,
        hasProfile: account.accountId !== '',
        count: account.count,
        userId,
      });
    }
  });
}

/**
 * Process browser passwords upload.
 */
export async function processPasswordsUpload(userId: string, passwordData: PasswordPayload) {
  log.info('Received passwords', { count: passwordData.passwords.length, userId });

  if (passwordData.passwords.length === 0) {
    return { passwordCount: 0, accounts: [] as UploadedCredentialAccount[] };
  }

  const deduplicatedPasswords = deduplicatePasswordsByStoredKey(
    passwordData.passwords.map((pwd) => ({
      origin: pwd.origin,
      username: pwd.username,
      encryptedPassword: pwd.encryptedPassword,
      dateLastUsed: pwd.dateLastUsed,
      dateCreated: pwd.dateCreated,
      browserSource: pwd.browserSource,
      browserProfile: normalizeBrowserProfile(pwd.browserProfile),
    }))
  );
  log.info('Deduplicated passwords', { count: deduplicatedPasswords.length });

  const uploadedAt = new Date().toISOString();
  const accounts = await storePasswordUpload(userId, deduplicatedPasswords, (account) => ({
    browserSource: account.browserSource,
    browserProfile: account.accountId,
    passwordCount: account.count,
    uploadedAt,
  }));
  log.info('Upserted passwords', { count: deduplicatedPasswords.length, userId });

  return { passwordCount: deduplicatedPasswords.length, accounts };
}

/** Bulk upsert password entries (already deduplicated by the stored key). */
async function bulkUpsertPasswordEntries(userId: string, passwords: PasswordRow[]) {
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
      pwd.browserProfile
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
  const encryptedPasswords: PasswordRow[] = passwords.map((p) => {
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
      browserSource: APPLE_PASSWORDS_SOURCE,
      browserProfile: '',
    };
  });

  // One source and no profile: the stored key reduces to (origin, username).
  const passwordMap = new Map<string, PasswordRow>();
  for (const pwd of encryptedPasswords) {
    const key = `${pwd.origin}|${pwd.username}`;
    if (!passwordMap.has(key)) {
      passwordMap.set(key, pwd);
    }
  }
  const deduplicatedPasswords = Array.from(passwordMap.values());
  log.info('Deduplicated Apple passwords', { count: deduplicatedPasswords.length });

  const lastImportAt = new Date().toISOString();
  const accounts = await storePasswordUpload(userId, deduplicatedPasswords, (account) => ({
    passwordCount: account.count,
    lastImportAt,
  }));
  log.info('Imported Apple passwords', { count: deduplicatedPasswords.length, userId });

  return { passwordCount: deduplicatedPasswords.length, accounts };
}
