export const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
