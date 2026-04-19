/**
 * Log prefix used across cookie-reader layers. Centralized so repo/service/
 * runtime log lines stay aligned.
 */
export const COOKIE_READER_LOG_PREFIX = '[CookieReader]';

/**
 * macOS Keychain service name for Chrome's Safe Storage password.
 * `security find-generic-password -wa "Chrome"` returns the shared secret
 * used to derive the AES key that Chrome uses to encrypt cookie values.
 */
export const CHROME_SAFE_STORAGE_SERVICE = 'Chrome';

/**
 * PBKDF2 parameters Chrome uses on macOS to derive the AES-128 key from the
 * Keychain-stored Safe Storage password. These are fixed by Chromium's
 * implementation — do not change.
 */
export const PBKDF2_SALT = 'saltysalt';
export const PBKDF2_ITERATIONS = 1003;
export const PBKDF2_KEY_LENGTH = 16;
export const PBKDF2_DIGEST = 'sha1';

/**
 * Chrome on macOS uses AES-128-CBC with a fixed IV of 16 space characters.
 */
export const AES_BLOCK_SIZE = 16;

/**
 * Chrome on macOS prepends 32 bytes of random data before the actual cookie
 * value during encryption. After decryption, we need to skip these 32 bytes.
 * Format: [32 bytes random] + [actual value] + [PKCS7 padding]
 */
export const CHROME_PREFIX_LENGTH = 32;

/**
 * Three-byte ASCII marker that prefixes Chrome's AES-encrypted cookies on
 * macOS. Anything else is either plaintext or an unknown encoding.
 */
export const V10_PREFIX = 'v10';

/** Directory prefix used for the per-invocation DB-copy temp dir. */
export const TEMP_DIR_PREFIX = 'cookie-reader-';

/** Filename the locked Chrome cookies DB is copied to inside the temp dir. */
export const TEMP_DB_FILENAME = 'Cookies-copy.sqlite';
