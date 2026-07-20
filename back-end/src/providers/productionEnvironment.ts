/**
 * Production configuration promotion path:
 *
 * Render snapshot -> assertProductionEnvironment -> imports/routes -> app.listen
 *                                              \-> invalid -> process exits
 *
 * Render only promotes a new instance after it becomes healthy. Failing before
 * app.listen therefore keeps the last healthy release serving traffic when a
 * required environment variable is deleted or emptied.
 */

export const REQUIRED_PRODUCTION_ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'BACKEND_API_KEY',
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'TEMPORAL_ADDRESS',
  'TEMPORAL_API_KEY',
  'TEMPORAL_NAMESPACE',
  'TEMPORAL_TASK_QUEUE',
  'STRIPE_SECRET_KEY',
  'STRIPE_SUBSCRIPTION_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
  'ALLOWED_ORIGINS',
] as const;

type RequiredProductionEnvironmentKey = (typeof REQUIRED_PRODUCTION_ENVIRONMENT_KEYS)[number];

const VALUE_VALIDATORS: Partial<
  Record<RequiredProductionEnvironmentKey, (value: string) => boolean>
> = {
  NODE_ENV: (value) => value === 'production',
  STRIPE_SECRET_KEY: (value) => /^(?:sk|rk)_(?:test|live)_\S+$/.test(value),
  STRIPE_SUBSCRIPTION_PRICE_ID: (value) => /^price_[A-Za-z0-9]+$/.test(value),
  STRIPE_WEBHOOK_SECRET: (value) => /^whsec_\S+$/.test(value),
};

function isProductionEnvironment(environment: Readonly<NodeJS.ProcessEnv>): boolean {
  return environment.RENDER === 'true' || environment.NODE_ENV === 'production';
}

export function assertProductionEnvironment(environment: Readonly<NodeJS.ProcessEnv>): void {
  if (!isProductionEnvironment(environment)) return;

  const missingKeys = REQUIRED_PRODUCTION_ENVIRONMENT_KEYS.filter(
    (key) => environment[key]?.trim() === undefined || environment[key]?.trim() === ''
  );
  const invalidKeys = REQUIRED_PRODUCTION_ENVIRONMENT_KEYS.filter((key) => {
    const value = environment[key];
    const validator = VALUE_VALIDATORS[key];
    return (
      value !== undefined &&
      value.trim() !== '' &&
      (value !== value.trim() || (validator !== undefined && !validator(value)))
    );
  });

  const problems: string[] = [];
  if (missingKeys.length > 0) {
    problems.push(`Missing required production environment variables: ${missingKeys.join(', ')}`);
  }
  if (invalidKeys.length > 0) {
    problems.push(`Invalid production environment variables: ${invalidKeys.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new Error(`Production environment validation failed. ${problems.join('. ')}`);
  }
}
