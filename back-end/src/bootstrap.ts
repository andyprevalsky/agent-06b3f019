/**
 * Backend boot sequence:
 *
 * .env -> production + Temporal namespace validation -> event-loop stall watchdog
 *   -> dynamic server import -> app.listen
 *                              \-> invalid -> process exits
 *
 * The dynamic import is deliberate: static imports can initialize providers
 * before top-level validation runs under TypeScript development runners.
 */
import { applyResolvedBenchmarkAgentCardIds } from './domains/test-payment/config';
import { loadDotenvWithCallerOverrides } from './providers/loadDotenvWithCallerOverrides';
import { assertProductionEnvironment } from './providers/productionEnvironment';
import { assertTemporalNamespaceIsolation } from './providers/temporalNamespaceIsolation';
import { startEventLoopStallWatchdog } from './providers/eventLoopStallWatchdog';
import { redirectNonProductionServerArchiveToLocal } from './providers/traceArchiveR2Guard';

// Cursor Cloud can inject truncated BENCHMARK_AGENTCARD_* values into process
// env. Prefer back-end/.env (override) and normalize org/cardholder as a pair,
// while preserving isolated-stack PORT / DATABASE_URL / TEMPORAL_TASK_QUEUE.
loadDotenvWithCallerOverrides();
applyResolvedBenchmarkAgentCardIds();
assertProductionEnvironment(process.env);
assertTemporalNamespaceIsolation(process.env);
// Dev/test stacks inherit TRACE_ARCHIVE_BACKEND=r2 from back-end/.env; they must
// never write the production trace archive bucket.
redirectNonProductionServerArchiveToLocal((message) => process.stderr.write(`⚠️  ${message}\n`));
// A blocked event loop silences every main-thread log; the watchdog thread names
// the blocking code and tracks RSS (prod OOM kills, 2026-09-18 .. 10-27).
if (process.env.EVENT_LOOP_WATCHDOG_DISABLED !== '1') startEventLoopStallWatchdog();

import('./server').catch((error: unknown) => {
  const failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
});
