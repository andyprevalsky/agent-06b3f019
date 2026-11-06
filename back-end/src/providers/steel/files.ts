/**
 * Steel file operations and fingerprint data retrieval.
 */

import { prisma } from '../database';
import { fingerprintInjectionEnabled } from './fingerprintSwitch';
import { buildFingerprintScript } from './injectionScripts';
import { steel } from './session';
import { type FingerprintData, type SteelFileInfo, log } from './types';

/**
 * Upload a file to an active Steel session.
 *
 * @param sessionId - The Steel session ID
 * @param fileBuffer - The file content as a Buffer
 * @param filename - The original filename
 * @param mimeType - The MIME type of the file
 * @returns The remote path where the file is available in the session
 */
export async function uploadFileToSession(
  sessionId: string,
  fileBuffer: Buffer,
  filename: string,
  mimeType: string = 'application/octet-stream'
): Promise<{ path: string; size: number }> {
  log.info(`📎 Uploading file '${filename}' to Steel session ${sessionId}...`);

  try {
    // Steel SDK expects a File or Blob object, NOT a Node.js Readable stream
    // Using File (available in Node.js 20+) which includes filename metadata
    const file = new File([fileBuffer], filename, { type: mimeType });

    const uploadedFile = await steel.sessions.files.upload(sessionId, {
      file: file,
      path: filename, // Preserve original filename instead of UUID
    });

    log.info(`  ✅ Uploaded ${filename} -> ${uploadedFile.path} (${uploadedFile.size} bytes)`);

    return {
      path: uploadedFile.path,
      size: uploadedFile.size || fileBuffer.length,
    };
  } catch (error) {
    log.error(`Failed to upload file '${filename}'`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * List all files in a Steel browser session.
 * This includes files downloaded by the browser and any uploaded files.
 *
 * @param sessionId - The Steel session ID
 * @returns Array of file info objects
 */
export async function listSessionFiles(sessionId: string): Promise<SteelFileInfo[]> {
  log.info(`📂 Listing files in Steel session ${sessionId}...`);

  try {
    const filesResponse = await steel.sessions.files.list(sessionId);

    // Steel SDK returns an object with data or files array, extract it
    const response = filesResponse as unknown as Record<string, unknown>;
    const files: SteelFileInfo[] =
      (response.data as SteelFileInfo[]) ||
      (response.files as SteelFileInfo[]) ||
      (filesResponse as unknown as SteelFileInfo[]) ||
      [];

    log.info(`Found ${files.length} file(s)`);
    for (const file of files) {
      log.info(`  - ${file.path} (${file.size} bytes)`);
    }

    return files.map((f) => ({
      path: f.path,
      size: f.size || 0,
      lastModified: f.lastModified,
    }));
  } catch (error) {
    log.error('Failed to list files', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Return empty array on error (session may have no files)
    return [];
  }
}

/**
 * Get fingerprint injection data for a user.
 * Returns the data needed for the agent to apply CDP commands.
 *
 * @param userId - The user's ID
 * @returns Fingerprint data and init script for CDP injection, or null if not available
 */
export async function getFingerprintInjectionData(userId: string): Promise<{
  userAgentOverride: {
    userAgent: string;
    acceptLanguage: string;
    platform: string;
    userAgentMetadata?: {
      brands: Array<{ brand: string; version: string }>;
      fullVersionList: Array<{ brand: string; version: string }>;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
      bitness: string;
    };
  };
  initScript: string;
  /** IANA timezone from the user's browser fingerprint (user location). */
  timezone: string | null;
} | null> {
  // Single producer for every consumer (worker CDP emulation + init script,
  // challenge recovery, resume): disabled means no payload anywhere.
  if (!fingerprintInjectionEnabled()) return null;
  const integration = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'browser_fingerprint', accountId: '' } },
  });

  const fp = (integration?.config as { fingerprint?: FingerprintData } | null)?.fingerprint;
  if (!fp) {
    return null;
  }

  // Build the User-Agent override params for Network.setUserAgentOverride
  const userAgentOverride: {
    userAgent: string;
    acceptLanguage: string;
    platform: string;
    userAgentMetadata?: {
      brands: Array<{ brand: string; version: string }>;
      fullVersionList: Array<{ brand: string; version: string }>;
      platform: string;
      platformVersion: string;
      architecture: string;
      model: string;
      mobile: boolean;
      bitness: string;
    };
  } = {
    userAgent: fp.navigator.userAgent,
    acceptLanguage: fp.navigator.languages.join(','),
    platform: fp.navigator.platform,
  };

  if (fp.userAgentData) {
    userAgentOverride.userAgentMetadata = {
      brands: fp.userAgentData.brands,
      fullVersionList: fp.userAgentData.fullVersionList,
      platform: fp.userAgentData.platform,
      platformVersion: fp.userAgentData.platformVersion,
      architecture: fp.userAgentData.architecture,
      model: fp.userAgentData.model,
      mobile: fp.userAgentData.mobile,
      bitness: fp.userAgentData.bitness,
    };
  }

  // Single source of truth with injectionScripts.buildFingerprintScript —
  // includes format()-correct timezone spoofing for the user's location.
  const initScript = buildFingerprintScript(fp);
  const timezone =
    typeof fp.timezone === 'string' && fp.timezone.trim() !== '' ? fp.timezone.trim() : null;

  return {
    userAgentOverride,
    initScript,
    timezone,
  };
}
