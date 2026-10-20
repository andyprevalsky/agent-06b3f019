/**
 * rose_user_ui bundle contract: the `rose-ui.json` manifest, `theme.json`, and
 * the whole-bundle validation shared by the publish API, the code-agent
 * workspace seed, and the `rose-ui` CLI. Approved in
 * docs/plans/active/rose-user-ui.md (manifest Zod schema, CLAUDE.md rule 5);
 * any change to these schemas needs fresh approval.
 *
 *   rose_user_ui/ (code agent)          validateUserUiBundle(files)
 *     rose-ui.json ──────────────────►  manifest schema + every referenced
 *     root/theme.json                   path exists + theme schema + caps
 *     inline/<view>/…                         │
 *                                             ▼ ok → UserUiVersion + storage
 */
import { z } from 'zod';

export const USER_UI_MANIFEST_PATH = 'rose-ui.json';
export const USER_UI_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const USER_UI_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const USER_UI_MAX_FILES = 2000;
export const USER_UI_MAX_PATH_LENGTH = 512;

export const USER_UI_SLOT_NAMES = [
  'background',
  'sidebar.header',
  'menu',
  'home.dashboard',
  'agent.panel',
] as const;
export const USER_UI_CAPABILITIES = [
  'read',
  'subscribe',
  'navigate',
  'create_agent',
  'send_message',
] as const;

export const USER_UI_VIEW_NAME_RE = /^[a-z0-9-]+$/;
const TOOL_NAME_RE = /^[a-z0-9_]+$/;
const CSS_CUSTOM_PROPERTY_RE = /^--[A-Za-z0-9_-]{1,64}$/;

/**
 * A bundle-relative path: `a/b.html`. Rejects absolute paths, backslashes,
 * `..`/`.`/empty segments, dot-segments (reserved for Rose metadata, skipped by
 * the CLI), drive letters, and control characters.
 */
export function isSafeUserUiPath(value: string): boolean {
  if (value.length === 0 || value.length > USER_UI_MAX_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return value.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.'));
}

const relativePath = z
  .string()
  .refine(isSafeUserUiPath, { message: 'must be a relative path without ".." or dot-segments' });

const entrySchema = z.object({ entry: relativePath }).strict();

export const userUiManifestSchema = z
  .object({
    version: z.literal(1),
    theme: relativePath.optional(),
    shell: entrySchema.optional(),
    slots: z.record(z.enum(USER_UI_SLOT_NAMES), entrySchema).optional(),
    inline: z
      .record(
        z.string().max(64).regex(USER_UI_VIEW_NAME_RE, 'view names must match [a-z0-9-]+'),
        z
          .object({
            entry: relativePath,
            summary: z.string().max(2000).optional(),
            poster: relativePath.optional(),
          })
          .strict()
      )
      .optional(),
    tools: z
      .record(
        z.string().max(64).regex(TOOL_NAME_RE, 'tool names must match [a-z0-9_]+'),
        z.object({ manifest: relativePath }).strict()
      )
      .optional(),
    capabilities: z.array(z.enum(USER_UI_CAPABILITIES)).optional(),
  })
  .strict();

export type UserUiManifest = z.infer<typeof userUiManifestSchema>;

/** A CSS value only: no declarations, blocks, markup, imports or URL loads. */
function isSafeCssValue(value: string): boolean {
  if (value.length > 512) return false;
  if (/[;{}<>\\]/.test(value)) return false;
  return !/(url\s*\(|expression\s*\(|@import|javascript:)/i.test(value);
}

export const userUiThemeSchema = z
  .object({
    tokens: z
      .record(
        z.string().regex(CSS_CUSTOM_PROPERTY_RE, 'token names must be CSS custom properties'),
        z.string().refine(isSafeCssValue, { message: 'must be a plain CSS value' })
      )
      .optional(),
    background: z
      .object({
        image: relativePath.optional(),
        fadeAfterFirstMessage: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UserUiTheme = z.infer<typeof userUiThemeSchema>;

export interface UserUiBundleFile {
  path: string;
  content: Buffer;
}

export type UserUiBundleValidation =
  { ok: true; manifest: UserUiManifest; totalBytes: number } | { ok: false; errors: string[] };

function parseJsonFile(file: UserUiBundleFile | undefined, label: string, errors: string[]) {
  if (!file) {
    errors.push(`${label} is missing`);
    return undefined;
  }
  try {
    return JSON.parse(file.content.toString('utf8')) as unknown;
  } catch {
    errors.push(`${label} is not valid JSON`);
    return undefined;
  }
}

function zodErrors(label: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${label}: ${issue.path.join('.') || '(root)'} ${issue.message}`
  );
}

/** Every bundle path the manifest (and its theme) points at. */
export function referencedUserUiPaths(manifest: UserUiManifest): string[] {
  const refs: string[] = [];
  if (manifest.theme) refs.push(manifest.theme);
  if (manifest.shell) refs.push(manifest.shell.entry);
  for (const slot of Object.values(manifest.slots ?? {})) if (slot) refs.push(slot.entry);
  for (const view of Object.values(manifest.inline ?? {})) {
    refs.push(view.entry);
    if (view.poster) refs.push(view.poster);
  }
  for (const tool of Object.values(manifest.tools ?? {})) refs.push(tool.manifest);
  return refs;
}

/**
 * Validate a complete bundle before anything is stored: caps, safe unique
 * paths, the manifest schema, the theme schema, and that every referenced path
 * is part of the bundle.
 */
export function validateUserUiBundle(files: UserUiBundleFile[]): UserUiBundleValidation {
  const errors: string[] = [];
  if (files.length === 0) return { ok: false, errors: ['bundle has no files'] };
  if (files.length > USER_UI_MAX_FILES) {
    return { ok: false, errors: [`bundle has ${files.length} files (max ${USER_UI_MAX_FILES})`] };
  }

  const byPath = new Map<string, UserUiBundleFile>();
  let totalBytes = 0;
  for (const file of files) {
    if (!isSafeUserUiPath(file.path)) {
      errors.push(`invalid path "${file.path.slice(0, 200)}"`);
      continue;
    }
    if (byPath.has(file.path)) errors.push(`duplicate path "${file.path}"`);
    if (file.content.length > USER_UI_MAX_FILE_BYTES) {
      errors.push(`${file.path} is ${file.content.length} bytes (max ${USER_UI_MAX_FILE_BYTES})`);
    }
    totalBytes += file.content.length;
    byPath.set(file.path, file);
  }
  if (totalBytes > USER_UI_MAX_TOTAL_BYTES) {
    errors.push(`bundle is ${totalBytes} bytes (max ${USER_UI_MAX_TOTAL_BYTES})`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const rawManifest = parseJsonFile(
    byPath.get(USER_UI_MANIFEST_PATH),
    USER_UI_MANIFEST_PATH,
    errors
  );
  if (rawManifest === undefined) return { ok: false, errors };
  const parsed = userUiManifestSchema.safeParse(rawManifest);
  if (!parsed.success) return { ok: false, errors: zodErrors(USER_UI_MANIFEST_PATH, parsed.error) };
  const manifest = parsed.data;

  for (const ref of referencedUserUiPaths(manifest)) {
    if (!byPath.has(ref)) errors.push(`${USER_UI_MANIFEST_PATH} references missing file ${ref}`);
  }

  if (manifest.theme && byPath.has(manifest.theme)) {
    const rawTheme = parseJsonFile(byPath.get(manifest.theme), manifest.theme, errors);
    if (rawTheme !== undefined) {
      const theme = userUiThemeSchema.safeParse(rawTheme);
      if (!theme.success) errors.push(...zodErrors(manifest.theme, theme.error));
      else if (theme.data.background?.image && !byPath.has(theme.data.background.image)) {
        errors.push(`${manifest.theme} references missing file ${theme.data.background.image}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest, totalBytes };
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  glsl: 'text/plain; charset=utf-8',
  wgsl: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
};

export function userUiContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
