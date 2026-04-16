// Environment config
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
export const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/** Whether we're running in local development (explicit opt-in, not just "not production") */
export const IS_DEV = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

/** Whether running inside the blackbox test harness (tests need real Twilio calls) */
export const IS_BLACKBOX_TEST = process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1';

/** Access token expiry: 90 days in seconds */
export const SESSION_EXPIRES_IN = 7776000;

/** Refresh token expiry: 180 days in seconds */
export const REFRESH_TOKEN_EXPIRES_IN = 15552000;
