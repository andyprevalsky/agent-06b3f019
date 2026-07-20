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

import { assertProductionEnvironment } from './providers/productionEnvironment';

dotenv.config();
assertProductionEnvironment(process.env);

import('./server').catch((error: unknown) => {
  const failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
});
