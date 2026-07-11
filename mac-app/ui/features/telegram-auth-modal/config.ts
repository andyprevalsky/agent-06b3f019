/**
 * Config for the telegram-auth-modal feature: constants used to format the
 * phone-number input and surface user-facing validation / error messages.
 *
 * Kept as string literals rather than i18n keys — the mac-app has no i18n
 * pipeline and blackbox tests assert on exact copy.
 */

export const PHONE_EMPTY_MESSAGE = 'Please enter your phone number';
export const CODE_EMPTY_MESSAGE = 'Please enter the verification code';
export const PASSWORD_EMPTY_MESSAGE = 'Please enter your 2FA password';
export const TELEGRAM_API_UNAVAILABLE_MESSAGE = 'Telegram API not available';
export const START_AUTH_GENERIC_FAILURE = 'Failed to start authentication';
export const SEND_CODE_GENERIC_FAILURE = 'Failed to send code';
export const VERIFY_CODE_GENERIC_FAILURE = 'Failed to verify code';
export const AUTHENTICATE_GENERIC_FAILURE = 'Failed to authenticate';

export const CODE_INPUT_PLACEHOLDER = '12345';
export const PASSWORD_INPUT_PLACEHOLDER = 'Enter your 2FA password';

export const CODE_INPUT_MAX_LENGTH = 6;

export const SUBMIT_LABEL_PHONE = 'Send Code';
export const SUBMIT_LABEL_CODE = 'Verify';
export const SUBMIT_LABEL_PASSWORD = 'Sign In';
