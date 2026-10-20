/**
 * `display`: publish images/videos and post them inline in ONE agent's
 * trajectory, at most once per (agent, content hash).
 *
 *   items (url | file | content_base64), caption
 *     │ resolve bytes  (url: bounded SSRF-guarded fetch; file: tree pointer or
 *     │                 owner storage path; base64: decode)       ── all-or-nothing
 *     │ sniff type     (magic bytes → image/* | video/*, else 400)
 *     │ caps           (≤ 20 items, ≤ 20 MB each, ≤ 100 MB total)
 *     ▼ per unique sha256:
 *       message id = deterministicMessageId(agentId, "display:<sha256>")
 *         exists ─► duplicate (no upload, no post)
 *         else   ─► put <userId>/display/<sha256>.<ext>  (write-once)
 *                ─► createMessage ASSISTANT + file_pointer   (P2002-safe)
 *
 * The FE already renders ASSISTANT messages with an image/video file_pointer
 * inline (AssistantAttachmentBubble), so no new message type is needed.
 *
 * 10k-agent behaviour: work is bounded per call (≤ 20 items, ≤ 4 concurrent
 * fetches), dedupe is a primary-key lookup per item, and each message is
 * broadcast only on its own agent channel. `file` lookups scan one bounded
 * tree (≤ 500 agents) once per call.
 */
import { createHash } from '../../providers/crypto';
import {
  DISPLAY_EXTENSIONS,
  DisplayFetchError,
  fetchDisplayMedia,
  getDisplayObject,
  putDisplayObject,
  sniffDisplayMediaType,
} from '../../providers/display/media';
import { createLogger } from '../../providers/logger';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { createMessage } from '../../providers/messages';
import {
  DISPLAY_FETCH_CONCURRENCY,
  DISPLAY_MAX_FILE_BYTES,
  DISPLAY_MAX_TOTAL_BYTES,
  DISPLAY_URL_TIMEOUT_MS,
} from './config';
import * as repo from './repo';
import type {
  DisplayFilePointer,
  DisplayItemInput,
  DisplayItemResult,
  DisplayRequestBody,
  DisplayResult,
} from './types';

const log = createLogger('Display');
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class DisplayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[]
  ) {
    super(message);
  }
}

export type DisplayVia = 'agent' | 'cli' | 'user';

interface ResolvedItem {
  index: number;
  bytes: Buffer;
  filename: string;
}

function itemLabel(item: DisplayItemInput, index: number): string {
  const name = item.url ?? item.file ?? item.filename ?? `item ${index + 1}`;
  return `#${index + 1} ${name.slice(0, 200)}`;
}

function basename(value: string): string {
  const stripped = value.split(/[?#]/)[0] ?? value;
  const last = stripped.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'media';
}

async function resolveFile(agent: repo.DisplayAgent, file: string): Promise<Buffer> {
  // An exact storage path is accepted only inside the owner's prefix.
  if (file.startsWith(`${agent.userId}/`) && !file.includes('..')) {
    const bytes = await getDisplayObject(file);
    if (bytes) return bytes;
  }
  const pointer = await repo.findTreeFilePointer(agent, file);
  const storagePath = typeof pointer?.storage_path === 'string' ? pointer.storage_path : null;
  if (storagePath === null || !storagePath.startsWith(`${agent.userId}/`)) {
    throw new DisplayFetchError(`no file named ${file.slice(0, 200)} in this agent's files`);
  }
  const bytes = await getDisplayObject(storagePath);
  if (!bytes) throw new DisplayFetchError(`${file.slice(0, 200)} is no longer in storage`);
  return bytes;
}

async function resolveItem(
  agent: repo.DisplayAgent,
  item: DisplayItemInput,
  index: number
): Promise<ResolvedItem> {
  if (item.content_base64 !== undefined) {
    const raw = item.content_base64;
    if (raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
      throw new DisplayFetchError('content_base64 is not valid base64');
    }
    return {
      index,
      bytes: Buffer.from(raw, 'base64'),
      filename: basename(item.filename ?? 'media'),
    };
  }
  if (item.url !== undefined) {
    const { bytes, finalUrl } = await fetchDisplayMedia(item.url, {
      maxBytes: DISPLAY_MAX_FILE_BYTES,
      timeoutMs: DISPLAY_URL_TIMEOUT_MS,
    });
    return { index, bytes, filename: basename(item.filename ?? new URL(finalUrl).pathname) };
  }
  const file = item.file ?? '';
  return {
    index,
    bytes: await resolveFile(agent, file),
    filename: basename(item.filename ?? file),
  };
}

/** Resolve every item (bounded concurrency); any failure rejects the whole call. */
async function resolveAll(
  agent: repo.DisplayAgent,
  items: DisplayItemInput[]
): Promise<ResolvedItem[]> {
  const results: ResolvedItem[] = new Array(items.length);
  const errors: string[] = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await resolveItem(agent, items[index], index);
      } catch (err) {
        if (!(err instanceof DisplayFetchError)) throw err;
        errors.push(`${itemLabel(items[index], index)}: ${err.message}`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DISPLAY_FETCH_CONCURRENCY, items.length) }, worker)
  );
  if (errors.length > 0) throw new DisplayError(400, 'Could not read media', errors.sort());
  return results;
}

function validateMedia(items: DisplayItemInput[], resolved: ResolvedItem[]): string[] {
  const errors: string[] = [];
  let total = 0;
  for (const entry of resolved) {
    const label = itemLabel(items[entry.index], entry.index);
    total += entry.bytes.length;
    if (entry.bytes.length === 0) errors.push(`${label}: is empty`);
    else if (entry.bytes.length > DISPLAY_MAX_FILE_BYTES) {
      errors.push(`${label}: is larger than ${DISPLAY_MAX_FILE_BYTES / 1024 / 1024} MB`);
    } else if (sniffDisplayMediaType(entry.bytes) === null) {
      errors.push(`${label}: is not an image or video (allowed: image/*, video/*; SVG excluded)`);
    }
  }
  if (total > DISPLAY_MAX_TOTAL_BYTES) {
    errors.push(`total size exceeds ${DISPLAY_MAX_TOTAL_BYTES / 1024 / 1024} MB`);
  }
  return errors;
}

function pointerFromMessage(filePointer: unknown): DisplayFilePointer {
  return filePointer as DisplayFilePointer;
}

async function postOne(
  agent: repo.DisplayAgent,
  entry: ResolvedItem,
  caption: string,
  via: DisplayVia
): Promise<DisplayItemResult> {
  const sha256 = createHash('sha256').update(entry.bytes).digest('hex');
  const mimeType = sniffDisplayMediaType(entry.bytes) ?? 'application/octet-stream';
  const messageId = deterministicMessageId(agent.id, `display:${sha256}`);
  const existing = await repo.findMessage(messageId);
  if (existing) {
    return {
      index: entry.index,
      status: 'duplicate',
      message_id: existing.id,
      sha256,
      mime_type: mimeType,
      file_pointer: pointerFromMessage(existing.filePointer),
    };
  }
  const ext = DISPLAY_EXTENSIONS[mimeType] ?? 'bin';
  const storagePath = `${agent.userId}/display/${sha256}.${ext}`;
  await putDisplayObject(storagePath, entry.bytes, mimeType);
  const stem = entry.filename.replace(/\.[^.]*$/, '') || 'media';
  const filePointer: DisplayFilePointer = {
    id: messageId,
    storage_path: storagePath,
    original_filename: `${stem}.${ext}`,
    mime_type: mimeType,
    size_bytes: entry.bytes.length,
    created_at: new Date().toISOString(),
  };
  const message = await createMessage({
    agentId: agent.id,
    text: caption,
    role: 'ASSISTANT',
    metadata: {
      source: 'display',
      idempotencyKey: `display:${sha256}`,
      display: { sha256, via, ...(caption ? { caption } : {}) },
    },
    filePointer,
  });
  log.info('Displayed media', {
    agent_id: agent.id,
    message_id: message.id,
    sha256,
    mime_type: mimeType,
    size_bytes: entry.bytes.length,
    via,
  });
  return {
    index: entry.index,
    status: message.id === messageId ? 'posted' : 'duplicate',
    message_id: message.id,
    sha256,
    mime_type: mimeType,
    file_pointer: pointerFromMessage(message.filePointer ?? filePointer),
  };
}

/**
 * Display media in `agentId`'s trajectory. `actorUserId` (when set) must own
 * the agent; internal callers pass null.
 */
export async function displayMedia(input: {
  agentId: string;
  actorUserId: string | null;
  body: DisplayRequestBody;
  via: DisplayVia;
}): Promise<DisplayResult> {
  const agent = await repo.findAgent(input.agentId);
  if (!agent) throw new DisplayError(404, 'Agent not found');
  if (input.actorUserId !== null && input.actorUserId !== agent.userId) {
    throw new DisplayError(403, 'Not allowed to display media for this agent');
  }
  const { items } = input.body;
  const resolved = await resolveAll(agent, items);
  const errors = validateMedia(items, resolved);
  if (errors.length > 0) throw new DisplayError(400, 'Invalid media', errors);

  const caption = input.body.caption?.trim() ?? '';
  const results: DisplayItemResult[] = [];
  const seen = new Map<string, DisplayItemResult>();
  let captionPending = caption;
  // Sequential: keeps trajectory order equal to argument order.
  for (const entry of resolved) {
    const sha = createHash('sha256').update(entry.bytes).digest('hex');
    const prior = seen.get(sha);
    if (prior) {
      results.push({ ...prior, index: entry.index, status: 'duplicate' });
      continue;
    }
    const result = await postOne(agent, entry, captionPending, input.via);
    if (result.status === 'posted') captionPending = '';
    seen.set(sha, result);
    results.push(result);
  }
  return {
    agent_id: agent.id,
    posted_count: results.filter((r) => r.status === 'posted').length,
    duplicate_count: results.filter((r) => r.status === 'duplicate').length,
    items: results,
  };
}
