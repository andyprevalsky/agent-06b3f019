import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TOKEN = new RegExp(`^(${UUID})\\.([1-9][0-9]*)\\.([0-9a-f]{64})$`, 'i');
const MAX_AGE_SECONDS = 31 * 24 * 60 * 60;

/** A bearer capability for reading one archived benchmark run. */
export function verifyBenchmarkShareToken(
  token: string,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): string | null {
  if (secret === undefined || secret === '') return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, runIdRaw, expiryRaw, signature] = match;
  const runId = runIdRaw.toLowerCase();
  const expiry = Number(expiryRaw);
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= nowSeconds ||
    expiry > nowSeconds + MAX_AGE_SECONDS
  ) {
    return null;
  }
  const expected = createHmac('sha256', secret)
    .update(`benchmark-share:v1:${runId}:${expiry}`)
    .digest();
  const supplied = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, supplied) ? runId : null;
}
