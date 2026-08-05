/**
 * Cross-clone benchmark seed-dump cache (R2).
 *
 * A freshly-cloned cloud-bench guest has no local `victoria-seed.dump` on its
 * /data volume, so `run.sh` otherwise pays a full ~19-min production DB
 * cold-sync on first boot. This CLI lets a clone publish its dump to a shared
 * R2 bucket after the first cold-sync, and lets every subsequent clone (in ANY
 * workspace) pull a schema-matched dump and `pg_restore` it in seconds instead.
 *
 * Neighbor-safe by construction: this is purely additive. `--get` exits non-zero
 * on any miss/error so `run.sh` transparently falls back to the existing
 * cold-sync path; a corrupt download is caught by the existing `pg_restore`
 * failure fallback. It never mutates a shared warm box or its Fly snapshots, so
 * a concurrently-running fleet is unaffected.
 *
 * Key: `benchmark-seed-dumps/<token>.dump`, where the caller's token embeds the
 * schema hash (correctness) and a UTC day bucket (bounds staleness to 24h). The
 * schema hash guarantees a pulled dump matches the clone's `schema.prisma`; the
 * caller re-verifies via the `.schemahash` sidecar before restoring.
 *
 * Usage:
 *   npx tsx scripts/seed-dump-cache.ts get <token> <out-file>
 *   npx tsx scripts/seed-dump-cache.ts put <token> <in-file>
 *
 * Exit codes: 0 = success (get wrote the file / put uploaded); 1 = miss,
 * unconfigured, or any error (caller cold-syncs). Never throws uncaught.
 */
import fs from 'fs';
import { resolve } from 'path';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

const KEY_PREFIX = 'benchmark-seed-dumps';

// run.sh does NOT export back-end/.env into its shell, so R2_* live only in the
// .env file on a cloud box. Load them here (filling only absent keys, so an
// explicit override still wins) — mirrors seed-local.ts. Best-effort: no .env
// (e.g. a local unit test) just falls back to the ambient environment.
function loadEnv(): void {
  try {
    const parsed = dotenv.parse(fs.readFileSync(resolve(__dirname, '..', '.env')));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no .env — use ambient env */
  }
}

function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_TRACE_ARCHIVE
  );
}

export function cacheRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const configured = Number(env.SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return 30_000;
  return Math.min(Math.max(Math.floor(configured), 100), 60_000);
}

function client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  const requestTimeout = cacheRequestTimeoutMs();
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: Math.min(requestTimeout, 5_000),
      requestTimeout,
      socketTimeout: requestTimeout,
      throwOnRequestTimeout: true,
    },
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
}

export function objectKey(token: string): string {
  // Reject anything that could escape the prefix or produce an ambiguous key.
  const safe = token.replace(/[^A-Za-z0-9._-]/g, '');
  return `${KEY_PREFIX}/${safe}.dump`;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Buffer) return body;
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function get(token: string, outFile: string): Promise<number> {
  const response = await client().send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
      Key: objectKey(token),
    })
  );
  const buf = await streamToBuffer(response.Body);
  if (buf.length === 0) return 1;
  const tmp = `${outFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, outFile);
  return 0;
}

async function put(token: string, inFile: string): Promise<number> {
  if (!fs.existsSync(inFile) || fs.statSync(inFile).size === 0) return 1;
  const body = fs.readFileSync(inFile);
  await client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
      Key: objectKey(token),
      Body: body,
      ContentType: 'application/octet-stream',
    })
  );
  return 0;
}

async function main(): Promise<number> {
  const [mode, token, file] = process.argv.slice(2);
  if (!mode || !token || !file) {
    process.stderr.write('usage: seed-dump-cache.ts <get|put> <token> <file>\n');
    return 1;
  }
  loadEnv();
  if (!r2Configured()) {
    process.stderr.write('seed-dump-cache: R2 not configured — skipping\n');
    return 1;
  }
  if (mode === 'get') return get(token, file);
  if (mode === 'put') return put(token, file);
  process.stderr.write(`seed-dump-cache: unknown mode '${mode}'\n`);
  return 1;
}

// Run only as a CLI; importable for unit tests without side effects.
if (process.argv[1] && /seed-dump-cache\.ts$/.test(process.argv[1])) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `seed-dump-cache: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
