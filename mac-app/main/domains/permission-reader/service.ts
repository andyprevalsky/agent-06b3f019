/**
 * Service layer for permission-reader.
 *
 * Orchestrates the full permission scan:
 *   1. Resolve Chrome's `Preferences` file path (repo).
 *   2. Read the JSON body (repo).
 *   3. Walk `profile.content_settings.exceptions`, pulling out every
 *      supported permission type (`config.PERMISSION_TYPES`).
 *   4. Map Chrome-internal permission keys to their Web-API names
 *      (`config.PERMISSION_NAME_MAP`).
 *   5. Keep only explicit allow (1) / block (2) settings — default (0) and
 *      ask (3) values are filtered out.
 *   6. Strip Chrome's `,*` secondary-pattern suffix from origin keys while
 *      preserving `[*.]subdomain` wildcard patterns verbatim for downstream
 *      matching.
 *   7. Compute a deterministic truncated-sha256 hash over the sorted grant
 *      list for sync-layer cache invalidation.
 *
 * All filesystem / Electron boundaries go through repo.ts; this file is
 * pure business logic plus `crypto`.
 */

import crypto from 'crypto';
import {
  LOG_COMPONENT,
  PERMISSION_NAME_MAP,
  PERMISSION_TYPES,
  PERMISSIONS_HASH_PREFIX_LENGTH,
  SETTING_ALLOW,
  SETTING_BLOCK,
} from './config';
import { readPreferencesFile, resolvePreferencesPath } from './repo';
import type { PermissionData, PermissionGrant } from './types';

// ---------------------------------------------------------------------------
// Pure parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse Chrome's origin pattern to a clean origin string.
 *
 * Chrome stores patterns like `"https://www.amazon.com,*"` (concrete origin
 * with the secondary-pattern `,*` suffix) or `"[*.]amazon.com,*"` (subdomain
 * wildcard). We strip the `,*` suffix and leave `[*.]` patterns intact so
 * downstream matching can still honour them.
 */
export function parseOriginPattern(pattern: string): string {
  return pattern.replace(/,\*$/, '');
}

/**
 * Compute a stable truncated-sha256 hash over the full grant list.
 *
 * Grants are sorted by (origin, permission) first so the hash is insertion-
 * order independent — this is load-bearing: the sync layer compares hashes
 * across scans to decide whether to re-inject, and a hash that flipped on
 * every scan would thrash that cache.
 */
export function computePermissionsHash(grants: PermissionGrant[]): string {
  const sorted = [...grants].sort((a, b) => {
    const originCmp = a.origin.localeCompare(b.origin);
    if (originCmp !== 0) return originCmp;
    return a.permission.localeCompare(b.permission);
  });
  const content = JSON.stringify(sorted);
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, PERMISSIONS_HASH_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Empty `PermissionData` returned by all non-happy paths. */
function emptyResult(): PermissionData {
  return {
    grants: [],
    hash: '',
    grantCount: 0,
  };
}

/**
 * Extract the `content_settings.exceptions` map from a parsed Preferences
 * object, or null if the expected shape is missing.
 */
function extractExceptions(prefs: unknown): Record<string, unknown> | null {
  if (prefs === null || typeof prefs !== 'object') {
    return null;
  }
  const profile = (prefs as { profile?: unknown }).profile;
  if (profile === null || typeof profile !== 'object') {
    return null;
  }
  const contentSettings = (profile as { content_settings?: unknown }).content_settings;
  if (contentSettings === null || typeof contentSettings !== 'object') {
    return null;
  }
  const exceptions = (contentSettings as { exceptions?: unknown }).exceptions;
  if (exceptions === null || typeof exceptions !== 'object') {
    return null;
  }
  return exceptions as Record<string, unknown>;
}

/**
 * Pull allow/block grants for a single permission type out of its per-origin
 * settings map. Malformed entries (non-objects, missing `setting`, values
 * other than 1/2) are silently skipped — this matches the pre-refactor
 * swallow-and-continue contract.
 */
function extractGrantsForType(
  permType: string,
  permSettings: Record<string, unknown>
): PermissionGrant[] {
  const webApiName = PERMISSION_NAME_MAP[permType] ?? permType;
  const grants: PermissionGrant[] = [];

  for (const [originPattern, value] of Object.entries(permSettings)) {
    if (value === null || typeof value !== 'object') continue;

    const setting = (value as { setting?: number }).setting;
    if (setting !== SETTING_ALLOW && setting !== SETTING_BLOCK) continue;

    grants.push({
      origin: parseOriginPattern(originPattern),
      permission: webApiName,
      setting,
    });
  }

  return grants;
}

/**
 * Read permission grants from Chrome's Preferences file.
 * Returns grants with allow (1) or block (2) settings.
 */
export async function readPermissions(): Promise<PermissionData> {
  const chromePrefsPath = resolvePreferencesPath();
  if (chromePrefsPath === null) {
    console.log(`[${LOG_COMPONENT}] Chrome Preferences file not found`);
    return emptyResult();
  }

  try {
    const prefsContent = readPreferencesFile(chromePrefsPath);
    const prefs: unknown = JSON.parse(prefsContent);

    const exceptions = extractExceptions(prefs);
    if (exceptions === null) {
      console.log(`[${LOG_COMPONENT}] No content_settings.exceptions found in Preferences`);
      return emptyResult();
    }

    const grants: PermissionGrant[] = [];
    for (const permType of PERMISSION_TYPES) {
      const permSettings = exceptions[permType];
      if (permSettings === null || typeof permSettings !== 'object') continue;

      grants.push(...extractGrantsForType(permType, permSettings as Record<string, unknown>));
    }

    console.log(
      `[${LOG_COMPONENT}] Read ${grants.length} permission grants from Chrome Preferences`
    );

    return {
      grants,
      hash: computePermissionsHash(grants),
      grantCount: grants.length,
    };
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Error reading Preferences:`, error);
    return emptyResult();
  }
}
