/** Benchmark Hub object I/O, with Render R2 and isolated local storage. */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import {
  assertHubStorageOwnership,
  hubStorageVersions,
  ownedHubStorageRequest,
} from './benchmarkHubStorageOwnership';

const KEY_PREFIX = 'benchmark-hub';
const LOCAL_HUB_ROOT = path.join(__dirname, '..', '..', '..', '.context', 'benchmark-hub');
const isolatedRunId =
  process.env.BENCHMARK_ISOLATED_RUN === 'true' ? process.env.BENCHMARK_RUN_ID : undefined;
if (
  process.env.BENCHMARK_ISOLATED_RUN === 'true' &&
  (isolatedRunId === '.' ||
    isolatedRunId === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(isolatedRunId ?? ''))
) {
  throw new Error('BENCHMARK_RUN_ID must be a safe, nonempty ID for an isolated Benchmark Hub');
}
// Each isolated stack has its own database. Keep its local Hub index in the
// same isolation boundary so parallel stacks cannot overwrite one another's
// run registrations before the terminal bundles are mirrored to the durable Hub.
const LOCAL_DIR = isolatedRunId
  ? path.join(LOCAL_HUB_ROOT, 'isolated-runs', isolatedRunId)
  : LOCAL_HUB_ROOT;
let s3Client: S3Client | null = null;

/** Explicit isolated R2 is never inferred from credentials or a fake Render identity. */
function isolatedR2Prefix(): string | null {
  if (process.env.BENCHMARK_HUB_STORAGE !== 'r2-isolated') return null;
  const runId = process.env.BENCHMARK_RUN_ID ?? '';
  if (process.env.BENCHMARK_ISOLATED_RUN !== 'true' || !/^hubxp_[0-9a-f]{32}$/.test(runId)) {
    throw new Error('Isolated R2 requires an isolated run and a root-issued scope ID');
  }
  for (const name of [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_TRACE_ARCHIVE',
  ]) {
    if (!process.env[name]?.trim()) throw new Error('Isolated R2 credentials are incomplete');
  }
  const intent = process.env.BENCHMARK_HUB_ISOLATION_INTENT;
  if (!intent || !path.isAbsolute(intent)) throw new Error('Isolated R2 scope intent is required');
  const fd = openSync(intent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 4096
    ) {
      throw new Error('Isolated R2 scope intent ownership refused');
    }
    const scope = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
    if (
      scope.schema !== 'benchmark-hub-r2-isolation-v1' ||
      scope.mode !== 'r2-isolated' ||
      scope.run_id !== runId ||
      scope.bucket !== process.env.R2_BUCKET_TRACE_ARCHIVE
    ) {
      throw new Error('Isolated R2 scope intent binding refused');
    }
  } finally {
    closeSync(fd);
  }
  return `benchmark-hub-isolated/${runId}`;
}

// Fail startup closed for an explicitly requested isolated service.
isolatedR2Prefix();

function objectKey(key: string): string {
  const prefix = isolatedR2Prefix();
  if (
    prefix !== null &&
    !/^(?:index|agent-run-index|agent-run-index-revision)\.json$|^(?:runs|visibility)\/[A-Za-z0-9._-]+\.json$/.test(
      key
    )
  ) {
    throw new Error('Isolated R2 object key is outside the Hub scope');
  }
  return `${prefix ?? KEY_PREFIX}/${key}`;
}

function r2Configured(): boolean {
  if (isolatedR2Prefix() !== null) return true;
  // Local workspaces have production R2 credentials available for trace
  // diagnostics, but Benchmark Hub writes must stay worktree-local. Otherwise
  // independent test databases race through one production index and local
  // cleanup can hide real runs. Use Render's deployment identity rather than
  // NODE_ENV: local production-mode builds must remain isolated too.
  const useR2 = process.env.BENCHMARK_HUB_STORAGE !== 'local' && process.env.RENDER === 'true';
  return Boolean(
    useR2 &&
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_TRACE_ARCHIVE
  );
}

function getS3Client(): S3Client {
  if (s3Client !== null) return s3Client;
  const accountId = process.env.R2_ACCOUNT_ID || '';
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
  return s3Client;
}

async function streamToBuffer(body: unknown, signal?: AbortSignal): Promise<Buffer> {
  assertHubStorageOwnership();
  if (body instanceof Buffer) return body;
  const stream = body as AsyncIterable<Uint8Array> & {
    destroy?: (error: Error) => void;
  };
  const abort = () => stream.destroy?.(new Error('Benchmark Hub body ownership ended'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      signal.throwIfAborted();
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      assertHubStorageOwnership();
      chunks.push(chunk);
    }
    assertHubStorageOwnership();
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

const PUBLICATION_FORMAT = 'rose-benchmark-hub-publication-v1';
function encodePublication(data: string): string {
  return JSON.stringify({
    format: PUBLICATION_FORMAT,
    publication: randomUUID(),
    payload: data,
  });
}
function decodePublication(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const value = parsed as Record<string, unknown>;
  if (value.format !== PUBLICATION_FORMAT) return raw;
  if (
    typeof value.publication !== 'string' ||
    !value.publication ||
    typeof value.payload !== 'string' ||
    Object.keys(value).length !== 3
  ) {
    throw new Error('Invalid Benchmark Hub publication envelope');
  }
  return value.payload;
}

export async function putObject(key: string, data: string): Promise<void> {
  await ownedHubStorageRequest(async (signal) => {
    if (r2Configured()) {
      const versions = hubStorageVersions();
      // Preserve the first observation; failed CAS never refreshes or retries.
      if (versions && !versions.has(key)) versions.set(key, await readRemoteETag(key, signal));
      const expected = versions ? versions.get(key) : await readRemoteETag(key, signal);
      if (expected === undefined) throw new Error('Benchmark Hub write has no object observation');
      assertHubStorageOwnership();
      const response = await getS3Client().send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
          Key: objectKey(key),
          Body: encodePublication(data),
          ContentType: 'application/json',
          ...(expected === null ? { IfNoneMatch: '*' } : { IfMatch: expected }),
        }),
        { abortSignal: signal }
      );
      assertHubStorageOwnership();
      if (!response.ETag) throw new Error('Benchmark Hub write returned no ETag');
      versions?.set(key, response.ETag);
      return;
    }
    const target = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    assertHubStorageOwnership();
    const tmp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(tmp, data);
    assertHubStorageOwnership();
    await fs.rename(tmp, target);
  });
}

function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    record.code === 'ENOENT' ||
    record.name === 'NoSuchKey' ||
    record.name === 'NotFound' ||
    record.$metadata?.httpStatusCode === 404
  );
}

/** Observe write preconditions without downloading a previously unread bundle. */
async function readRemoteETag(key: string, signal?: AbortSignal): Promise<string | null> {
  try {
    assertHubStorageOwnership();
    const response = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
        Key: objectKey(key),
      }),
      { abortSignal: signal }
    );
    assertHubStorageOwnership();
    if (!response.ETag) throw new Error('Benchmark Hub read returned no ETag');
    return response.ETag;
  } catch (error: unknown) {
    assertHubStorageOwnership();
    if (isObjectNotFound(error)) return null;
    throw error;
  }
}

async function readRemoteObject(
  key: string,
  signal?: AbortSignal
): Promise<{ raw: string | null; etag: string | null }> {
  try {
    assertHubStorageOwnership();
    const response = await getS3Client().send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
        Key: objectKey(key),
      }),
      { abortSignal: signal }
    );
    const raw = (await streamToBuffer(response.Body, signal)).toString('utf-8');
    assertHubStorageOwnership();
    if (!response.ETag) throw new Error('Benchmark Hub read returned no ETag');
    return { raw, etag: response.ETag };
  } catch (error: unknown) {
    assertHubStorageOwnership();
    if (isObjectNotFound(error)) return { raw: null, etag: null };
    throw error;
  }
}

/** Null means confirmed missing; transport, ownership and codec faults throw. */
export async function getObjectStrict(key: string): Promise<string | null> {
  return ownedHubStorageRequest(async (signal) => {
    if (r2Configured()) {
      const result = await readRemoteObject(key, signal);
      const versions = hubStorageVersions();
      if (versions && !versions.has(key)) versions.set(key, result.etag);
      return result.raw === null ? null : decodePublication(result.raw);
    }
    try {
      return decodePublication(await fs.readFile(path.join(LOCAL_DIR, key), 'utf-8'));
    } catch (error: unknown) {
      assertHubStorageOwnership();
      if (isObjectNotFound(error)) return null;
      throw error;
    }
  });
}

export async function getObject(key: string): Promise<string | null> {
  // Isolated reads distinguish confirmed absence from storage/scope failures.
  if (process.env.BENCHMARK_HUB_STORAGE === 'r2-isolated') return getObjectStrict(key);
  try {
    return await getObjectStrict(key);
  } catch {
    assertHubStorageOwnership();
    return null;
  }
}

/** Test-only: clear the lazily configured object-store client. */
export function resetHubObjectStorageForTests(): void {
  s3Client = null;
}
