/**
 * Cross-clone benchmark seed-dump cache (R2).
 *
 * A freshly-cloned cloud-bench guest has no local `victoria-seed.dump` on its
 * /data volume. This CLI lets an explicit publication workflow put a reviewed
 * canonical base in shared R2, and lets every clone (in ANY workspace) pull and
 * restore that same base instead of synthesizing it from a production cold-sync.
 *
 * Neighbor-safe by construction: this is purely additive. `--get` exits non-zero
 * on any miss/error; callers decide whether an optional seed may cold-sync or a
 * required canonical benchmark base must fail closed. It never mutates a shared
 * warm box or its Fly snapshots, so a concurrently-running fleet is unaffected.
 *
 * Key: `benchmark-seed-dumps/<token>.dump`, where the caller's token embeds the
 * schema hash and a reviewed base-fixture revision. The schema hash guarantees a
 * pulled dump matches the clone's `schema.prisma`; the fixture revision makes
 * row-content changes explicit and immutable. The caller re-verifies both via
 * local sidecars before restoring.
 *
 * Usage:
 *   npx tsx scripts/seed-dump-cache.ts get <token> <out-file>
 *   npx tsx scripts/seed-dump-cache.ts put <token> <in-file>
 *   npx tsx scripts/seed-dump-cache.ts head <token>
 *
 * Exit codes: 0 = success (get wrote the file / put uploaded / head found a
 * non-empty object); 1 = miss, unconfigured, or any error (caller cold-syncs).
 * `head` alone distinguishes a definite absence (exit 3) from an unreadable
 * cache (exit 1), so a preflight can refuse a missing canonical base without
 * downloading it and without treating a transport failure as a miss.
 * Never throws uncaught.
 */
import fs from 'fs';
import { resolve } from 'path';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
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

// The canonical base fixture is tens to hundreds of MB. One TLS stream that large under the
// 30s probe timeout and maxAttempts:1 either times out or dies mid-flight with
// an `sslv3 alert bad record mac`, which is how a republication silently fails
// and every consumer then refuses to boot. Bulk transfers get their own budget
// and their own retries; the probe path keeps the short timeout.
export function bulkTransferTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const configured = Number(env.SEED_DUMP_CACHE_BULK_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(Math.floor(configured), 1_000), 1_800_000);
  }
  // An explicitly pinned request deadline is a deliberate bound (run.sh's cache
  // probe, and the hanging-endpoint regression test). Never let the bulk budget
  // silently override it — a dead endpoint must still fail fast, not stall a
  // boot for five minutes.
  const pinnedProbe = Number(env.SEED_DUMP_CACHE_REQUEST_TIMEOUT_MS);
  if (Number.isFinite(pinnedProbe) && pinnedProbe > 0) return cacheRequestTimeoutMs(env);
  return 300_000;
}

// S3/R2 requires >=5MiB parts (except the last). 16MiB keeps the part count for
// a 150MB artifact in single digits while staying small enough that one flaky
// part is cheap to retry.
export const MULTIPART_CHUNK_BYTES = 16 * 1024 * 1024;

// Canonical custom-format dumps compress to roughly 30MB. Keep the cutoff at one
// legal chunk so even a highly-compressed base gets per-part retries instead of
// one fragile PutObject stream (`sslv3 alert bad record mac` in production R2).
export const MULTIPART_THRESHOLD_BYTES = MULTIPART_CHUNK_BYTES;

export function shouldUseMultipartUpload(size: number): boolean {
  return size >= MULTIPART_THRESHOLD_BYTES;
}

export function planUploadParts(
  size: number,
  chunkBytes: number = MULTIPART_CHUNK_BYTES
): Array<{ partNumber: number; start: number; end: number }> {
  const parts: Array<{ partNumber: number; start: number; end: number }> = [];
  for (let start = 0, partNumber = 1; start < size; start += chunkBytes, partNumber += 1) {
    parts.push({ partNumber, start, end: Math.min(start + chunkBytes, size) });
  }
  return parts;
}

function client(bulk = false): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  const requestTimeout = bulk ? bulkTransferTimeoutMs() : cacheRequestTimeoutMs();
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
    // One attempt on both paths: uploadMultipart() owns its own per-part retry,
    // and a client-level retry of a hung request just multiplies the deadline.
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
  // Bulk budget: the object is ~150MB, far past the probe timeout. A miss still
  // returns immediately (NoSuchKey), so the longer budget costs nothing there.
  const response = await client(true).send(
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

async function uploadMultipart(
  s3: S3Client,
  bucket: string,
  key: string,
  inFile: string,
  size: number
): Promise<void> {
  const created = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'application/octet-stream',
    })
  );
  const uploadId = created.UploadId;
  if (uploadId === undefined) throw new Error('R2 did not return an UploadId');

  const fd = fs.openSync(inFile, 'r');
  try {
    const completed: Array<{ ETag: string; PartNumber: number }> = [];
    const plan = planUploadParts(size);
    const totalParts = plan.length;
    for (const part of plan) {
      const buf = Buffer.alloc(part.end - part.start);
      fs.readSync(fd, buf, 0, buf.length, part.start);

      // Retry the individual part: a mid-stream TLS reset kills one 16MiB part
      // instead of the whole 150MB upload.
      let lastError: unknown;
      let etag: string | undefined;
      for (let attempt = 1; attempt <= 3 && etag === undefined; attempt += 1) {
        try {
          const uploaded = await s3.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: part.partNumber,
              Body: buf,
            })
          );
          etag = uploaded.ETag;
        } catch (error) {
          lastError = error;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1_000 * attempt));
        }
      }
      if (etag === undefined) {
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`part ${part.partNumber}/${totalParts} failed after 3 attempts: ${detail}`);
      }
      completed.push({ ETag: etag, PartNumber: part.partNumber });
      if (process.env.SEED_DUMP_CACHE_VERBOSE === '1') {
        process.stderr.write(`seed-dump-cache: part ${part.partNumber}/${totalParts} ok\n`);
      }
    }

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completed },
      })
    );
  } catch (error) {
    // Never leave a dangling multipart upload accruing storage on the bucket.
    await s3
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch(() => undefined);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

async function put(token: string, inFile: string): Promise<number> {
  if (!fs.existsSync(inFile)) return 1;
  const size = fs.statSync(inFile).size;
  if (size === 0) return 1;

  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  const key = objectKey(token);
  const s3 = client(true);

  if (shouldUseMultipartUpload(size)) {
    await uploadMultipart(s3, bucket, key, inFile, size);
    return 0;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.readFileSync(inFile),
      ContentType: 'application/octet-stream',
    })
  );
  return 0;
}

export const HEAD_ABSENT_EXIT = 3;

// Existence probe on the short request budget: a HEAD never transfers the
// ~150MB body. An empty object is as unusable as a missing one (get() refuses it).
export async function head(token: string): Promise<number> {
  try {
    const response = await client().send(
      new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
        Key: objectKey(token),
      })
    );
    return (response.ContentLength ?? 0) > 0 ? 0 : HEAD_ABSENT_EXIT;
  } catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (failure.$metadata?.httpStatusCode === 404 || failure.name === 'NotFound') {
      return HEAD_ABSENT_EXIT;
    }
    process.stderr.write(
      `seed-dump-cache: head failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }
}

async function main(): Promise<number> {
  const [mode, token, file] = process.argv.slice(2);
  if (!mode || !token || (mode !== 'head' && !file)) {
    process.stderr.write('usage: seed-dump-cache.ts <get|put> <token> <file> | head <token>\n');
    return 1;
  }
  loadEnv();
  if (!r2Configured()) {
    process.stderr.write('seed-dump-cache: R2 not configured — skipping\n');
    return 1;
  }
  if (mode === 'head') return head(token);
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
