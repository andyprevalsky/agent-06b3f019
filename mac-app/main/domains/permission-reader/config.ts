/**
 * Configuration constants for the permission-reader domain.
 *
 * All tunables live here — log component prefix, the Chrome-profile subpath
 * for the Preferences file, the supported content-setting keys we extract,
 * the internal→Web-API permission-name map, and the hash prefix length used
 * for cache invalidation.
 */

/** Log prefix used for all domain console output. */
export const LOG_COMPONENT = 'PermissionReader';

/** Chrome stores per-profile settings in `<profile>/Preferences`. */
export const CHROME_PREFERENCES_SEGMENT = 'Preferences' as const;

/**
 * Chrome `content_settings` keys we extract from `Preferences`. These are the
 * permission categories we mirror to the remote browser session; anything not
 * in this list (e.g. `cookies`) is ignored entirely.
 */
export const PERMISSION_TYPES = [
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

/**
 * Map Chrome's internal content-setting keys to the Web Permissions API names
 * we emit. Anything not in the map is passed through unchanged.
 */
export const PERMISSION_NAME_MAP: Record<string, string> = {
  media_stream_camera: 'camera',
  media_stream_mic: 'microphone',
  midi_sysex: 'midi',
  usb_guard: 'usb',
  serial_guard: 'serial',
  bluetooth_guard: 'bluetooth',
  hid_guard: 'hid',
  window_placement: 'window-management',
  local_fonts: 'local-fonts',
  idle_detection: 'idle-detection',
};

/**
 * Chrome encodes per-grant setting values as integers.
 *   0 = default, 1 = allow, 2 = block, 3 = ask.
 * We only surface explicit allow (1) / block (2) grants.
 */
export const SETTING_ALLOW = 1;
export const SETTING_BLOCK = 2;

/** Length of the sha256 prefix used as the cache-invalidation hash. */
export const PERMISSIONS_HASH_PREFIX_LENGTH = 16;
