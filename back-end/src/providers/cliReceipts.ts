/** Durable caller-scoped CLI execution receipts (legacy template runs and shared native runs). */
import type { Prisma } from '@prisma/client';
import { CliIntegrationError } from './cliIntegrations';
import type { CliResult } from './cliTemplate';

export function readReceipt(metadata: Prisma.JsonValue, fingerprint: string): CliResult {
  const receipt =
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata.cliRun
      : null;
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.fingerprint !== fingerprint
  )
    throw new CliIntegrationError(409, 'request_id was already used for a different command');
  const result = receipt.result;
  if (
    receipt.status !== 'completed' ||
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof result.exit_code !== 'number' ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string'
  )
    throw new CliIntegrationError(
      409,
      'This request is running or its outcome is unknown; it will not be executed again'
    );
  return { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr };
}
