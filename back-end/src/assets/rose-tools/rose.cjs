#!/usr/bin/env node
// rose — Rose agent tools for code agents (CLI + MCP stdio server).
// Installed by Rose at ~/.rose/bin/rose in every code session; do not edit.
//
//   rose display <file|folder|url>... [--html PAGE] [--caption T]
//   rose message <text> [--inline-view NAME] [--props JSON]
//   rose env status [--json]      (size, memory/swap/load, OOM kills, top processes)
//   rose env size [--cpu N] [--memory-gb M] --reason TEXT
//   rose mcp                      (stdio MCP server: display, send_message_to_user,
//                                  change_environment_size)
//
// Code agents cannot ask the user (or their spawner) a question: there is no
// pinned question, approval or wait command, and nothing here blocks on an answer.
// Inline views (--inline-view) and sites/models/PDFs exist only in Rose Desktop
// sessions ($ROSE_TOOLS_ROSE_DESKTOP=1 or tools.json "rose_desktop": true);
// elsewhere the tool list, usage and request bodies are the stock ones.
//
// Every call goes to $ROSE_TOOLS_URL with $ROSE_TOOLS_TOKEN (or ~/.rose/tools.json),
// a token scoped to this session's agent.
//
// CommonJS: ~/.rose/bin is a {"type":"commonjs"} package scope, where an ES
// module silently exits 0 without running (back-end userUi/workspace.ts).
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { cpus, freemem, homedir, loadavg, totalmem } = require('node:os');
const { basename, dirname, join, posix, resolve } = require('node:path');
const { createInterface } = require('node:readline');

const VERSION = '1';
const MAX_ITEMS = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Mirrors back-end/src/providers/agentTools/displayBundle.ts.
const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const SEND_ATTEMPTS = 6;

class ToolError extends Error {}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function savedConfig() {
  const file = process.env.ROSE_TOOLS_CONFIG || join(homedir(), '.rose', 'tools.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Rose Desktop accounts (back-end utils/roseDesktop.ts) also get inline views.
 * Every other session sees and sends the stock tools only: inline media and
 * messages.
 */
function roseDesktop() {
  if (process.env.ROSE_TOOLS_ROSE_DESKTOP !== undefined)
    return process.env.ROSE_TOOLS_ROSE_DESKTOP === '1';
  return savedConfig().rose_desktop === true;
}

/** Drop the Rose Desktop-only arguments for a stock session (same as its schema). */
function stockArgs(args, keys) {
  if (roseDesktop()) return args;
  const kept = { ...args };
  for (const key of keys) delete kept[key];
  return kept;
}

function config() {
  let url = process.env.ROSE_TOOLS_URL || '';
  let token = process.env.ROSE_TOOLS_TOKEN || '';
  if (!url || !token) {
    const saved = savedConfig();
    url = url || saved.url || '';
    token = token || saved.token || '';
  }
  if (!url || !token) {
    throw new ToolError(
      'Rose tools are not configured in this session (ROSE_TOOLS_URL / ROSE_TOOLS_TOKEN missing).'
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * One HTTP call. Network errors, 429 and 5xx retry with backoff up to
 * SEND_ATTEMPTS times. Every POST is idempotent
 * server-side, so a retried send never posts twice.
 */
async function call(method, path, body) {
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
    if (!retryable || attempt >= SEND_ATTEMPTS) {
      const details = Array.isArray(data.details) ? `\n  - ${data.details.join('\n  - ')}` : '';
      throw new ToolError(
        `${data.error || `HTTP ${status}`}${status ? ` (HTTP ${status})` : ''}${details}`
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 15_000);
  }
}

// ── bundles: a folder, or an .html/.gltf/.obj/.js plus the files it references ──
// The reference walk mirrors collectDisplayBundleFiles in
// back-end/src/providers/agentTools/displayBundle.ts.

const extOf = (path) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();
const BUNDLE_ROOT_EXT = new Set(['html', 'htm', 'gltf', 'obj', 'js', 'mjs']);
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
      if (child.split('/').some((part) => part.startsWith('.') || part === 'node_modules'))
        continue;
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
  };
}

/** One HTML page written by the caller, displayed without a file. */
function htmlItem(html) {
  if (typeof html !== 'string') throw new ToolError('html must be a string (one HTML page)');
  const bytes = Buffer.from(html.trim(), 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw new ToolError('html: larger than 20 MB');
  return {
    body: { content_base64: bytes.toString('base64'), filename: 'display.html' },
  };
}

function buildItems(paths = [], urls = [], html) {
  const items = [
    ...paths.map((ref) => fileItem(ref)),
    ...urls.map((ref) => ({ body: { url: ref } })),
    ...(html !== undefined && html !== null && String(html).trim() ? [htmlItem(html)] : []),
  ];
  if (items.length > MAX_ITEMS)
    throw new ToolError(`at most ${MAX_ITEMS} items per call (got ${items.length})`);
  return items;
}

// ── tools (shared by CLI and MCP) ──

async function displayTool(args) {
  const items = buildItems(args.paths, args.urls, args.html);
  const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
  if (items.length === 0) throw new ToolError('display needs html or at least one path or url');
  const describe = (result) =>
    (result.items || []).map((item) => {
      const pointer = item.file_pointer || {};
      const files = pointer.bundle ? ` (${pointer.bundle.file_count} files)` : '';
      const at = pointer.usercontent_url ? ` at ${pointer.usercontent_url}` : '';
      const framed = item.kind && item.kind !== 'image' && item.kind !== 'video';
      const shown = item.status === 'duplicate' ? 'already displayed' : 'displayed';
      return `${shown} ${item.mime_type}${framed ? ` as ${item.kind}${files}${at}` : ''} (message ${item.message_id})`;
    });
  // One request per item keeps each body far below the JSON body limit;
  // the server dedupes by content hash, so a retry never posts twice.
  const shown = [];
  for (let i = 0; i < items.length; i += 1) {
    const result = await call('POST', '/display', {
      items: [items[i].body],
      ...(i === 0 && caption ? { caption } : {}),
      placement: 'inline',
    });
    shown.push(...describe(result));
  }
  return { text: shown.join('\n'), rejected: false };
}

async function messageTool(rawArgs) {
  const args = stockArgs(rawArgs, ['inline_view']);
  const message = typeof args.message === 'string' ? args.message.trim() : '';
  if (!message) throw new ToolError('message must be non-empty');
  const result = await call('POST', '/messages', {
    message,
    ...(args.inline_view ? { inline_view: args.inline_view } : {}),
    idempotency_key: randomUUID(),
  });
  return { text: `sent (message ${result.message_id})`, rejected: false };
}

// ── environment size (C16) ──

const GB = 1024 ** 3;
const CPU_SAMPLE_MS = Number(process.env.ROSE_ENV_CPU_SAMPLE_MS || 1000);
const round1 = (value) => Math.round(value * 10) / 10;

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function memoryInfo() {
  const text = readText('/proc/meminfo') || '';
  const bytes = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = bytes('MemTotal') ?? totalmem();
  const available = bytes('MemAvailable') ?? freemem();
  const swapTotal = bytes('SwapTotal') ?? 0;
  const swapFree = bytes('SwapFree') ?? 0;
  return { total, available, used: total - available, swapTotal, swapUsed: swapTotal - swapFree };
}

/** OOM kills: this cgroup's memory.events, else the kernel's count since boot. */
function oomKills() {
  const cgroup = (readText('/sys/fs/cgroup/memory.events') || '').match(/^oom_kill (\d+)/m);
  if (cgroup) return { count: Number(cgroup[1]), source: 'cgroup memory.events' };
  const vmstat = (readText('/proc/vmstat') || '').match(/^oom_kill (\d+)/m);
  if (vmstat) return { count: Number(vmstat[1]), source: '/proc/vmstat, since boot' };
  return null;
}

/** pid → {rssBytes, ticks, command} from /proc; null when /proc is unavailable (macOS). */
function procSnapshot() {
  let pids;
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  const out = new Map();
  for (const pid of pids) {
    const stat = readText(`/proc/${pid}/stat`);
    const statm = readText(`/proc/${pid}/statm`);
    if (!stat || !statm) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    const rssBytes = Number(statm.split(' ')[1]) * 4096;
    const cmdline = (readText(`/proc/${pid}/cmdline`) || '').split('\0').join(' ').trim();
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    out.set(Number(pid), { rssBytes, ticks, command: (cmdline || `[${comm}]`).slice(0, 160) });
  }
  return out;
}

function psTop(sortFlag) {
  return execFileSync('ps', ['-axo', 'pid=,rss=,pcpu=,command=', sortFlag], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 5)
    .map((line) => {
      const [pid, rss, pcpu, ...command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        rss_mb: Math.round(Number(rss) / 1024),
        cpu_pct: Number(pcpu),
        command: command.join(' ').slice(0, 160),
      };
    });
}

/** Top 5 by RSS and by CPU over a short sample (ps off Linux). */
async function topProcesses() {
  const first = procSnapshot();
  if (first === null) return { byMemory: psTop('-m'), byCpu: psTop('-r') };
  await sleep(CPU_SAMPLE_MS);
  const second = procSnapshot() || new Map();
  const ticksPerSecond = 100;
  const rows = [...second.entries()]
    .filter(([pid]) => pid !== process.pid)
    .map(([pid, now]) => {
      const before = first.get(pid);
      const delta = before ? Math.max(0, now.ticks - before.ticks) : 0;
      return {
        pid,
        rss_mb: Math.round(now.rssBytes / (1024 * 1024)),
        cpu_pct: round1((delta / ticksPerSecond / (CPU_SAMPLE_MS / 1000)) * 100),
        command: now.command,
      };
    });
  return {
    byMemory: [...rows].sort((a, b) => b.rss_mb - a.rss_mb).slice(0, 5),
    byCpu: [...rows].sort((a, b) => b.cpu_pct - a.cpu_pct || b.rss_mb - a.rss_mb).slice(0, 5),
  };
}

const sizeText = (size) => (size ? `${size.cpu} vCPU, ${size.memory_gb} GB RAM` : 'unknown');

async function environmentStatus() {
  let rose;
  try {
    rose = await call('GET', '/environment');
  } catch (err) {
    rose = { applicable: null, error: err.message };
  }
  const memory = memoryInfo();
  const top = await topProcesses();
  return {
    rose,
    visible: { cpus: cpus().length, memory_gb: round1(memory.total / GB) },
    memory: {
      used_gb: round1(memory.used / GB),
      total_gb: round1(memory.total / GB),
      available_gb: round1(memory.available / GB),
      used_pct: Math.round((memory.used / memory.total) * 100),
    },
    swap: { used_gb: round1(memory.swapUsed / GB), total_gb: round1(memory.swapTotal / GB) },
    load_average: loadavg().map((value) => Math.round(value * 100) / 100),
    oom_kills: oomKills(),
    top_memory: top.byMemory,
    top_cpu: top.byCpu,
  };
}

function formatEnvironment(status) {
  const lines = [];
  const rose = status.rose || {};
  if (rose.applicable === true) {
    lines.push(`Environment: ${sizeText(rose.size)} (largest allowed: ${sizeText(rose.max)})`);
    lines.push(`Built sizes: ${(rose.available || []).map(sizeText).join('; ') || 'none'}`);
    const last = (rose.resizes || [])[0];
    if (last) {
      lines.push(
        `Last resize: ${sizeText(last.from)} -> ${sizeText(last.to)} (${last.status}, ${last.requested_at})`
      );
    }
  } else if (rose.applicable === false) {
    lines.push(`Environment: ${rose.message}`);
  } else {
    lines.push(`Environment: size unknown (${rose.error})`);
  }
  lines.push(`Visible here: ${status.visible.cpus} CPUs, ${status.visible.memory_gb} GB memory`);
  const m = status.memory;
  lines.push(
    `Memory: ${m.used_gb} GB used of ${m.total_gb} GB (${m.used_pct}%), ${m.available_gb} GB available`
  );
  lines.push(`Swap: ${status.swap.used_gb} GB used of ${status.swap.total_gb} GB`);
  lines.push(`Load average: ${status.load_average.join(' ')} (1/5/15 min)`);
  lines.push(
    status.oom_kills
      ? `OOM kills: ${status.oom_kills.count} (${status.oom_kills.source})`
      : 'OOM kills: not readable here'
  );
  const table = (title, rows) => {
    lines.push(title);
    lines.push('  PID      RSS_MB   CPU%  COMMAND');
    for (const row of rows) {
      lines.push(
        `  ${String(row.pid).padEnd(8)} ${String(row.rss_mb).padStart(6)}  ${String(row.cpu_pct).padStart(5)}  ${row.command}`
      );
    }
  };
  table('Top 5 processes by memory (RSS):', status.top_memory);
  table(`Top 5 processes by CPU (last ${CPU_SAMPLE_MS / 1000} s):`, status.top_cpu);
  return lines.join('\n');
}

function sizeNumber(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new ToolError(`${name} must be a whole number`);
  return number;
}

async function environmentSizeTool(args) {
  const cpu = sizeNumber(args.cpu, 'cpu');
  const memoryGb = sizeNumber(args.memory_gb, 'memory_gb');
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  if (cpu === undefined && memoryGb === undefined) {
    throw new ToolError('give a cpu count, a memory size in GB, or both');
  }
  if (!reason) throw new ToolError('a reason is required (what needs the new size)');
  const result = await call('POST', '/environment/size', {
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memoryGb !== undefined ? { memory_gb: memoryGb } : {}),
    reason,
  });
  return { text: result.message || `resize ${result.status}`, rejected: false };
}

// ── MCP stdio server ──

const ENV_SIZE_MCP_TOOL = {
  name: 'change_environment_size',
  description:
    'Move this session to a sandbox with more or fewer vCPUs and/or GB of memory. Use it for legitimate demand (repeated OOM kills, heavy swap, minutes of CPU-bound builds or tests), not for a runaway process or leak: kill or fix that instead. Run `rose env status` first. The session is saved and continues automatically in the new sandbox (same branch, files and conversation).',
  inputSchema: {
    type: 'object',
    properties: {
      cpu: { type: 'integer', description: 'vCPUs wanted; omit to keep the current count.' },
      memory_gb: {
        type: 'integer',
        description: 'Memory in GB wanted; omit to keep the current size.',
      },
      reason: { type: 'string', description: 'What needs the new size, with evidence.' },
    },
    required: ['reason'],
  },
};

const STOCK_MCP_TOOLS = [
  {
    name: 'display',
    description: 'Show images, videos or HTML pages to the user inline in Rose.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Local files (image/*, video/*, .html).',
        },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Public http(s) URLs, fetched by Rose.',
        },
        html: {
          type: 'string',
          description: 'A complete HTML page you write yourself, shown without creating a file.',
        },
        caption: { type: 'string', description: 'Caption shown with the media.' },
      },
    },
  },
  {
    name: 'send_message_to_user',
    description: 'Send the user a message in Rose: progress, results, scorecards.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  ENV_SIZE_MCP_TOOL,
];

const ROSE_DESKTOP_MCP_TOOLS = [
  {
    name: 'display',
    description:
      'Show the user images, videos, web pages, whole sites, JavaScript, 3D models or PDFs inline in Rose. Pages and scripts run any CSS and JS (CDN scripts and modules, three.js, WebGL/WebGPU, WebAssembly, fetch) in a sandboxed frame.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Local files or folders: images, videos, an .html page (the files it references come along), a site folder (index.html), a .js/.mjs module run on a full-window page (import 'three' and 'three/addons/...' work; a default-exported function is called with a full-window element; its relative imports come along), a 3D model (.glb .gltf .obj .stl .usdz) or a .pdf.",
        },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Public http(s) URLs (image, video, page, model or PDF), fetched by Rose.',
        },
        html: {
          type: 'string',
          description: 'A complete HTML page you write yourself, shown without creating a file.',
        },
        caption: { type: 'string', description: 'Caption shown with the media.' },
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
  ENV_SIZE_MCP_TOOL,
];

const mcpTools = () => (roseDesktop() ? ROSE_DESKTOP_MCP_TOOLS : STOCK_MCP_TOOLS);

const MCP_HANDLERS = {
  display: displayTool,
  send_message_to_user: messageTool,
  change_environment_size: environmentSizeTool,
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
    if (method === 'tools/list') return reply(id, { tools: mcpTools() });
    if (method === 'tools/call') {
      const handler = MCP_HANDLERS[params.name];
      if (!handler) return fail(id, -32602, `unknown tool ${params.name}`);
      try {
        const result = await handler(params.arguments || {});
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

const STOCK_USAGE = `usage:
  rose display <file|url>... [--html PAGE] [--caption TEXT]
  rose message <text>
  rose env status [--json]
  rose env size [--cpu N] [--memory-gb M] --reason TEXT
  rose mcp`;

const ROSE_DESKTOP_USAGE = `usage:
  rose display <file|folder|url>... [--html PAGE] [--caption TEXT]
      images, videos, .html pages (+ the files they reference), site folders,
      .js/.mjs modules (run full-window; import 'three' works),
      3D models (.glb .gltf .obj .stl .usdz) and PDFs
  rose message <text> [--inline-view NAME] [--props JSON]
  rose env status [--json]
  rose env size [--cpu N] [--memory-gb M] --reason TEXT
  rose mcp`;

const usage = () => (roseDesktop() ? ROSE_DESKTOP_USAGE : STOCK_USAGE);

/** Known flags only: an unknown one (e.g. a removed --pinned) is an error, never ignored. */
function parseFlags(argv, valueFlags, booleanFlags = new Set()) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (booleanFlags.has(name)) {
      flags[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new ToolError(`unknown option --${name}\n${usage()}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new ToolError(`--${name} needs a value`);
    (flags[name] ||= []).push(value);
  }
  return { positional, flags };
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
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
    const { positional, flags } = parseFlags(rest, new Set(['caption', 'html']));
    result = await displayTool({
      paths: positional.filter((ref) => !/^https?:\/\//i.test(ref)),
      urls: positional.filter((ref) => /^https?:\/\//i.test(ref)),
      html: (flags.html || [])[0],
      caption: (flags.caption || [])[0],
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
  } else if (command === 'env') {
    const [sub, ...envArgs] = rest;
    const { flags } = parseFlags(
      envArgs,
      new Set(['cpu', 'memory-gb', 'reason']),
      new Set(['json'])
    );
    if (sub === 'status') {
      const status = await environmentStatus();
      result = {
        text: flags.json ? JSON.stringify(status, null, 2) : formatEnvironment(status),
        rejected: false,
      };
    } else if (sub === 'size') {
      result = await environmentSizeTool({
        cpu: (flags.cpu || [])[0],
        memory_gb: (flags['memory-gb'] || [])[0],
        reason: (flags.reason || [])[0],
      });
    } else {
      throw new ToolError(
        'usage: rose env status [--json] | rose env size [--cpu N] [--memory-gb M] --reason TEXT'
      );
    }
  } else {
    throw new ToolError(`unknown command ${command}\n${usage()}`);
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
