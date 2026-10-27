/**
 * Backend boot sequence:
 *
 * .env -> production + Temporal namespace validation -> dynamic server import -> app.listen
 *                              \-> invalid -> process exits
 *
 * The dynamic import is deliberate: static imports can initialize providers
 * before top-level validation runs under TypeScript development runners.
 */
import { applyResolvedBenchmarkAgentCardIds } from './domains/test-payment/config';
import { loadDotenvWithCallerOverrides } from './providers/loadDotenvWithCallerOverrides';
import { assertProductionEnvironment } from './providers/productionEnvironment';
import { assertTemporalNamespaceIsolation } from './providers/temporalNamespaceIsolation';

// Cursor Cloud can inject truncated BENCHMARK_AGENTCARD_* values into process
// env. Prefer back-end/.env (override) and normalize org/cardholder as a pair,
// while preserving isolated-stack PORT / DATABASE_URL / TEMPORAL_TASK_QUEUE.
loadDotenvWithCallerOverrides();
applyResolvedBenchmarkAgentCardIds();
assertProductionEnvironment(process.env);
assertTemporalNamespaceIsolation(process.env);

import('./server').catch((error: unknown) => {
  const failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
});
