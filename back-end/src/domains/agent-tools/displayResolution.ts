/** Resolve display inputs from URLs, sandbox bundles, and owned tree files. */
import {
  collectDisplayBundleFiles,
  readDisplayBundleSources,
} from '../../providers/agentTools/displayBundle';
import {
  DisplayFetchError,
  fetchDisplayMedia,
  getDisplayObject,
} from '../../providers/agentTools/media';
import {
  DISPLAY_FETCH_CONCURRENCY,
  DISPLAY_MAX_FILE_BYTES,
  DISPLAY_URL_TIMEOUT_MS,
} from './config';
import { AgentToolsError } from './service';
import * as repo from './repo';
import type { DisplayItemInput } from './types';
import type { ResolvedItem } from './displayTypes';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function itemLabel(item: DisplayItemInput, index: number): string {
  const name = item.url ?? item.file ?? item.bundle?.entry ?? item.filename ?? `item ${index + 1}`;
  return `#${index + 1} ${name.slice(0, 200)}`;
}

function basename(value: string): string {
  const stripped = value.split(/[?#]/)[0] ?? value;
  const last = stripped.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'media';
}

const isBundleRoot = (name: string) => /\.(html?|gltf|obj|m?js)$/i.test(name);

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
  return bytes
    ? { bytes, mime: typeof pointer?.mime_type === 'string' ? pointer.mime_type : '' }
    : null;
}

async function resolveFile(
  agent: repo.ToolAgent,
  file: string,
  lookup: ReturnType<typeof repo.treeFilePointerResolver>
): Promise<{ bytes: Buffer; mime: string; pointer: Record<string, unknown> | null }> {
  // An exact storage path is accepted only inside the owner's prefix.
  if (file.startsWith(`${agent.userId}/`) && !file.includes('..')) {
    const bytes = await getDisplayObject(file);
    if (bytes) return { bytes, mime: '', pointer: null };
  }
  const pointer = await lookup(file);
  if (pointer === null || typeof pointer.storage_path !== 'string') {
    throw new DisplayFetchError(`no file named ${file.slice(0, 200)} in this agent's files`);
  }
  const found = await pointerBytes(agent, pointer);
  if (!found) throw new DisplayFetchError(`${file.slice(0, 200)} is no longer in storage`);
  return { ...found, pointer };
}

/** A tree pointer posted by an earlier display of a bundle: its exact files. */
async function earlierBundle(agent: repo.ToolAgent, pointer: Record<string, unknown> | null) {
  const bundle = pointer?.bundle as { hash?: unknown } | undefined;
  if (typeof bundle?.hash !== 'string') return null;
  return readDisplayBundleSources(agent.userId, bundle.hash);
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
  const { bytes, mime, pointer } = await resolveFile(agent, file, lookup);
  const earlier = await earlierBundle(agent, pointer);
  if (earlier) return { index, type: 'bundle', entry: earlier.source, files: earlier.files };
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
export async function resolveAll(
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
