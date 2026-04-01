// Environment config
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
export const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/** Access token expiry: 90 days in seconds */
export const SESSION_EXPIRES_IN = 7776000;

/** Refresh token expiry: 180 days in seconds */
export const REFRESH_TOKEN_EXPIRES_IN = 15552000;
