import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const CHROME_PREFERENCES_PATH = path.join(
  app.getPath('home'),
  'Library/Application Support/Google/Chrome/Default/Preferences'
);

// Chrome content_settings permission types we care about
const PERMISSION_TYPES = [
  'geolocation',
  'notifications',
  'media_stream_camera',
  'media_stream_mic',
  'clipboard',
  'payment_handler',
  'automatic_downloads',
  'midi_sysex',
  'usb_guard',
  'serial_guard',
  'bluetooth_guard',
  'hid_guard',
  'window_placement',
  'local_fonts',
  'idle_detection',
] as const;

// Map Chrome's internal names to Web API names
const PERMISSION_NAME_MAP: Record<string, string> = {
  'media_stream_camera': 'camera',
  'media_stream_mic': 'microphone',
  'midi_sysex': 'midi',
  'usb_guard': 'usb',
  'serial_guard': 'serial',
  'bluetooth_guard': 'bluetooth',
  'hid_guard': 'hid',
  'window_placement': 'window-management',
  'local_fonts': 'local-fonts',
  'idle_detection': 'idle-detection',
};

export interface PermissionGrant {
  origin: string;      // "https://www.amazon.com" or pattern like "[*.]amazon.com"
  permission: string;  // Web API name: "geolocation", "camera", etc.
  setting: number;     // 1=allow, 2=block
}

export interface PermissionData {
  grants: PermissionGrant[];
  hash: string;  // For cache invalidation
  grantCount: number;
}

/**
 * Parse Chrome's origin pattern to a clean origin string.
 * Chrome stores patterns like "https://www.amazon.com,*" or "[*.]amazon.com,*"
 */
function parseOriginPattern(pattern: string): string {
  // Remove the ",*" suffix Chrome uses for secondary patterns
  let origin = pattern.replace(/,\*$/, '');

  // Handle wildcard patterns like "[*.]" - keep as-is for pattern matching
  // These match subdomains: "[*.]amazon.com" matches *.amazon.com

  return origin;
}

/**
 * Compute a hash of permission grants for cache invalidation.
 */
function computePermissionsHash(grants: PermissionGrant[]): string {
  const sorted = [...grants].sort((a, b) => {
    const originCmp = a.origin.localeCompare(b.origin);
    if (originCmp !== 0) return originCmp;
    return a.permission.localeCompare(b.permission);
  });
  const content = JSON.stringify(sorted);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export class PermissionReader {
  /**
   * Read permission grants from Chrome's Preferences file.
   * Returns grants with allow (1) or block (2) settings.
   */
  static async readPermissions(): Promise<PermissionData> {
    // Check if Chrome Preferences file exists
    if (!fs.existsSync(CHROME_PREFERENCES_PATH)) {
      console.log('[PermissionReader] Chrome Preferences file not found');
      return {
        grants: [],
        hash: '',
        grantCount: 0,
      };
    }

    const grants: PermissionGrant[] = [];

    try {
      // Read and parse Preferences JSON
      const prefsContent = fs.readFileSync(CHROME_PREFERENCES_PATH, 'utf-8');
      const prefs = JSON.parse(prefsContent);

      // Navigate to content_settings.exceptions
      const contentSettings = prefs?.profile?.content_settings?.exceptions;
      if (!contentSettings) {
        console.log('[PermissionReader] No content_settings.exceptions found in Preferences');
        return {
          grants: [],
          hash: '',
          grantCount: 0,
        };
      }

      // Extract permissions for each type we care about
      for (const permType of PERMISSION_TYPES) {
        const permSettings = contentSettings[permType];
        if (!permSettings || typeof permSettings !== 'object') {
          continue;
        }

        // Map to Web API permission name
        const webApiName = PERMISSION_NAME_MAP[permType] || permType;

        // Each key is an origin pattern, value contains { setting: number }
        for (const [originPattern, value] of Object.entries(permSettings)) {
          if (!value || typeof value !== 'object') continue;

          const setting = (value as any).setting;
          // Only include explicit allow (1) or block (2), skip default (0) or ask
          if (setting !== 1 && setting !== 2) continue;

          const origin = parseOriginPattern(originPattern);

          grants.push({
            origin,
            permission: webApiName,
            setting,
          });
        }
      }

      console.log(`[PermissionReader] Read ${grants.length} permission grants from Chrome Preferences`);

      const hash = computePermissionsHash(grants);

      return {
        grants,
        hash,
        grantCount: grants.length,
      };
    } catch (error) {
      console.error('[PermissionReader] Error reading Preferences:', error);
      return {
        grants: [],
        hash: '',
        grantCount: 0,
      };
    }
  }
}
