#!/usr/bin/env node
// rose — Rose agent tools for code agents (CLI + MCP stdio server).
// Installed by Rose at ~/.rose/bin/rose in every code session; do not edit.
//
//   rose display <file|folder|url>... [--caption T] [--pinned --option "Label | description"... --recommended N --allow-other]
//   rose message <text> [--inline-view NAME] [--props JSON]
//   rose approve <question>
//   rose wait <request-id>
//   rose mcp                      (stdio MCP server: display, send_message_to_user, request_user_approval)
//
// Every call goes to $ROSE_TOOLS_URL with $ROSE_TOOLS_TOKEN (or ~/.rose/tools.json),
// a token scoped to this session's agent. Pinned questions and approvals block
// until answered: the wait is a loop of bounded long-polls with no overall
// deadline; each poll is the liveness heartbeat. Re-running the same blocking
// command after an interruption resumes the same request instead of asking twice.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '1';
const MAX_ITEMS = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Mirrors back-end/src/providers/agentTools/displayBundle.ts.
const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const WAIT_SECONDS = Number(process.env.ROSE_TOOLS_WAIT_SECONDS || 25);
const SEND_ATTEMPTS = 6;

class ToolError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function config() {
  let url = process.env.ROSE_TOOLS_URL || '';
  let token = process.env.ROSE_TOOLS_TOKEN || '';
  if (!url || !token) {
    const file = process.env.ROSE_TOOLS_CONFIG || join(homedir(), '.rose', 'tools.json');
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      url = url || saved.url || '';
      token = token || saved.token || '';
    } catch {
      // fall through to the error below
    }
  }
  if (!url || !token) {
    throw new ToolError(
      'Rose tools are not configured in this session (ROSE_TOOLS_URL / ROSE_TOOLS_TOKEN missing).'
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * One HTTP call. Network errors, 429 and 5xx retry with backoff: `forever`
 * for waits (no deadline), SEND_ATTEMPTS otherwise. Every POST is idempotent
 * server-side, so a retried send never posts twice.
 */
async function call(method, path, body, { forever = false } = {}) {
  const { url, token } = config();
  let delay = 1000;
  for (let attempt = 1; ; attempt += 1) {
    let status = 0;
    let data = {};
    try {
      const res = await fetch(url + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      status = res.status;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text.slice(0, 500) };
      }
    } catch (err) {
      data = { error: `could not reach Rose: ${err?.cause?.message || err.message}` };
    }
    if (status >= 200 && status < 300) return data;
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || (!forever && attempt >= SEND_ATTEMPTS)) {
      const details = Array.isArray(data.details) ? `\n  - ${data.details.join('\n  - ')}` : '';
      throw new ToolError(
        `${data.error || `HTTP ${status}`}${status ? ` (HTTP ${status})` : ''}${details}`
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 15_000);
  }
}

// ── bundles: a folder, or an .html/.gltf/.obj plus the files it references ──
// The reference walk mirrors collectDisplayBundleFiles in
// back-end/src/providers/agentTools/displayBundle.ts.

const extOf = (path) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const BUNDLE_ROOT_EXT = new Set(['html', 'htm', 'gltf', 'obj']);
const SCANNABLE_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'gltf', 'obj', 'mtl']);
const MODEL_EXT = new Set(['glb', 'gltf', 'obj', 'stl', 'usdz']);
const ATTR_RE = /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const JS_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bfetch\s*\(\s*|\bnew\s+URL\s*\(\s*|\bnew\s+(?:Shared)?Worker\s*\(\s*)(?:"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`)/g;

function matches(re, text) {
  const out = [];
  for (const m of text.matchAll(re)) {
    const value = m.slice(1).find((group) => group !== undefined);
    if (value) out.push(value);
  }
  return out;
}

function rawRefs(path, bytes) {
  const kind = extOf(path);
  const text = bytes.toString('utf8');
  if (kind === 'gltf') {
    try {
      const json = JSON.parse(text);
      return [...(json.buffers || []), ...(json.images || [])]
        .map((entry) => entry && entry.uri)
        .filter((uri) => typeof uri === 'string');
    } catch {
      return [];
    }
  }
  if (kind === 'obj') return matches(/^\s*mtllib\s+(.+?)\s*$/gm, text);
  if (kind === 'mtl') {
    return matches(/^\s*(?:map_\w+|bump|disp|decal|refl)\s+(?:-\S+\s+\S+\s+)*(\S+)\s*$/gm, text);
  }
  if (kind === 'css') return [...matches(CSS_URL_RE, text), ...matches(CSS_IMPORT_RE, text)];
  if (kind === 'js' || kind === 'mjs') return matches(JS_RE, text);
  const srcset = matches(SRCSET_RE, text).flatMap((value) =>
    value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] || '')
  );
  return [
    ...matches(ATTR_RE, text),
    ...srcset,
    ...matches(CSS_URL_RE, text),
    ...matches(CSS_IMPORT_RE, text),
    ...matches(JS_RE, text),
  ];
}

/** Bundle-relative paths a file references (no schemes, root-absolute or escaping refs). */
function relativeRefs(path, bytes) {
  const dir = posix.dirname(path);
  const out = new Set();
  for (const raw of rawRefs(path, bytes)) {
    const value = raw.trim().replace(/[?#].*$/, '');
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      continue;
    }
    // Bare module specifiers ("three") are import-map names, not files.
    const pathLike = /^\.\.?\//.test(decoded) || decoded.includes('/') || /\.\w+$/.test(decoded);
    if (!pathLike) continue;
    const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, decoded));
    if (joined.startsWith('..') || joined === '.' || joined === '') continue;
    out.add(joined);
  }
  out.delete(path);
  return [...out];
}

function bundleCaps(label, count, total) {
  if (count > MAX_BUNDLE_FILES) {
    throw new ToolError(`${label}: more than ${MAX_BUNDLE_FILES} files (display a smaller folder)`);
  }
  if (total > MAX_BUNDLE_BYTES) throw new ToolError(`${label}: larger than 50 MB in total`);
}

function readCapped(abs, ref) {
  if (statSync(abs).size > MAX_FILE_BYTES) throw new ToolError(`${ref}: larger than 20 MB`);
  return readFileSync(abs);
}

/** The entry file plus every file under its folder it references, transitively. */
function referencedFiles(abs, ref) {
  const root = dirname(abs);
  const entry = basename(abs);
  const files = new Map([[entry, readCapped(abs, ref)]]);
  const tried = new Set([entry]);
  const queue = [entry];
  let total = files.get(entry).length;
  while (queue.length > 0) {
    const path = queue.shift();
    if (!SCANNABLE_EXT.has(extOf(path))) continue;
    for (const child of relativeRefs(path, files.get(path))) {
      if (tried.has(child)) continue;
      tried.add(child);
      if (child.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) continue;
      const full = join(root, ...child.split('/'));
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue; // built at runtime, or not part of the page
      }
      if (!stat.isFile()) continue;
      const bytes = readCapped(full, child);
      files.set(child, bytes);
      total += bytes.length;
      bundleCaps(ref, files.size, total);
      queue.push(child);
    }
  }
  return { entry, files };
}

/** Every file in a folder (dot-files and node_modules skipped), capped. */
function folderFiles(abs, ref) {
  const files = new Map();
  let total = 0;
  const walk = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const item of entries) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full, childRel);
      else if (item.isFile()) {
        const bytes = readCapped(full, `${ref}/${childRel}`);
        files.set(childRel, bytes);
        total += bytes.length;
        bundleCaps(ref, files.size, total);
      }
    }
  };
  walk(abs, '');
  const top = [...files.keys()].filter((path) => !path.includes('/'));
  const pick = (test) => top.filter((path) => test(extOf(path)));
  const pages = pick((ext) => ext === 'html' || ext === 'htm');
  const models = pick((ext) => MODEL_EXT.has(ext));
  const pdfs = pick((ext) => ext === 'pdf');
  const entry = files.has('index.html')
    ? 'index.html'
    : [pages, models, pdfs].find((list) => list.length === 1)?.[0];
  if (!entry) {
    throw new ToolError(
      `${ref}: a folder needs an index.html, or exactly one top-level .html page, 3D model or .pdf`
    );
  }
  return { entry, files };
}

function bundleItem(entry, files) {
  const listing = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    body: {
      bundle: {
        entry,
        files: listing.map(([path, bytes]) => ({ path, content_base64: bytes.toString('base64') })),
      },
    },
    key: sha256(JSON.stringify([entry, listing.map(([path, bytes]) => [path, sha256(bytes)])])),
  };
}

function fileItem(ref) {
  const abs = resolve(ref);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new ToolError(`${ref}: no such file`);
  }
  if (stat.isDirectory()) {
    const { entry, files } = folderFiles(abs, ref);
    return bundleItem(entry, files);
  }
  if (!stat.isFile()) throw new ToolError(`${ref}: not a regular file`);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError(`${ref}: larger than 20 MB`);
  if (BUNDLE_ROOT_EXT.has(extOf(abs))) {
    const { entry, files } = referencedFiles(abs, ref);
    if (files.size > 1) return bundleItem(entry, files);
  }
  const bytes = readFileSync(abs);
  return {
    body: { content_base64: bytes.toString('base64'), filename: basename(abs) },
    key: sha256(bytes),
  };
}

function buildItems(paths = [], urls = []) {
  const items = [
    ...paths.map((ref) => fileItem(ref)),
    ...urls.map((ref) => ({ body: { url: ref }, key: `url:${ref}` })),
  ];
  if (items.length > MAX_ITEMS)
    throw new ToolError(`at most ${MAX_ITEMS} items per call (got ${items.length})`);
  return items;
}

function normalizeOptions(options) {
  if (options === undefined || options === null) return [];
  if (!Array.isArray(options))
    throw new ToolError('options must be a list of {label, description, recommended}');
  return options.map((option, index) => {
    if (!option || typeof option.label !== 'string' || !option.label.trim()) {
      throw new ToolError(`option ${index + 1} needs a label`);
    }
    return {
      label: option.label.trim(),
      ...(typeof option.description === 'string' && option.description.trim()
        ? { description: option.description.trim() }
        : {}),
      ...(option.recommended === true ? { recommended: true } : {}),
    };
  });
}

/** Blocks until the request is answered. `onBeat` runs after every pending poll. */
async function waitFor(requestId, onBeat) {
  for (let beat = 1; ; beat += 1) {
    const state = await call(
      'GET',
      `/requests/${encodeURIComponent(requestId)}?wait=${WAIT_SECONDS}`,
      undefined,
      {
        forever: true,
      }
    );
    if (state.status !== 'pending') return state;
    if (onBeat) onBeat(beat, state);
  }
}

function describeAnswer(state) {
  if (state.kind === 'approval') {
    const reply = (state.user_message || state.response || '').trim();
    if (state.status === 'rejected')
      return {
        text: `The user rejected the request.${reply ? ` Their reply: ${reply}` : ''}`,
        rejected: true,
      };
    return {
      text: `The user approved.${reply && reply.toLowerCase() !== 'approved' ? ` Their reply: ${reply}` : ''}`,
      rejected: false,
    };
  }
  const answeredBy =
    state.answered_by === 'parent' ? 'Your parent agent answered' : 'The user answered';
  if (state.status === 'rejected')
    return { text: `${answeredBy}: dismissed without choosing an option.`, rejected: true };
  const picked = state.selected_option;
  if (picked && typeof picked.label === 'string') {
    return {
      text: `${answeredBy} with option ${picked.index + 1}: ${picked.label}`,
      rejected: false,
    };
  }
  return { text: `${answeredBy}: ${(state.response || '').trim()}`, rejected: false };
}

// ── tools (shared by CLI and MCP) ──

async function displayTool(args, onBeat) {
  const placement = args.placement === 'pinned' ? 'pinned' : 'inline';
  const items = buildItems(args.paths, args.urls);
  const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
  const options = normalizeOptions(args.options);
  if (placement === 'inline' && items.length === 0)
    throw new ToolError('display needs at least one path or url');
  if (placement === 'pinned' && !caption)
    throw new ToolError('a pinned question needs a caption (the question text)');
  const body = {
    items: items.map((item) => item.body),
    ...(caption ? { caption } : {}),
    placement,
    ...(placement === 'pinned'
      ? {
          options,
          allow_other: args.allow_other !== false,
          request_key: sha256(
            JSON.stringify([
              'display',
              caption,
              options,
              args.allow_other !== false,
              items.map((i) => i.key),
            ])
          ),
        }
      : {}),
  };
  const describe = (result) =>
    (result.items || []).map((item) => {
      const pointer = item.file_pointer || {};
      const files = pointer.bundle ? ` (${pointer.bundle.file_count} files)` : '';
      const at = pointer.usercontent_url ? ` at ${pointer.usercontent_url}` : '';
      const framed = item.kind && item.kind !== 'image' && item.kind !== 'video';
      const shown = item.status === 'duplicate' ? 'already displayed' : 'displayed';
      return `${shown} ${item.mime_type}${framed ? ` as ${item.kind}${files}${at}` : ''} (message ${item.message_id})`;
    });
  if (placement === 'inline') {
    // One request per item keeps each body far below the JSON body limit;
    // the server dedupes by content hash, so a retry never posts twice.
    const shown = [];
    for (let i = 0; i < items.length; i += 1) {
      const result = await call('POST', '/display', {
        items: [items[i].body],
        ...(i === 0 && caption ? { caption } : {}),
        placement,
      });
      shown.push(...describe(result));
    }
    return { text: shown.join('\n'), rejected: false };
  }
  const result = await call('POST', '/display', body);
  const question = result.question || {};
  if (question.deliver_to === 'agent') {
    // Not root-spawned: the spawning agent answers (or escalates) through the
    // agent graph; its reply arrives as this session's next message.
    const sent = await askSpawningAgent({
      caption,
      options,
      allowOther: args.allow_other !== false,
      key: body.request_key,
    });
    return {
      text: `Asked agent ${question.agent_id} (the agent that started you). Its answer will arrive as your next message (${sent.status || 'sent'}).`,
      rejected: false,
    };
  }
  process.stderr.write(`rose: waiting for the user to answer (request ${question.request_id})\n`);
  return describeAnswer(await waitFor(question.request_id, onBeat));
}

// ── agent graph (L-A2A): questions for a non-root spawner ──

const AGENTS_TOKEN_FILE = join(homedir(), '.rose', 'agents-token');
const AGENTS_REFRESH_WINDOW_S = 30 * 60;

function agentsConfig() {
  let saved = {};
  try {
    saved = JSON.parse(
      readFileSync(process.env.ROSE_TOOLS_CONFIG || join(homedir(), '.rose', 'tools.json'), 'utf8')
    );
  } catch {
    // env only
  }
  let token = '';
  try {
    token = readFileSync(AGENTS_TOKEN_FILE, 'utf8').trim();
  } catch {
    // no refreshed token yet
  }
  token = token || process.env.ROSE_AGENTS_TOKEN || saved.agents_token || '';
  const url = (process.env.ROSE_AGENTS_URL || saved.agents_url || '').replace(/\/+$/, '');
  if (!url || !token) {
    throw new ToolError(
      'This question goes to the agent that started you, but the agent graph (ROSE_AGENTS_URL / ROSE_AGENTS_TOKEN) is not configured in this session.'
    );
  }
  return { url, token };
}

async function agentsCall(method, route, body, token) {
  const { url } = agentsConfig();
  let res;
  try {
    res = await fetch(url + route, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: { error: `could not reach Rose: ${err?.cause?.message || err.message}` },
    };
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data };
}

/** Same refresh contract as rose-agents: renew near expiry into ~/.rose/agents-token (0600). */
async function freshAgentsToken() {
  const { token } = agentsConfig();
  let exp = 0;
  try {
    exp =
      Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp) || 0;
  } catch {
    return token;
  }
  if (exp - Date.now() / 1000 > AGENTS_REFRESH_WINDOW_S) return token;
  const refreshed = await agentsCall('POST', '/token', undefined, token);
  const next = refreshed.ok ? refreshed.data.token : null;
  if (typeof next !== 'string' || !next) return token;
  mkdirSync(join(homedir(), '.rose'), { recursive: true });
  writeFileSync(AGENTS_TOKEN_FILE, `${next}\n`, { mode: 0o600 });
  return next;
}

async function askSpawningAgent({ caption, options, allowOther, key }) {
  const token = await freshAgentsToken();
  const body = {
    question: caption,
    options,
    allow_other: allowOther,
    // Stable per question, so a re-run never asks twice.
    message_id: `q-${key.slice(0, 48)}`,
  };
  for (let attempt = 1; ; attempt += 1) {
    const res = await agentsCall('POST', '/questions', body, token);
    if (res.ok) return res.data;
    if ((res.status !== 0 && res.status < 500 && res.status !== 429) || attempt >= SEND_ATTEMPTS) {
      throw new ToolError(
        `could not ask the spawning agent: ${res.data.error || `HTTP ${res.status}`}`
      );
    }
    await sleep(Math.min(1000 * 2 ** attempt, 15_000));
  }
}

async function messageTool(args) {
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) throw new ToolError('message must be non-empty');
  const result = await call('POST', '/messages', {
    message,
    ...(args.inline_view ? { inline_view: args.inline_view } : {}),
    idempotency_key: randomUUID(),
  });
  return { text: `sent (message ${result.message_id})`, rejected: false };
}

async function approvalTool(args, onBeat) {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) throw new ToolError('question must be non-empty');
  const created = await call('POST', '/approvals', {
    question,
    request_key: sha256(JSON.stringify(['approval', question])),
  });
  process.stderr.write(`rose: waiting for the user to approve (request ${created.request_id})\n`);
  const state = await waitFor(created.request_id, onBeat);
  return describeAnswer(state);
}

// ── MCP stdio server ──

const MCP_TOOLS = [
  {
    name: 'display',
    description:
      'Show the user images, videos, web pages, whole sites, 3D models or PDFs inline in Rose, or ask a question with numbered options (placement "pinned"): pinned above the user\'s query box when the root agent started you (blocks and returns the answer), otherwise sent to the agent that started you (its answer arrives as your next message). Pages run any CSS and JS (CDN scripts and modules, WebGL/WebGPU, WebAssembly, fetch) in a sandboxed frame.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Local files or folders: images, videos, an .html page (the files it references come along), a site folder (index.html), a 3D model (.glb .gltf .obj .stl .usdz) or a .pdf.',
        },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Public http(s) URLs (image, video, page, model or PDF), fetched by Rose.',
        },
        caption: { type: 'string', description: 'Caption; for placement "pinned", the question.' },
        placement: { type: 'string', enum: ['inline', 'pinned'] },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string', description: 'One line.' },
              recommended: { type: 'boolean' },
            },
            required: ['label'],
          },
        },
        allow_other: {
          type: 'boolean',
          description: 'Offer a free-text "Other…" answer (default true).',
        },
      },
    },
  },
  {
    name: 'send_message_to_user',
    description:
      'Send the user a message in Rose: progress, results, scorecards. inline_view renders a published rose_user_ui inline view with props.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        inline_view: {
          type: 'object',
          properties: { view: { type: 'string' }, props: { type: 'object' } },
          required: ['view'],
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'request_user_approval',
    description:
      "Ask the user to approve an action through Rose's approval prompt. Blocks until the user answers and returns approved or rejected with their reply.",
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'What you want to do and why.' } },
      required: ['question'],
    },
  },
];

const MCP_HANDLERS = {
  display: displayTool,
  send_message_to_user: messageTool,
  request_user_approval: approvalTool,
};

function serveMcp() {
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const reply = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function handle(message) {
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rose', version: VERSION },
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: MCP_TOOLS });
    if (method === 'tools/call') {
      const handler = MCP_HANDLERS[params.name];
      if (!handler) return fail(id, -32602, `unknown tool ${params.name}`);
      const progressToken = params._meta?.progressToken;
      const onBeat =
        progressToken === undefined
          ? undefined
          : (beat) =>
              send({
                method: 'notifications/progress',
                params: { progressToken, progress: beat, message: 'Waiting for an answer' },
              });
      try {
        const result = await handler(params.arguments || {}, onBeat);
        return reply(id, { content: [{ type: 'text', text: result.text }], isError: false });
      } catch (err) {
        const text = err instanceof ToolError ? err.message : `rose tool failed: ${err.message}`;
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    if (id !== undefined && !String(method || '').startsWith('notifications/')) {
      return fail(id, -32601, `method not found: ${method}`);
    }
    return undefined;
  }

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return fail(null, -32700, 'parse error');
    }
    handle(message).catch((err) => process.stderr.write(`rose mcp: ${err.message}\n`));
  });
}

// ── CLI ──

const USAGE = `usage:
  rose display <file|folder|url>... [--caption TEXT]
      images, videos, .html pages (+ the files they reference), site folders,
      3D models (.glb .gltf .obj .stl .usdz) and PDFs
  rose display [<file|url>...] --pinned --caption QUESTION --option "Label | one-line description"... [--recommended N] [--no-other]
  rose message <text> [--inline-view NAME] [--props JSON]
  rose approve <question>
  rose wait <request-id>
  rose mcp`;

function parseFlags(argv, valueFlags) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (!valueFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new ToolError(`--${name} needs a value`);
    (flags[name] ||= []).push(value);
  }
  return { positional, flags };
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }
  if (command === '--version') {
    console.log(VERSION);
    return 0;
  }
  if (command === 'mcp') {
    serveMcp();
    return null;
  }
  let result;
  if (command === 'display') {
    const { positional, flags } = parseFlags(rest, new Set(['caption', 'option', 'recommended']));
    const recommended = Number((flags.recommended || [])[0] || 0);
    const options = (flags.option || []).map((raw, index) => {
      const [label, ...description] = raw.split(' | ');
      return {
        label,
        description: description.join(' | '),
        recommended: index + 1 === recommended,
      };
    });
    result = await displayTool({
      paths: positional.filter((ref) => !/^https?:\/\//i.test(ref)),
      urls: positional.filter((ref) => /^https?:\/\//i.test(ref)),
      caption: (flags.caption || [])[0],
      placement: flags.pinned ? 'pinned' : 'inline',
      options,
      allow_other: !flags['no-other'],
    });
  } else if (command === 'message') {
    const { positional, flags } = parseFlags(rest, new Set(['inline-view', 'props']));
    let props;
    if (flags.props) {
      try {
        props = JSON.parse(flags.props[0]);
      } catch {
        throw new ToolError('--props must be JSON');
      }
    }
    result = await messageTool({
      message: positional.join(' '),
      ...(flags['inline-view']
        ? { inline_view: { view: flags['inline-view'][0], ...(props ? { props } : {}) } }
        : {}),
    });
  } else if (command === 'approve') {
    result = await approvalTool({ question: rest.join(' ') });
  } else if (command === 'wait') {
    if (!rest[0]) throw new ToolError('rose wait needs a request id');
    result = describeAnswer(await waitFor(rest[0]));
  } else {
    throw new ToolError(`unknown command ${command}\n${USAGE}`);
  }
  console.log(result.text);
  return result.rejected ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (err) => {
    console.error(`rose: ${err instanceof ToolError ? err.message : err.stack || err.message}`);
    process.exitCode = 1;
  }
);
