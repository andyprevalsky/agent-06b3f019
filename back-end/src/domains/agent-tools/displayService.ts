/**
 * `display`: publish images / videos / HTML and either post them inline in the
 * caller's trajectory or pin them with a question above the user's query box.
 *
 *   items (url | file | content_base64), caption, placement, options
 *     │ resolve bytes  (url: bounded SSRF-guarded fetch; file: tree pointer or
 *     │                 owner storage path; base64: decode)       ── all-or-nothing
 *     │ classify       (magic bytes → image/* | video/*; declared + UTF-8 markup → text/html)
 *     │ caps           (≤ 20 items, ≤ 20 MB each, ≤ 100 MB total)
 *     ▼ per unique sha256: put <userId>/display/<sha256>.<ext>   (write-once)
 *
 *   inline ─► ASSISTANT message per unique item,
 *             id = deterministicMessageId(agentId, "display:<sha256>")
 *             exists ─► duplicate (no post)                       (P2002-safe)
 *   pinned ─► questionService.openQuestion (routing: user pin | parent A2A)
 *
 * The FE already renders ASSISTANT messages with an image/video file_pointer
 * inline (AssistantAttachmentBubble), so inline media needs no new message type.
 */
import { createHash } from '../../providers/crypto';
import {
  DISPLAY_EXTENSIONS,
  DisplayFetchError,
  classifyDisplayMedia,
  displayUsercontentUrl,
  fetchDisplayMedia,
  getDisplayObject,
  putDisplayObject,
} from '../../providers/agentTools/media';
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
import { openQuestion } from './questionService';
import { AgentToolsError, sandboxRowMetadata, type ToolContext } from './service';
import type {
  DisplayFilePointer,
  DisplayItemInput,
  DisplayItemResult,
  DisplayRequestBody,
  DisplayResult,
} from './types';

const log = createLogger('AgentToolsDisplay');
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

interface ResolvedItem {
  index: number;
  bytes: Buffer;
  filename: string;
  contentType: string;
}

interface StoredItem extends ResolvedItem {
  sha256: string;
  mimeType: string;
  filePointer: DisplayFilePointer;
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

async function resolveFile(
  agent: repo.ToolAgent,
  file: string
): Promise<{ bytes: Buffer; mime: string }> {
  // An exact storage path is accepted only inside the owner's prefix.
  if (file.startsWith(`${agent.userId}/`) && !file.includes('..')) {
    const bytes = await getDisplayObject(file);
    if (bytes) return { bytes, mime: '' };
  }
  const pointer = await repo.findTreeFilePointer(agent, file);
  const storagePath = typeof pointer?.storage_path === 'string' ? pointer.storage_path : null;
  if (storagePath === null || !storagePath.startsWith(`${agent.userId}/`)) {
    throw new DisplayFetchError(`no file named ${file.slice(0, 200)} in this agent's files`);
  }
  const bytes = await getDisplayObject(storagePath);
  if (!bytes) throw new DisplayFetchError(`${file.slice(0, 200)} is no longer in storage`);
  return { bytes, mime: typeof pointer?.mime_type === 'string' ? pointer.mime_type : '' };
}

async function resolveItem(
  agent: repo.ToolAgent,
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
      contentType: '',
    };
  }
  if (item.url !== undefined) {
    const { bytes, finalUrl, contentType } = await fetchDisplayMedia(item.url, {
      maxBytes: DISPLAY_MAX_FILE_BYTES,
      timeoutMs: DISPLAY_URL_TIMEOUT_MS,
    });
    return {
      index,
      bytes,
      filename: basename(item.filename ?? new URL(finalUrl).pathname),
      contentType,
    };
  }
  const file = item.file ?? '';
  const { bytes, mime } = await resolveFile(agent, file);
  return { index, bytes, filename: basename(item.filename ?? file), contentType: mime };
}

/** Resolve every item (bounded concurrency); any failure rejects the whole call. */
async function resolveAll(
  agent: repo.ToolAgent,
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
  if (errors.length > 0) throw new AgentToolsError(400, 'Could not read media', errors.sort());
  return results;
}

function mediaType(entry: ResolvedItem): string | null {
  return classifyDisplayMedia(entry.bytes, {
    filename: entry.filename,
    contentType: entry.contentType,
  });
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
    } else if (mediaType(entry) === null) {
      errors.push(
        `${label}: is not an image, video or HTML page (allowed: image/*, video/*, text/html as .html; SVG excluded)`
      );
    }
  }
  if (total > DISPLAY_MAX_TOTAL_BYTES) {
    errors.push(`total size exceeds ${DISPLAY_MAX_TOTAL_BYTES / 1024 / 1024} MB`);
  }
  return errors;
}

/** Upload once per content hash (content-addressed, write-once keys). */
async function storeAll(agent: repo.ToolAgent, resolved: ResolvedItem[]): Promise<StoredItem[]> {
  const stored: StoredItem[] = [];
  const uploaded = new Set<string>();
  for (const entry of resolved) {
    const sha256 = createHash('sha256').update(entry.bytes).digest('hex');
    const mimeType = mediaType(entry) ?? 'application/octet-stream';
    const ext = DISPLAY_EXTENSIONS[mimeType] ?? 'bin';
    const storagePath = `${agent.userId}/display/${sha256}.${ext}`;
    if (!uploaded.has(storagePath)) {
      await putDisplayObject(storagePath, entry.bytes, mimeType);
      uploaded.add(storagePath);
    }
    const stem = entry.filename.replace(/\.[^.]*$/, '') || 'media';
    stored.push({
      ...entry,
      sha256,
      mimeType,
      filePointer: {
        id: deterministicMessageId(agent.id, `display:${sha256}`),
        storage_path: storagePath,
        original_filename: `${stem}.${ext}`,
        mime_type: mimeType,
        size_bytes: entry.bytes.length,
        created_at: new Date().toISOString(),
        ...(mimeType === 'text/html'
          ? { usercontent_url: displayUsercontentUrl(agent.id, sha256) }
          : {}),
      },
    });
  }
  return stored;
}

async function postInline(
  ctx: ToolContext,
  entry: StoredItem,
  caption: string
): Promise<DisplayItemResult> {
  const messageId = deterministicMessageId(ctx.agent.id, `display:${entry.sha256}`);
  const existing = await repo.findMessage(messageId);
  if (existing) {
    return {
      index: entry.index,
      status: 'duplicate',
      message_id: existing.id,
      sha256: entry.sha256,
      mime_type: entry.mimeType,
      file_pointer: (existing.filePointer as DisplayFilePointer | null) ?? entry.filePointer,
    };
  }
  const message = await createMessage({
    agentId: ctx.agent.id,
    text: caption,
    role: 'ASSISTANT',
    metadata: {
      source: 'display',
      idempotencyKey: `display:${entry.sha256}`,
      display: {
        placement: 'inline',
        kind: 'media',
        sha256: entry.sha256,
        mime_type: entry.mimeType,
        ...(caption ? { caption } : {}),
      },
      requestingAgent: ctx.requesting,
      // The media is shown to the user; the caller's model gets the tool
      // result instead, so this row never splits a tool_use / tool_result pair.
      excludeFromModel: true,
      ...sandboxRowMetadata(ctx),
    },
    filePointer: entry.filePointer,
  });
  log.info('Displayed media', {
    agent_id: ctx.agent.id,
    message_id: message.id,
    sha256: entry.sha256,
    mime_type: entry.mimeType,
    size_bytes: entry.bytes.length,
    via: ctx.requesting.kind,
  });
  return {
    index: entry.index,
    status: message.id === messageId ? 'posted' : 'duplicate',
    message_id: message.id,
    sha256: entry.sha256,
    mime_type: entry.mimeType,
    file_pointer: (message.filePointer as DisplayFilePointer | null) ?? entry.filePointer,
  };
}

export async function displayMedia(
  ctx: ToolContext,
  body: DisplayRequestBody
): Promise<DisplayResult> {
  const resolved = await resolveAll(ctx.agent, body.items);
  const errors = validateMedia(body.items, resolved);
  if (errors.length > 0) throw new AgentToolsError(400, 'Invalid media', errors);
  const stored = await storeAll(ctx.agent, resolved);
  const caption = body.caption?.trim() ?? '';

  if (body.placement === 'pinned') {
    const question = await openQuestion(ctx, {
      question: caption,
      options: body.options ?? [],
      allowOther: body.allow_other !== false,
      media: stored.map((entry) => entry.filePointer),
      requestKey: body.request_key,
      workflowId: body.workflow_id,
    });
    return {
      agent_id: ctx.agent.id,
      placement: 'pinned',
      posted_count: 0,
      duplicate_count: 0,
      items: stored.map((entry) => ({
        index: entry.index,
        status: 'attached',
        message_id: question.message_id,
        sha256: entry.sha256,
        mime_type: entry.mimeType,
        file_pointer: entry.filePointer,
      })),
      question,
    };
  }

  const results: DisplayItemResult[] = [];
  const seen = new Map<string, DisplayItemResult>();
  let captionPending = caption;
  // Sequential: keeps trajectory order equal to argument order.
  for (const entry of stored) {
    const prior = seen.get(entry.sha256);
    if (prior) {
      results.push({ ...prior, index: entry.index, status: 'duplicate' });
      continue;
    }
    const result = await postInline(ctx, entry, captionPending);
    if (result.status === 'posted') captionPending = '';
    seen.set(entry.sha256, result);
    results.push(result);
  }
  return {
    agent_id: ctx.agent.id,
    placement: 'inline',
    posted_count: results.filter((r) => r.status === 'posted').length,
    duplicate_count: results.filter((r) => r.status === 'duplicate').length,
    items: results,
  };
}
