import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  decryptAndValidateArtifact,
  validateEncryptedArtifactEnvelope,
  type StoredEncryptedArtifact,
} from './traceArchive';

export function archiveRecoveryBackend(value: string | undefined): string {
  return value?.trim() || 'r2';
}

type Payload = Record<string, unknown>;
type Source = {
  path: string;
  createdAtMs: number;
  payload: Payload;
  proof: Record<string, unknown>;
};
export interface ArchiveDumpReader {
  list(rootAgentId: string): Promise<{ path: string }[]>;
  read(rootAgentId: string, objectPath: string): Promise<StoredEncryptedArtifact | null>;
}
const sha = (body: Buffer): string => crypto.createHash('sha256').update(body).digest('hex');
const segment = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)) {
    throw new Error('Invalid archive agent/dump identity');
  }
  return value;
};
function record(value: unknown): Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Archive dump must be an object');
  }
  return value as Payload;
}
function write(
  root: string,
  relative: string,
  body: Buffer
): { path: string; sha256: string; bytes: number } {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { path: target, sha256: sha(body), bytes: body.length };
}
const json = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function loadSources(
  root: string,
  directory: string,
  reader: ArchiveDumpReader
): Promise<Source[]> {
  const listing = await reader.list(root);
  write(directory, 'listing.json', json(listing));
  const selected = listing.filter((item) =>
    /^(llm|llm-updates)\/[^/]+\.json\.gz\.enc$/.test(item.path)
  );
  if (listing.some((item) => /^(llm|llm-updates)\//.test(item.path) && !selected.includes(item))) {
    throw new Error('Malformed LLM archive object path');
  }
  if (new Set(selected.map((item) => item.path)).size !== selected.length)
    throw new Error('Duplicate archive path');
  const sources: Source[] = [];
  for (const item of selected) {
    const stored = await reader.read(root, item.path);
    if (stored === null) throw new Error(`Missing archive object: ${item.path}`);
    const body = write(directory, `raw/${item.path}`, stored.ciphertext);
    const metadata = write(directory, `raw/${item.path}.meta.json`, json(stored.metadata));
    validateEncryptedArtifactEnvelope({ objectPath: item.path, ...stored });
    const plaintext = decryptAndValidateArtifact(stored);
    const plaintextProof = write(directory, `original/${item.path}.json`, plaintext);
    const wrapper = record(JSON.parse(plaintext.toString('utf8')));
    const payload = wrapper.kind === 'legacy-llm-dump' ? record(wrapper.payload) : wrapper;
    if (payload.root_agent_id !== root) throw new Error('Archive root identity mismatch');
    segment(payload.agent_id);
    segment(payload.dump_id);
    const createdAtMs = stored.metadata.created_at_ms;
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0)
      throw new Error('Missing recorded archive timestamp');
    sources.push({
      path: item.path,
      createdAtMs,
      payload,
      proof: { body, metadata, plaintext: plaintextProof },
    });
  }
  // Equal clocks (a call that starts and finishes within one millisecond) keep
  // the base record before its updates; path order alone would list updates first.
  const kind = (source: Source): number => (source.path.startsWith('llm/') ? 0 : 1);
  return sources.sort(
    (a, b) => a.createdAtMs - b.createdAtMs || kind(a) - kind(b) || a.path.localeCompare(b.path)
  );
}
function mergeUpdate(base: Payload, patch: Payload): void {
  for (const [key, value] of Object.entries(patch)) {
    if (
      (key === 'config' || key === 'extra') &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      base[key] = { ...record(base[key] ?? {}), ...value };
    } else if (!['agent_id', 'span_id', 'dump_id'].includes(key)) {
      base[key] = value;
    }
  }
}
// The Python production writer submits base and partial-patch encryption to
// independent executor jobs. Their recorded encryption-completion clocks do
// not attest submission order. Recognize its exact immutable object protocol;
// Node UUID/ordinal updates retain their base-ack chronology requirement.
function isPythonAsyncPatch(base: Source, update: Source): boolean {
  const dump = base.payload.dump_id;
  if (
    typeof dump !== 'string' ||
    !/^[a-f0-9]{12}$/.test(dump) ||
    base.path !== `llm/${dump}.json.gz.enc` ||
    !Array.isArray(base.payload.messages) ||
    base.payload.message_count !== base.payload.messages.length ||
    typeof base.payload.call_site !== 'string' ||
    update.payload.root_agent_id !== base.payload.root_agent_id ||
    update.payload.agent_id !== base.payload.agent_id ||
    update.payload.dump_id !== dump
  )
    return false;
  const name = update.path.match(
    /^llm-updates\/([a-f0-9]{12})-([1-9][0-9]*)-([\p{L}\p{N}_.-]{1,64})\.json\.gz\.enc$/u
  );
  if (!name || name[1] !== dump || !Number.isSafeInteger(Number(name[2]))) return false;
  const patchKeys = new Set([
    'agent_id',
    'root_agent_id',
    'span_id',
    'dump_id',
    'model',
    'config',
    'response_format',
    'tools',
    'output',
    'extra',
  ]);
  return Object.keys(update.payload).every((key) => patchKeys.has(key));
}

function groupCalls(sources: Source[]): { base: Source; payload: Payload; updates: Source[] }[] {
  const calls = new Map<string, { base: Source; payload: Payload; updates: Source[] }>();
  const key = (source: Source): string => `${source.payload.agent_id}/${source.payload.dump_id}`;
  for (const source of sources.filter((item) => item.path.startsWith('llm/'))) {
    if (calls.has(key(source)) || !Array.isArray(source.payload.messages))
      throw new Error('Duplicate or malformed base call');
    calls.set(key(source), {
      base: source,
      payload: structuredClone(source.payload),
      updates: [],
    });
  }
  for (const update of sources.filter((item) => item.path.startsWith('llm-updates/'))) {
    const call = calls.get(key(update));
    if (!call) throw new Error('Orphan or pre-base archive update');
    if (update.createdAtMs < call.base.createdAtMs) {
      if (!isPythonAsyncPatch(call.base, update))
        throw new Error('Orphan or pre-base archive update');
      // Preserve the raw envelope and its actual clock. This is a format-bound
      // interpretation of encryption completion, not a reconstructed timestamp.
      update.proof.ordering = {
        protocol: 'python-async-partial-patch',
        encryptionCompletionDeltaMs: update.createdAtMs - call.base.createdAtMs,
      };
    }
    mergeUpdate(call.payload, update.payload);
    call.updates.push(update);
  }
  if (calls.size === 0) throw new Error('No archived LLM base calls');
  return [...calls.values()];
}

export async function materializeArchiveLlmDumps(
  rootAgentId: string,
  outputDir: string,
  reader: ArchiveDumpReader
) {
  segment(rootAgentId);
  const parent = path.resolve(outputDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A fresh private child prevents overwrites and symlink collisions on repeat invocations.
  const directory = fs.mkdtempSync(path.join(parent, `${rootAgentId}-`));
  fs.chmodSync(directory, 0o700);
  const sources = await loadSources(rootAgentId, directory, reader);
  const grouped = groupCalls(sources);
  const calls = grouped.map(({ base, payload, updates }) => ({
    agentId: segment(payload.agent_id),
    dumpId: segment(payload.dump_id),
    recordedCreatedAtMs: base.createdAtMs,
    baseObject: base.path,
    appliedUpdates: updates.map((item) => item.path),
    ...write(
      directory,
      `calls/${segment(payload.agent_id)}/${base.createdAtMs}-${segment(payload.dump_id)}.json`,
      json(payload)
    ),
  }));
  // Update arrival never changes the chronology of the actual base calls.
  calls.sort(
    (a, b) =>
      a.recordedCreatedAtMs - b.recordedCreatedAtMs || a.baseObject.localeCompare(b.baseObject)
  );
  const latest = calls[calls.length - 1];
  const manifest = {
    rootAgentId,
    baseCallCount: calls.length,
    updateCount: sources.length - calls.length,
    agentIds: [...new Set(calls.map((call) => call.agentId))].sort(),
    latest,
    calls,
    sources,
    selection:
      'Latest BASE metadata.created_at_ms across requested root; recorded updates merged without synthetic provenance',
  };
  const proof = write(directory, 'manifest.json', json(manifest));
  return {
    ...manifest,
    manifestPath: proof.path,
    manifestSha256: proof.sha256,
  };
}
