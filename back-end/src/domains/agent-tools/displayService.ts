/**
 * `display`: publish images, videos, web pages, multi-file sites, 3D models and
 * PDFs, and either post them inline in the caller's trajectory or pin them with
 * a question above the user's query box.
 *
 *   items (url | file | content_base64 | bundle), caption, placement, options
 *     │ resolve bytes  (url: bounded SSRF-guarded fetch; file: tree pointer or
 *     │                 owner storage path, plus the tree files an .html/.gltf/
 *     │                 .obj references; base64: decode; bundle: decode files)
 *     │ classify       (magic bytes → image/* video/* pdf glb; declared + checked
 *     │                 → text/html, .gltf/.obj/.stl/.usdz)        ── all-or-nothing
 *     │ caps           (≤ 20 items, ≤ 20 MB per file, ≤ 100 MB per call;
 *     │                 bundles ≤ 500 files and ≤ 50 MB)
 *     ▼ kind
 *     image / video ─► <owner>/display/<sha256>.<ext>            (write-once)
 *     page (.html)  ─► <owner>/display/<sha256>.html             → usercontent page URL
 *     bundle        ─► blobs + manifest (providers/agentTools/displayBundle.ts)
 *     model / pdf   ─► bundle of the file + a generated viewer   → usercontent bundle URL
 *
 *   inline ─► ASSISTANT message per unique item,
 *             id = deterministicMessageId(agentId, "display:<sha256 | bundle hash>")
 *             exists ─► duplicate (no post)                       (P2002-safe)
 *   pinned ─► questionService.openQuestion (routing: user pin | parent A2A)
 *
 * Framed kinds carry `file_pointer.usercontent_url` + `kind`; the FE frames
 * them with DISPLAY_IFRAME_SANDBOX (providers/agentTools/displayCsp.ts).
 */
import { createHash } from '../../providers/crypto';
import {
  DISPLAY_BUNDLE_MAX_FILES,
  DISPLAY_MODEL_EXTENSIONS,
  buildDisplayBundle,
  collectDisplayBundleFiles,
  displayBundleKey,
  storeDisplayBundle,
  type BuiltDisplayBundle,
  type DisplayBundleKind,
} from '../../providers/agentTools/displayBundle';
import {
  DISPLAY_EXTENSIONS,
  DisplayFetchError,
  classifyDisplayMedia,
  displayBundleUsercontentUrl,
  displayKindForType,
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
  DisplayKind,
  DisplayRequestBody,
  DisplayResult,
} from './types';

const log = createLogger('AgentToolsDisplay');
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TYPES_HELP =
  'allowed: image/*, video/*, an .html page, a 3D model (.glb .gltf .obj .stl .usdz), a .pdf, or a site folder; SVG excluded';

type ResolvedItem =
  | {
      index: number;
      type: 'single';
      bytes: Buffer;
      filename: string;
      contentType: string;
      /** URL-fetched pages keep resolving relative links against their origin. */
      sourceUrl?: string;
    }
  | { index: number; type: 'bundle'; entry: string; files: Map<string, Buffer> };

interface PreparedItem {
  index: number;
  sha256: string;
  mimeType: string;
  kind: DisplayKind;
  sizeBytes: number;
  filePointer: DisplayFilePointer;
  store: () => Promise<void>;
}

function itemLabel(item: DisplayItemInput, index: number): string {
  const name = item.url ?? item.file ?? item.bundle?.entry ?? item.filename ?? `item ${index + 1}`;
  return `#${index + 1} ${name.slice(0, 200)}`;
}

function basename(value: string): string {
  const stripped = value.split(/[?#]/)[0] ?? value;
  const last = stripped.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'media';
}

const extOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const isBundleRoot = (name: string) => /\.(html?|gltf|obj)$/i.test(name);

function decodeBase64(raw: string, label: string): Buffer {
  if (raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
    throw new DisplayFetchError(`${label} is not valid base64`);
  }
  return Buffer.from(raw, 'base64');
}

/** Bytes of a tree pointer, only inside the owner's storage prefix. */
async function pointerBytes(agent: repo.ToolAgent, pointer: Record<string, unknown> | null) {
  const storagePath = typeof pointer?.storage_path === 'string' ? pointer.storage_path : null;
  if (storagePath === null || !storagePath.startsWith(`${agent.userId}/`)) return null;
  const bytes = await getDisplayObject(storagePath);
  return bytes ? { bytes, mime: typeof pointer?.mime_type === 'string' ? pointer.mime_type : '' } : null;
}

async function resolveFile(
  agent: repo.ToolAgent,
  file: string,
  lookup: ReturnType<typeof repo.treeFilePointerResolver>
): Promise<{ bytes: Buffer; mime: string }> {
  // An exact storage path is accepted only inside the owner's prefix.
  if (file.startsWith(`${agent.userId}/`) && !file.includes('..')) {
    const bytes = await getDisplayObject(file);
    if (bytes) return { bytes, mime: '' };
  }
  const pointer = await lookup(file);
  if (pointer === null || typeof pointer.storage_path !== 'string') {
    throw new DisplayFetchError(`no file named ${file.slice(0, 200)} in this agent's files`);
  }
  const found = await pointerBytes(agent, pointer);
  if (!found) throw new DisplayFetchError(`${file.slice(0, 200)} is no longer in storage`);
  return found;
}

/**
 * A Rose agent's tree files are flat (named, not foldered): a reference to
 * `assets/style.css` resolves to the tree file named exactly that, else to
 * one named `style.css`.
 */
function treeSiblingResolver(
  agent: repo.ToolAgent,
  lookup: ReturnType<typeof repo.treeFilePointerResolver>
) {
  return async (path: string): Promise<Buffer | null> => {
    const name = path.split('/').pop() ?? path;
    for (const candidate of name === path ? [path] : [path, name]) {
      const found = await pointerBytes(agent, await lookup(candidate));
      if (found) return found.bytes;
    }
    return null;
  };
}

async function resolveItem(
  agent: repo.ToolAgent,
  item: DisplayItemInput,
  index: number,
  lookup: ReturnType<typeof repo.treeFilePointerResolver>
): Promise<ResolvedItem> {
  if (item.content_base64 !== undefined) {
    return {
      index,
      type: 'single',
      bytes: decodeBase64(item.content_base64, 'content_base64'),
      filename: basename(item.filename ?? 'media'),
      contentType: '',
    };
  }
  if (item.bundle !== undefined) {
    const files = new Map<string, Buffer>();
    for (const file of item.bundle.files) {
      if (files.has(file.path)) throw new DisplayFetchError(`duplicate path ${file.path}`);
      files.set(file.path, decodeBase64(file.content_base64, file.path.slice(0, 200)));
    }
    return { index, type: 'bundle', entry: item.bundle.entry, files };
  }
  if (item.url !== undefined) {
    const { bytes, finalUrl, contentType } = await fetchDisplayMedia(item.url, {
      maxBytes: DISPLAY_MAX_FILE_BYTES,
      timeoutMs: DISPLAY_URL_TIMEOUT_MS,
    });
    return {
      index,
      type: 'single',
      bytes,
      filename: basename(item.filename ?? new URL(finalUrl).pathname),
      contentType,
      sourceUrl: finalUrl,
    };
  }
  const file = item.file ?? '';
  const { bytes, mime } = await resolveFile(agent, file, lookup);
  const filename = basename(item.filename ?? file);
  if (isBundleRoot(filename)) {
    const files = await collectDisplayBundleFiles(
      filename,
      bytes,
      treeSiblingResolver(agent, lookup)
    );
    if (files.size > 1) return { index, type: 'bundle', entry: filename, files };
  }
  return { index, type: 'single', bytes, filename, contentType: mime };
}

/** Resolve every item (bounded concurrency); any failure rejects the whole call. */
async function resolveAll(
  agent: repo.ToolAgent,
  items: DisplayItemInput[]
): Promise<ResolvedItem[]> {
  const results: ResolvedItem[] = new Array(items.length);
  const errors: string[] = [];
  const lookup = repo.treeFilePointerResolver(agent);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await resolveItem(agent, items[index], index, lookup);
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

/** `<base href>` so a fetched page's relative links still load from its own site. */
function withBaseHref(html: Buffer, url: string): Buffer {
  const text = html.toString('utf8');
  if (/<base\b/i.test(text)) return html;
  const tag = `<base href="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  const anchor = /<head\b[^>]*>/i.exec(text) ?? /<html\b[^>]*>/i.exec(text) ?? /<!doctype[^>]*>/i.exec(text);
  if (!anchor) return Buffer.from(tag + text);
  const at = anchor.index + anchor[0].length;
  return Buffer.from(text.slice(0, at) + tag + text.slice(at));
}

/** The model / PDF file name the viewer loads, with the extension of its real type. */
function viewerSourceName(filename: string, mimeType: string): string {
  const ext = DISPLAY_EXTENSIONS[mimeType] ?? 'bin';
  if (extOf(filename) === ext) return filename;
  return `${filename.replace(/\.[^.]*$/, '') || 'model'}.${ext}`;
}

function bundleKindForEntry(entry: string, bytes: Buffer): DisplayBundleKind {
  const type = classifyDisplayMedia(bytes, { filename: entry });
  if (type === 'text/html') return 'bundle';
  if (type === 'application/pdf') return 'pdf';
  if (type?.startsWith('model/') && DISPLAY_MODEL_EXTENSIONS.has(extOf(entry))) return 'model';
  throw new DisplayFetchError(
    `entry ${entry.slice(0, 200)} must be an .html page, a 3D model (.glb .gltf .obj .stl .usdz) or a .pdf`
  );
}

function pointerBase(agent: repo.ToolAgent, sha: string) {
  return {
    id: deterministicMessageId(agent.id, `display:${sha}`),
    created_at: new Date().toISOString(),
  };
}

function prepareBundle(
  agent: repo.ToolAgent,
  index: number,
  source: string,
  files: Map<string, Buffer>,
  kind: DisplayBundleKind
): PreparedItem {
  const built: BuiltDisplayBundle = buildDisplayBundle(source, files, kind);
  const sourceType =
    classifyDisplayMedia(files.get(source) as Buffer, { filename: source }) ?? 'text/html';
  const displayKind: DisplayKind = kind;
  return {
    index,
    sha256: built.hash,
    mimeType: sourceType,
    kind: displayKind,
    sizeBytes: built.totalBytes,
    filePointer: {
      ...pointerBase(agent, built.hash),
      storage_path: displayBundleKey(agent.userId, built.hash),
      original_filename: source.split('/').pop() ?? source,
      mime_type: sourceType,
      size_bytes: built.totalBytes,
      kind: displayKind,
      usercontent_url: displayBundleUsercontentUrl(agent.id, built.hash, built.manifest.entry),
      bundle: {
        hash: built.hash,
        entry: built.manifest.entry,
        source,
        file_count: Object.keys(built.manifest.files).length,
      },
    },
    store: () => storeDisplayBundle(agent.userId, built),
  };
}

function prepareSingle(
  agent: repo.ToolAgent,
  entry: Extract<ResolvedItem, { type: 'single' }>
): PreparedItem {
  const mimeType = classifyDisplayMedia(entry.bytes, {
    filename: entry.filename,
    contentType: entry.contentType,
  });
  if (mimeType === null) throw new DisplayFetchError(`is not a displayable file (${TYPES_HELP})`);
  const kind = displayKindForType(mimeType);
  if (kind === 'model' || kind === 'pdf') {
    const source = viewerSourceName(entry.filename, mimeType);
    return prepareBundle(agent, entry.index, source, new Map([[source, entry.bytes]]), kind);
  }
  const bytes =
    kind === 'page' && entry.sourceUrl ? withBaseHref(entry.bytes, entry.sourceUrl) : entry.bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ext = DISPLAY_EXTENSIONS[mimeType] ?? 'bin';
  const storagePath = `${agent.userId}/display/${sha256}.${ext}`;
  const stem = entry.filename.replace(/\.[^.]*$/, '') || 'media';
  return {
    index: entry.index,
    sha256,
    mimeType,
    kind,
    sizeBytes: bytes.length,
    filePointer: {
      ...pointerBase(agent, sha256),
      storage_path: storagePath,
      original_filename: `${stem}.${ext}`,
      mime_type: mimeType,
      size_bytes: bytes.length,
      kind,
      ...(kind === 'page' ? { usercontent_url: displayUsercontentUrl(agent.id, sha256) } : {}),
    },
    store: () => putDisplayObject(storagePath, bytes, mimeType),
  };
}

/** Classify + build every item; all-or-nothing, every problem reported at once. */
function prepareAll(
  agent: repo.ToolAgent,
  items: DisplayItemInput[],
  resolved: ResolvedItem[]
): PreparedItem[] {
  const errors: string[] = [];
  const prepared: PreparedItem[] = [];
  let total = 0;
  for (const entry of resolved) {
    const label = itemLabel(items[entry.index], entry.index);
    try {
      if (entry.type === 'single') {
        total += entry.bytes.length;
        if (entry.bytes.length === 0) throw new DisplayFetchError('is empty');
        if (entry.bytes.length > DISPLAY_MAX_FILE_BYTES) {
          throw new DisplayFetchError(`is larger than ${DISPLAY_MAX_FILE_BYTES / 1024 / 1024} MB`);
        }
        prepared.push(prepareSingle(agent, entry));
      } else {
        for (const bytes of entry.files.values()) total += bytes.length;
        if (entry.files.size > DISPLAY_BUNDLE_MAX_FILES) {
          throw new DisplayFetchError(
            `bundle has ${entry.files.size} files (max ${DISPLAY_BUNDLE_MAX_FILES})`
          );
        }
        const entryBytes = entry.files.get(entry.entry);
        if (!entryBytes) {
          throw new DisplayFetchError(`entry ${entry.entry.slice(0, 200)} is not one of the files`);
        }
        const kind = bundleKindForEntry(entry.entry, entryBytes);
        prepared.push(prepareBundle(agent, entry.index, entry.entry, entry.files, kind));
      }
    } catch (err) {
      if (!(err instanceof DisplayFetchError)) throw err;
      errors.push(`${label}: ${err.message}`);
    }
  }
  if (total > DISPLAY_MAX_TOTAL_BYTES) {
    errors.push(`total size exceeds ${DISPLAY_MAX_TOTAL_BYTES / 1024 / 1024} MB`);
  }
  if (errors.length > 0) throw new AgentToolsError(400, 'Invalid media', errors);
  return prepared;
}

/** Upload once per content hash (content-addressed, write-once keys). */
async function storeAll(prepared: PreparedItem[]): Promise<void> {
  const stored = new Set<string>();
  for (const entry of prepared) {
    if (stored.has(entry.sha256)) continue;
    await entry.store();
    stored.add(entry.sha256);
  }
}

function itemResult(
  entry: PreparedItem,
  status: DisplayItemResult['status'],
  messageId: string | null,
  pointer: DisplayFilePointer
): DisplayItemResult {
  return {
    index: entry.index,
    status,
    message_id: messageId,
    sha256: entry.sha256,
    mime_type: entry.mimeType,
    kind: entry.kind,
    file_pointer: pointer,
  };
}

async function postInline(
  ctx: ToolContext,
  entry: PreparedItem,
  caption: string
): Promise<DisplayItemResult> {
  const messageId = deterministicMessageId(ctx.agent.id, `display:${entry.sha256}`);
  const existing = await repo.findMessage(messageId);
  if (existing) {
    const pointer = (existing.filePointer as DisplayFilePointer | null) ?? entry.filePointer;
    return itemResult(entry, 'duplicate', existing.id, pointer);
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
        media_kind: entry.kind,
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
    kind: entry.kind,
    mime_type: entry.mimeType,
    size_bytes: entry.sizeBytes,
    file_count: entry.filePointer.bundle?.file_count ?? 1,
    via: ctx.requesting.kind,
  });
  const pointer = (message.filePointer as DisplayFilePointer | null) ?? entry.filePointer;
  return itemResult(entry, message.id === messageId ? 'posted' : 'duplicate', message.id, pointer);
}

export async function displayMedia(
  ctx: ToolContext,
  body: DisplayRequestBody
): Promise<DisplayResult> {
  const resolved = await resolveAll(ctx.agent, body.items);
  const prepared = prepareAll(ctx.agent, body.items, resolved);
  await storeAll(prepared);
  const caption = body.caption?.trim() ?? '';

  if (body.placement === 'pinned') {
    const question = await openQuestion(ctx, {
      question: caption,
      options: body.options ?? [],
      allowOther: body.allow_other !== false,
      media: prepared.map((entry) => entry.filePointer),
      requestKey: body.request_key,
      workflowId: body.workflow_id,
    });
    return {
      agent_id: ctx.agent.id,
      placement: 'pinned',
      posted_count: 0,
      duplicate_count: 0,
      items: prepared.map((entry) =>
        itemResult(entry, 'attached', question.message_id, entry.filePointer)
      ),
      question,
    };
  }

  const results: DisplayItemResult[] = [];
  const seen = new Map<string, DisplayItemResult>();
  let captionPending = caption;
  // Sequential: keeps trajectory order equal to argument order.
  for (const entry of prepared) {
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
