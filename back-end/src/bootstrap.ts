/**
 * Backend boot sequence:
 *
 * .env -> production validation -> dynamic server import -> app.listen
 *                              \-> invalid -> process exits
 *
 * The dynamic import is deliberate: static imports can initialize providers
 * before top-level validation runs under TypeScript development runners.
 */
import dotenv from 'dotenv';

import { applyResolvedBenchmarkAgentCardIds } from './domains/test-payment/config';
import { assertProductionEnvironment } from './providers/productionEnvironment';

// Cursor Cloud can inject truncated BENCHMARK_AGENTCARD_* values into process
// env. Prefer back-end/.env (override) and normalize org/cardholder as a pair.
const callerDatabaseUrl = process.env.DATABASE_URL;
const callerDirectUrl = process.env.DIRECT_URL;
dotenv.config({ override: true });
if (callerDatabaseUrl) {
  process.env.DATABASE_URL = callerDatabaseUrl;
}
if (callerDirectUrl) {
  process.env.DIRECT_URL = callerDirectUrl;
}
applyResolvedBenchmarkAgentCardIds();
assertProductionEnvironment(process.env);

import('./server').catch((error: unknown) => {
  const failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
});
