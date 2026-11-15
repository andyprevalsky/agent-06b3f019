/**
 * Pure core of the versioned R2 lossless audit (V13). The CLI
 * (scripts/audit-r2-lossless.ts) supplies a read-only DB inventory, an
 * archive source (R2 or the local trace-archive directory) and an optional
 * code-checkpoint source; this module lists, decrypts and classifies records
 * and evaluates the named checks. Nothing here writes to any store.
 *
 *   DB inventory ──► roots / trees / ToolUsage ledger / CodeSession rows
 *        │
 *        ▼
 *   ArchiveSource.list/get ──► llm/ start + llm-updates/ final records
 *        │                       (decrypted via providers/traceArchive)
 *        ▼
 *   classify records ──► C1..C6 + C0 integrity ──► AuditReport (human / JSON)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  decryptAndValidateArtifact,
  type EncryptedArtifactMetadata,
} from '../src/providers/traceArchive';
import { metadataFromUnknown } from '../src/providers/traceArchiveEnvelope';
import { validateAgainstSchema, type JsonSchema } from './audit-r2-lossless-schema';

export const AUDIT_VERSION = 'r2-lossless-audit/1';
export const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UPDATE_NAME_RE = /^(.+?)-(\d{13})-(.*)\.json\.gz\.enc$/;
export const FINALIZED_FILES = ['manifest.json.gz.enc', 'manifest.public.json'];
export const END_FIXTURE_PATH = 'db/end.fixture.json.gz.enc';
/** Call-site aliases: these record call sites are ledgered under another ToolUsage toolName. */
export const FAMILY_ALIASES: Record<string, string> = {
  chat_router_after_search: 'chat_router',
  browser_use: 'browser_use_step_N',
};

// ── Sources ────────────────────────────────────────────────────────────────

export interface ListedObject {
  key: string;
  size: number;
  lastModifiedMs: number;
}
export interface ListResult {
  objects: ListedObject[];
  prefixes: string[];
  /** Set when `maxPages` stopped the listing before its end. */
  truncated?: boolean;
}
export interface ArchiveSource {
  kind: string;
  list(prefix: string, delimiter?: string, maxPages?: number): Promise<ListResult>;
  /** Whole object, or its first `rangeBytes` bytes; null when it does not exist. */
  get(key: string, rangeBytes?: number): Promise<Buffer | null>;
}
export interface CheckpointSource {
  listSeqs(userId: string, sessionId: string): Promise<number[]>;
  readManifest(userId: string, sessionId: string, seq: number): Promise<CheckpointManifest | null>;
}
export interface CheckpointManifest {
  artifacts?: Record<string, { sha256?: string; size?: number }>;
}

/** Read-only view of TRACE_ARCHIVE_BACKEND=local storage (keys relative to `rootDir`). */
export function localArchiveSource(rootDir: string): ArchiveSource {
  const toKey = (full: string) => path.relative(rootDir, full).split(path.sep).join('/');
  const stat = (full: string): ListedObject => {
    const info = fs.statSync(full);
    return { key: toKey(full), size: info.size, lastModifiedMs: info.mtimeMs };
  };
  return {
    kind: 'local',
    async list(prefix, delimiter) {
      const slash = prefix.lastIndexOf('/');
      const dir = path.join(rootDir, prefix.slice(0, slash + 1));
      const namePrefix = prefix.slice(slash + 1);
      const result: ListResult = { objects: [], prefixes: [] };
      if (!fs.existsSync(dir)) return result;
      const walk = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else result.objects.push(stat(full));
        }
      };
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.name.startsWith(namePrefix)) continue;
        const full = path.join(dir, entry.name);
        if (!entry.isDirectory()) result.objects.push(stat(full));
        else if (delimiter === '/') result.prefixes.push(`${toKey(full)}/`);
        else walk(full);
      }
      result.objects.sort((a, b) => a.key.localeCompare(b.key));
      result.prefixes.sort();
      return result;
    },
    async get(key, rangeBytes) {
      const full = path.join(rootDir, key);
      if (!fs.existsSync(full)) return null;
      const body = fs.readFileSync(full);
      return rangeBytes === undefined ? body : body.subarray(0, rangeBytes);
    },
  };
}

/** Every key character the archive writer allows (safeArchivePath), used to shard big listings. */
export const KEY_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_.-';

/**
 * List every object under `prefix`. Small prefixes cost one request; a prefix
 * with more than one page is split into its subdirectories and, where a level
 * is still too large, into next-character shards listed in parallel (the
 * `unbound` bundle holds hundreds of thousands of objects).
 */
export async function listAll(
  source: ArchiveSource,
  prefix: string,
  concurrency: number
): Promise<ListedObject[]> {
  const page = await source.list(prefix, undefined, 1);
  return page.truncated === true ? listSharded(source, prefix, concurrency) : page.objects;
}

async function listSharded(
  source: ArchiveSource,
  prefix: string,
  concurrency: number
): Promise<ListedObject[]> {
  const page = await source.list(prefix, '/', 1);
  if (page.truncated !== true) {
    const nested = await mapLimit(page.prefixes, concurrency, (sub) =>
      listSharded(source, sub, concurrency)
    );
    return [...page.objects, ...nested.flat()];
  }
  const shards = await mapLimit([...KEY_ALPHABET], concurrency, (c) =>
    listSharded(source, prefix + c, concurrency)
  );
  // An object named exactly `prefix` has no next character to shard on.
  return [...page.objects.filter((o) => o.key === prefix), ...shards.flat()];
}

// ── Inventory and options ──────────────────────────────────────────────────

export interface RootRow {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  status: string;
  deleted: boolean;
  isBenchmark: boolean;
  model: string;
  hasWorkflow: boolean;
}
export interface TreeAgentRow {
  id: string;
  rootId: string;
}
export interface LedgerItem {
  toolUsageId: string;
  agentId: string;
  rootId: string;
  toolName: string;
  itemType: string | null;
  callSite: string | null;
  provider: string | null;
  cacheSequenceId: string | null;
  fromFastCache: boolean;
  cancelled: boolean;
}
export interface CodeSessionRow {
  id: string;
  userId: string;
  rootAgentId: string;
  /** The tree root the mirror archives under (busId, else parentAgentId walk); default rootAgentId. */
  archiveRootAgentId?: string;
  state: string;
  latestCheckpointSeq: number;
}
export interface BundleScan {
  /** Every bundle id under trace-archive/ (sharded delimiter listing). */
  totalBundles: number;
  /** Bundle ids that are neither agent UUIDs nor documented `user-<uuid>` roots. */
  nonUuid: string[];
  /** Documented per-user roots (`user-<uuid>`); listed for information only. */
  userRootBundles: string[];
  /** Bundles named after prod non-root agents. */
  childAgentBundles: string[];
  unknownUuidTotal: number;
  /** Unknown (not a prod Agent) bundle ids first seen since the previous snapshot. */
  newUnknownUuid: string[];
  /** Random sample of the remaining unknown ids (all of them under --orphan-sweep full). */
  sampledUnknownUuid: string[];
  snapshotAvailable: boolean;
}
export interface Inventory {
  roots: RootRow[];
  hubRoots: RootRow[];
  treeAgents: TreeAgentRow[];
  /** Non-root agents active in the window (updatedAt >= since); their bundles must not exist. */
  activeChildren: string[];
  ledger: LedgerItem[];
  codeSessions: CodeSessionRow[];
  bundleScan: BundleScan | null;
}
export interface AuditOptions {
  sinceMs: number;
  untilMs: number;
  nowMs: number;
  v2CutoffMs: number | null;
  graceMs: number;
  concurrency: number;
  maxExamples: number;
  headBytes: number;
  encryptionKey: Buffer | null;
  schema: JsonSchema;
  /** Progress lines (stderr in the CLI); never part of the report. */
  log?: (message: string) => void;
}

/** The key decryptAndValidateArtifact uses (env key, or the dev key outside production). */
export function archiveEncryptionKey(): Buffer | null {
  const raw = (process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 || '').trim();
  if (raw !== '') {
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  }
  const production =
    process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'production';
  return production
    ? null
    : crypto.createHash('sha256').update('rose-trace-archive-dev-key').digest();
}

// ── Small utilities ────────────────────────────────────────────────────────

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isUserRoot(value: string): boolean {
  return value.startsWith('user-') && UUID_RE.test(value.slice('user-'.length));
}

/**
 * Archive call-site family of one ledger usage item. A ToolUsage row's
 * toolName/call_site names the spawning tool, not the model call: explore rows
 * carry browser-use steps (provider "Rose 1 Browser Use", cache sequence
 * `browser-task:<id>:browser_use`), explore planner turns
 * (`…:call:explore_agent`) and page summaries (provider
 * "Rose (summarize_web_fetch)"). The cache sequence suffix and provider name
 * identify the archived call site; generic chat items fall back to toolName.
 */
export function ledgerFamily(
  item: Pick<LedgerItem, 'callSite' | 'toolName'> &
    Partial<Pick<LedgerItem, 'provider' | 'cacheSequenceId'>>
): string {
  const provider = (item.provider ?? '').trim();
  const sequence = /:(?:call:)?([A-Za-z0-9_]+)$/.exec(item.cacheSequenceId ?? '')?.[1];
  if (sequence === 'browser_use' || /browser use/i.test(provider)) return family('browser_use');
  const providerSite = /^Rose \(([A-Za-z0-9_]+)\)$/.exec(provider)?.[1];
  const site = (item.callSite ?? '').trim();
  return family(
    sequence ?? providerSite ?? (site !== '' && site !== 'chat' ? site : item.toolName)
  );
}

export function family(callSite: string | null | undefined): string {
  const raw = (callSite ?? '').trim();
  if (raw === '') return 'unknown';
  const normalized = raw.replace(/_step_\d+$/, '_step_N');
  return FAMILY_ALIASES[normalized] ?? normalized;
}

// ── Record decoding and classification ─────────────────────────────────────

const OUTPUT_CONTENT_KEYS = [
  'content',
  'text',
  'reasoning',
  'reasoning_blocks',
  'codex_reasoning_items',
  'tool_calls',
  'structured',
  'parsed',
  'response',
  'completion',
  'result',
  'message',
  'choices',
  'raw',
  'raw_output',
  'structured_output',
  'output',
];
const OUTPUT_META_KEYS = new Set([
  'usage',
  'timing',
  'error',
  'actual_model',
  'pool_name',
  'provider',
  'request_id',
  'finish_reason',
  'model',
]);

export type OutputState = 'content' | 'empty' | 'absent';

export function outputState(payload: Record<string, unknown>): OutputState {
  const extra = isRecord(payload.extra) ? payload.extra : {};
  const candidates = [payload.output, extra.output, extra.tool_calls];
  let sawEmpty = false;
  for (const out of candidates) {
    if (out === undefined || out === null) continue;
    if (!isRecord(out)) {
      if (nonEmpty(out)) return 'content';
      sawEmpty = true;
      continue;
    }
    if (OUTPUT_CONTENT_KEYS.some((key) => nonEmpty(out[key]))) return 'content';
    if (Object.entries(out).some(([key, v]) => !OUTPUT_META_KEYS.has(key) && nonEmpty(v)))
      return 'content';
    sawEmpty = true;
  }
  return sawEmpty ? 'empty' : 'absent';
}

function errorOf(payload: Record<string, unknown>): Record<string, unknown> | string | null {
  const extra = isRecord(payload.extra) ? payload.extra : {};
  const output = isRecord(payload.output) ? payload.output : {};
  for (const candidate of [payload.error, extra.error, output.error, extra.exception]) {
    if (nonEmpty(candidate)) return candidate as Record<string, unknown> | string;
  }
  if (extra.status === 'error' || extra.status === 'failed') return 'status:error';
  return null;
}

export function isCancelled(payload: Record<string, unknown>): boolean {
  const extra = isRecord(payload.extra) ? payload.extra : {};
  if (extra.cancelled === true || payload.cancelled === true) return true;
  if (['cancelled', 'canceled'].includes(String(extra.status ?? extra.outcome ?? ''))) return true;
  const error = errorOf(payload);
  const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return /cancel|abort/i.test(text);
}

/** W2: Fast Mode / demo-cache replays and synthetic passthroughs (no live model call). */
export function replayKind(
  payload: Record<string, unknown>
): 'cache_replay' | 'passthrough' | null {
  const extra = isRecord(payload.extra) ? payload.extra : {};
  const config = isRecord(payload.config) ? payload.config : {};
  const output = isRecord(payload.output) ? payload.output : {};
  const markers = [
    extra.replay_reason,
    extra.completion_source,
    output.actual_model,
    extra.actual_model,
  ];
  if (markers.some((m) => /passthrough/i.test(String(m ?? '')))) return 'passthrough';
  if (nonEmpty(extra.replay_reason)) return 'cache_replay';
  if (/cache|replay/i.test(String(extra.completion_source ?? ''))) return 'cache_replay';
  const flagged = [extra, config, payload].some(
    (holder) =>
      holder.from_fast_cache === true || holder.cache_replay === true || holder.demo_cache === true
  );
  return flagged ? 'cache_replay' : null;
}

export interface RecordInfo {
  bundle: string;
  key: string;
  kind: 'start' | 'final';
  dumpId: string;
  lastModifiedMs: number;
  callSite: string | null;
  agentId: string | null;
  rootAgentId: string | null;
  spanId: string | null;
  record: string | null;
  schemaVersion: number | null;
  output: OutputState | 'unknown';
  error: boolean;
  cancelled: boolean;
  replay: 'cache_replay' | 'passthrough' | null;
  model: string | null;
  fetch: 'full' | 'head' | 'failed';
  integrityError: string | null;
  schemaErrors: string[] | null;
}

export function emptyInfo(bundle: string, obj: ListedObject, kind: 'start' | 'final'): RecordInfo {
  const name = obj.key.slice(obj.key.lastIndexOf('/') + 1);
  const dumpId =
    kind === 'start'
      ? name.replace(/\.json\.gz\.enc$/, '')
      : (UPDATE_NAME_RE.exec(name)?.[1] ?? name.replace(/\.json\.gz\.enc$/, ''));
  return {
    bundle,
    key: obj.key,
    kind,
    dumpId,
    lastModifiedMs: obj.lastModifiedMs,
    callSite: kind === 'final' ? (UPDATE_NAME_RE.exec(name)?.[3] ?? null) : null,
    agentId: null,
    rootAgentId: null,
    spanId: null,
    record: null,
    schemaVersion: null,
    output: 'unknown',
    error: false,
    cancelled: false,
    replay: null,
    model: null,
    fetch: 'failed',
    integrityError: null,
    schemaErrors: null,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function applyPayload(info: RecordInfo, payload: Record<string, unknown>): void {
  const updateNameCallSite = info.kind === 'final' ? info.callSite : null;
  info.callSite =
    str(payload.call_site) ??
    str(isRecord(payload.extra) ? payload.extra.call_site : null) ??
    (updateNameCallSite === 'update' ? null : updateNameCallSite);
  info.agentId = str(payload.agent_id);
  info.rootAgentId = str(payload.root_agent_id);
  info.spanId = str(payload.span_id);
  info.dumpId = str(payload.dump_id) ?? info.dumpId;
  info.record = str(payload.record);
  info.schemaVersion = typeof payload.schema_version === 'number' ? payload.schema_version : null;
  info.output = outputState(payload);
  info.error = errorOf(payload) !== null;
  info.cancelled = isCancelled(payload);
  info.replay = replayKind(payload) ?? info.replay;
  info.model =
    str(payload.model) ??
    str(isRecord(payload.output) ? payload.output.actual_model : null) ??
    info.model;
}

const HEAD_FIELDS = [
  'call_site',
  'agent_id',
  'root_agent_id',
  'span_id',
  'dump_id',
  'record',
  'schema_version',
  'model',
];

/** Extract top-level identity fields that precede `messages` in a truncated JSON prefix. */
export function parseHead(text: string): Record<string, unknown> | null {
  const messagesAt = text.search(/"messages"\s*:/);
  const limit = messagesAt < 0 ? text.length : messagesAt;
  const head: Record<string, unknown> = {};
  for (const field of HEAD_FIELDS) {
    const match = new RegExp(
      `"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.){0,400}"|-?\\d+|null|true|false)`
    ).exec(text);
    if (match === null || match.index > limit) continue;
    head[field] = JSON.parse(match[1]) as unknown;
  }
  return typeof head.call_site === 'string' ? head : null;
}

function decryptPrefix(prefix: Buffer, metadata: EncryptedArtifactMetadata, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(metadata.nonce_b64, 'base64')
  );
  decipher.setAAD(Buffer.from(metadata.aad, 'utf8'));
  const stored = decipher.update(prefix);
  return metadata.compression === 'gzip'
    ? zlib.gunzipSync(stored, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    : stored;
}

export async function readMetadata(
  source: ArchiveSource,
  key: string
): Promise<EncryptedArtifactMetadata | string> {
  const raw = await source.get(`${key}.meta.json`);
  if (raw === null) return 'missing .meta.json sidecar';
  try {
    return metadataFromUnknown(JSON.parse(raw.toString('utf8')));
  } catch (error) {
    return `bad sidecar: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Fetch, authenticate (full) or prefix-decrypt (head) one encrypted JSON record. */
export async function loadRecord(
  source: ArchiveSource,
  info: RecordInfo,
  mode: 'full' | 'head',
  options: Pick<AuditOptions, 'headBytes' | 'encryptionKey' | 'schema'> & { validate: boolean }
): Promise<RecordInfo> {
  try {
    const metadata = await readMetadata(source, info.key);
    if (typeof metadata === 'string') {
      info.integrityError = metadata;
      return info;
    }
    const partial = mode === 'head' && metadata.ciphertext_bytes > options.headBytes;
    const body = await source.get(info.key, partial ? options.headBytes : undefined);
    if (body === null) {
      info.integrityError = 'missing ciphertext';
      return info;
    }
    if (partial) {
      if (options.encryptionKey === null) throw new Error('encryption key unavailable');
      const head = parseHead(decryptPrefix(body, metadata, options.encryptionKey).toString('utf8'));
      if (head !== null) {
        applyPayload(info, head);
        info.output = 'unknown';
        info.fetch = 'head';
        return info;
      }
      return loadRecord(source, info, 'full', options);
    }
    const plaintext = decryptAndValidateArtifact({ ciphertext: body, metadata });
    const payload = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isRecord(payload)) throw new Error('record is not a JSON object');
    applyPayload(info, payload);
    info.fetch = 'full';
    if (options.validate) info.schemaErrors = validateAgainstSchema(options.schema, payload);
    return info;
  } catch (error) {
    info.integrityError = error instanceof Error ? error.message : String(error);
    return info;
  }
}

/** Decrypt and parse one whole encrypted JSON object (e.g. an R2 code-checkpoint manifest). */
export async function loadJson(source: ArchiveSource, key: string): Promise<unknown> {
  const metadata = await readMetadata(source, key);
  const body = await source.get(key);
  if (typeof metadata === 'string' || body === null) return null;
  try {
    return JSON.parse(decryptAndValidateArtifact({ ciphertext: body, metadata }).toString('utf8'));
  } catch {
    return null;
  }
}

export type CallClass =
  | 'output'
  | 'final_empty_output'
  | 'cache_replay'
  | 'passthrough'
  | 'cancelled'
  | 'failed'
  | 'superseded_attempt'
  | 'in_flight'
  | 'missing_output'
  | 'unreadable';

export const WAIVED_CLASSES: Record<string, string> = {
  cache_replay: 'W2 cache replay',
  passthrough: 'W2 cache passthrough',
  cancelled: 'W1 cancelled request',
  failed: 'W3 failed attempt',
  superseded_attempt: 'W3 failed attempt (retried in the same span)',
};
