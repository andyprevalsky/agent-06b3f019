/**
 * `display`: publish images, videos, web pages, multi-file sites, 3D models and
 * PDFs and post them inline in the caller's trajectory. Pinned questions are
 * refused: agents cannot ask the user questions through display.
 *
 *   items (url | file | content_base64 | bundle), caption, placement, options
 *     │ resolve bytes  (url: bounded SSRF-guarded fetch; file: tree pointer or
 *     │                 owner storage path, plus the tree files an .html/.gltf/
 *     │                 .obj/.js references; base64: decode; bundle: decode files)
 *     │ classify       (magic bytes → image/* video/* pdf glb; declared + checked
 *     │                 → text/html, .js/.mjs, .gltf/.obj/.stl/.usdz) ── all-or-nothing
 *     │ caps           (≤ 20 items, ≤ 20 MB per file, ≤ 100 MB per call;
 *     │                 bundles ≤ 500 files and ≤ 50 MB)
 *     ▼ kind
 *     image / video ─► <owner>/display/<sha256>.<ext>            (write-once)
 *     page (.html)  ─► <owner>/display/<sha256>.html             → usercontent page URL
 *     bundle        ─► blobs + manifest (providers/agentTools/displayBundle.ts)
 *     model / pdf   ─► bundle of the file + a generated viewer   → usercontent bundle URL
 *     script (.js)  ─► bundle of the script (+ the files it imports) + a generated
 *                      page running it as a module (three.js import map), kind "bundle"
 *
 *   inline ─► ASSISTANT message per unique item,
 *             id = deterministicMessageId(agentId, "display:<sha256 | bundle hash>")
 *             exists ─► duplicate (no post)                       (P2002-safe)
 *   pinned ─► 400 (agents cannot ask the user questions through display)
 *
 * Framed kinds carry `file_pointer.usercontent_url` + `kind`; the FE frames
 * them with DISPLAY_IFRAME_SANDBOX (providers/agentTools/displayCsp.ts).
 */
import { createHash } from '../../providers/crypto';
import {
  DISPLAY_BUNDLE_MAX_FILES,
  DISPLAY_MODEL_EXTENSIONS,
  DISPLAY_SCRIPT_EXTENSIONS,
  buildDisplayBundle,
  displayBlobKey,
  displayRelativeRefs,
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
  putDisplayObject,
} from '../../providers/agentTools/media';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { DISPLAY_MAX_FILE_BYTES, DISPLAY_MAX_TOTAL_BYTES } from './config';
import type * as repo from './repo';
import { AgentToolsError, type ToolContext } from './service';
import type {
  DisplayItemInput,
  DisplayItemResult,
  DisplayKind,
  DisplayRequestBody,
  DisplayResult,
} from './types';
import type { PreparedItem, ResolvedItem } from './displayTypes';
import { itemLabel, resolveAll } from './displayResolution';
import { postInline } from './displayPosting';
const TYPES_HELP =
  'allowed: image/* (including .svg), video/*, an .html page, a .js/.mjs script, a 3D model (.glb .gltf .obj .stl .usdz), a .pdf, or a site folder';
const extOf = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

/** `<base href>` so a fetched page's relative links still load from its own site. */
function withBaseHref(html: Buffer, url: string): Buffer {
  const text = html.toString('utf8');
  if (/<base\b/i.test(text)) return html;
  const tag = `<base href="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  const anchor =
    /<head\b[^>]*>/i.exec(text) ?? /<html\b[^>]*>/i.exec(text) ?? /<!doctype[^>]*>/i.exec(text);
  if (!anchor) return Buffer.from(tag + text);
  const at = anchor.index + anchor[0].length;
  return Buffer.from(text.slice(0, at) + tag + text.slice(at));
}

/** The model / PDF / script file name the viewer loads, with the extension of its real type. */
function viewerSourceName(filename: string, mimeType: string): string {
  const ext = DISPLAY_EXTENSIONS[mimeType] ?? 'bin';
  if (extOf(filename) === ext) return filename;
  if (mimeType === 'text/javascript' && DISPLAY_SCRIPT_EXTENSIONS.has(extOf(filename))) {
    return filename;
  }
  return `${filename.replace(/\.[^.]*$/, '') || 'model'}.${ext}`;
}

function bundleKindForEntry(entry: string, bytes: Buffer): DisplayBundleKind {
  const type = classifyDisplayMedia(bytes, { filename: entry });
  if (type === 'text/html') return 'bundle';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/javascript' && DISPLAY_SCRIPT_EXTENSIONS.has(extOf(entry))) return 'script';
  if (type !== null && type.startsWith('model/') && DISPLAY_MODEL_EXTENSIONS.has(extOf(entry)))
    return 'model';
  throw new DisplayFetchError(
    `entry ${entry.slice(0, 200)} must be an .html page, a .js/.mjs script, a 3D model (.glb .gltf .obj .stl .usdz) or a .pdf`
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
  // A script runs in its generated page: the UI frames it like any bundle.
  const displayKind: DisplayKind = kind === 'script' ? 'bundle' : kind;
  return {
    index,
    sha256: built.hash,
    mimeType: sourceType,
    kind: displayKind,
    sizeBytes: built.totalBytes,
    filePointer: {
      ...pointerBase(agent, built.hash),
      // The displayed file itself (a name lookup in the tree finds real bytes).
      storage_path: displayBlobKey(agent.userId, built.manifest.files[source].sha256),
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

export function prepareSingle(
  agent: repo.ToolAgent,
  entry: Extract<ResolvedItem, { type: 'single' }>
): PreparedItem {
  const mimeType = classifyDisplayMedia(entry.bytes, {
    filename: entry.filename,
    contentType: entry.contentType,
  });
  if (mimeType === null) throw new DisplayFetchError(`is not a displayable file (${TYPES_HELP})`);
  if (mimeType === 'text/javascript') {
    const source = viewerSourceName(entry.filename, mimeType);
    // A fetched script is shown alone: its relative imports would 404 inside the bundle.
    const relative = entry.sourceUrl === undefined ? [] : displayRelativeRefs(source, entry.bytes);
    if (relative.length > 0) {
      throw new DisplayFetchError(
        `imports relative modules (${relative.slice(0, 3).join(', ')}); a URL script is shown alone, so display it from a file path or a bundle that includes them`
      );
    }
    return prepareBundle(agent, entry.index, source, new Map([[source, entry.bytes]]), 'script');
  }
  const kind = displayKindForType(mimeType);
  if (kind === 'model' || kind === 'pdf') {
    const source = viewerSourceName(entry.filename, mimeType);
    return prepareBundle(agent, entry.index, source, new Map([[source, entry.bytes]]), kind);
  }
  const bytes =
    kind === 'page' && entry.sourceUrl !== undefined
      ? withBaseHref(entry.bytes, entry.sourceUrl)
      : entry.bytes;
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

export async function displayMedia(
  ctx: ToolContext,
  body: DisplayRequestBody
): Promise<DisplayResult> {
  const resolved = await resolveAll(ctx.agent, body.items);
  const prepared = prepareAll(ctx.agent, body.items, resolved);
  await storeAll(prepared);
  const caption = body.caption?.trim() ?? '';

  if (body.placement === 'pinned') {
    // Agents cannot ask the user questions through display; it only shows media.
    throw new AgentToolsError(
      400,
      'display cannot ask questions: placement "pinned" is disabled, use placement "inline"'
    );
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
