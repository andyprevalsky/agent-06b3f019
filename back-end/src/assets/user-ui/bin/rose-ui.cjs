#!/usr/bin/env node
'use strict';
/**
 * rose-ui — the code agent's CLI for its user's Rose app UI bundle.
 * Installed by Rose at ~/.rose/bin/rose-ui and regenerated every session; do not edit.
 * How to use it is the rose-ui skill (~/.rose/skills/rose-ui/SKILL.md).
 *
 *   pull [<dir>] ──► GET $ROSE_UI_BUNDLE_URL (publish token) ──► the published bundle in <dir>
 *                    (default ~/rose_user_ui; later commands use the pulled folder, or --dir)
 *   <dir>/ ──► preview servers (this process)
 *                       host     http://127.0.0.1:<A>/          mock Rose chrome + bridge
 *                       content  http://127.0.0.1:<B>/c/<path>  your files, production CSP
 *                         │  <iframe sandbox="allow-scripts"> on a different origin
 *                         ▼
 *                     headless Chromium (playwright-core) ──► screenshot / record / perf / check
 *   --published: the content origin is the user's live usercontent URL instead.
 *
 * Only `publish` needs no browser. The browser commands need playwright-core and a
 * Chromium build (installed in the Rose code-session template).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const CLI_VERSION = '5';
const KB = 1024;
const MB = 1024 * KB;
const MAX_FILE = 10 * MB;
const MAX_TOTAL = 50 * MB;
const MAX_FILES = 2000;
/** Must equal USERCONTENT_CSP in back-end/src/domains/user-ui/config.ts (unit-tested). */
const USERCONTENT_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; " +
  "connect-src 'self'; worker-src blob:; frame-ancestors *";
const SLOT_NAMES = ['background', 'sidebar.header', 'menu', 'home.dashboard', 'agent.panel'];
/** Control page the check command measures to calibrate the host's own frame rate. */
const BLANK_PAGE = '.rose-blank.html';
/** Top-level folders that are local-only: never published, never served. */
const LOCAL_ONLY_DIRS = new Set(['screenshots']);
const DEFAULT_BUDGETS = Object.freeze({
  fpsP50Min: 55,
  fpsP5Min: 30,
  longTaskMaxMs: 50,
  clsMax: 0.1,
  entryBytesMax: 5 * MB,
  scriptBytesMax: 1.5 * MB,
  mediaFileBytesMax: 2 * MB,
  gifBytesMax: 512 * KB,
  hiddenCallbacksPerSecMax: 2,
  /** Median per-400ms pixel change under prefers-reduced-motion (continuous motion). */
  reducedMotionChangedMax: 0.001,
});
/** Display refresh rates frame intervals are snapped to (see frameStats). */
const STANDARD_REFRESH_HZ = [24, 30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];
/** 1-minute load average per CPU above which fps cannot be judged fairly. */
const HOST_BUSY_LOAD_PER_CORE = 1.25;
/** Share of the host's CPU time other processes used during an fps window above which it is not judged. */
const HOST_BUSY_OTHER_SHARE = 0.5;
/** `screenshot --current` captures: CSS viewport x device scale = PNG pixels. */
const CURRENT_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800, scale: 2 },
  { name: 'mobile', width: 390, height: 844, scale: 3 },
];
const CURRENT_ROUTES = [
  { name: 'home', route: '/' },
  { name: 'agent', route: '/agent' },
];
/** Color tokens the Rose app reads as hsl(var(--name)): values must be "H S% L%". */
const HSL_TRIPLET_TOKENS = new Set([
  '--background', '--foreground', '--surface', '--surface-elevated', '--primary',
  '--primary-foreground', '--space-gray', '--space-gray-foreground', '--card',
  '--card-foreground', '--secondary', '--secondary-foreground', '--muted',
  '--muted-foreground', '--accent', '--accent-foreground', '--border', '--input', '--ring',
  '--sidebar-background', '--sidebar-foreground', '--sidebar-primary',
  '--sidebar-primary-foreground', '--sidebar-accent', '--sidebar-accent-foreground',
  '--sidebar-border', '--sidebar-ring',
]);
const HSL_TRIPLET_RE =
  /^\s*-?\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%(\s*\/\s*\d+(\.\d+)?%?)?\s*$/;
const LAYOUT_PROPERTIES = new Set([
  'width', 'height', 'top', 'left', 'right', 'bottom', 'inset', 'margin', 'marginTop',
  'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'fontSize', 'lineHeight', 'minWidth', 'minHeight',
  'maxWidth', 'maxHeight', 'borderWidth', 'flexBasis', 'gridTemplateColumns',
  'gridTemplateRows',
]);
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', glsl: 'text/plain; charset=utf-8',
  wgsl: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8',
  wat: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png',
  apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', mp4: 'video/mp4',
  webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm',
};
const SCRIPT_EXT = new Set(['js', 'mjs', 'wasm']);
const MEDIA_EXT = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'mp4', 'webm', 'mp3', 'wav', 'ogg']);

// ───────────────────────────── small utils ─────────────────────────────

class UsageError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ext = (p) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();
const contentType = (p) => CONTENT_TYPES[ext(p)] || 'application/octet-stream';
const fmtBytes = (n) => (n >= MB ? `${(n / MB).toFixed(2)} MB` : n >= KB ? `${(n / KB).toFixed(1)} KB` : `${n} B`);
const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 0) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function parseViewport(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(value));
  if (!m) throw new UsageError(`--viewport must look like 1280x800 (got ${value})`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function numberFlag(value, fallback, name, { min = 0, max = Infinity } = {}) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number in [${min}, ${max}]`);
  return n;
}

/** Default bundle folder when nothing was pulled and no --dir / $ROSE_UI_DIR is given. */
const DEFAULT_DIR_NAME = 'rose_user_ui';
/** `rose-ui pull` records the folder here so later commands find it. */
const PULLED_DIR_FILE = () => path.join(os.homedir(), '.rose', 'rose-ui-dir');
/** Written into the pulled folder (a dotfile, so it is never published). */
const PULL_RECORD = '.rose-pull.json';
/** --dir for this invocation (set by main). */
let dirFlag = null;

function pulledDir() {
  try {
    const dir = fs.readFileSync(PULLED_DIR_FILE(), 'utf8').trim();
    return dir || null;
  } catch {
    return null;
  }
}

/** The bundle folder: --dir, then $ROSE_UI_DIR, then the last pulled folder, then ~/rose_user_ui. */
function uiRoot() {
  if (dirFlag) return path.resolve(dirFlag);
  if (process.env.ROSE_UI_DIR) return path.resolve(process.env.ROSE_UI_DIR);
  return path.resolve(pulledDir() || path.join(os.homedir(), DEFAULT_DIR_NAME));
}

function routeSlug(route) {
  const clean = String(route).split('?')[0].replace(/^\/+|\/+$/g, '');
  return (clean || 'home').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'home';
}

function normalizeRoute(route) {
  const value = route === undefined || route === true ? '/' : String(route);
  return value.startsWith('/') ? value : `/${value}`;
}

/** A bundle-relative path that the publish API and usercontent server accept. */
function isPublishablePath(rel) {
  if (!rel || rel.length > 512 || rel.startsWith('/') || rel.includes('\\')) return false;
  const parts = rel.split('/');
  if (LOCAL_ONLY_DIRS.has(parts[0])) return false;
  return parts.every((s) => s.length > 0 && !s.startsWith('.') && s !== 'node_modules');
}

/** Every publishable file under root (sorted), with sizes. */
function listFiles(root) {
  const files = [];
  function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (!rel && LOCAL_ONLY_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) files.push({ path: relPath, abs, size: fs.statSync(abs).size });
    }
  }
  walk(root, '');
  return files;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLocalManifest(root) {
  const file = path.join(root, 'rose-ui.json');
  if (!fs.existsSync(file)) throw new UsageError(`no rose-ui.json in ${root}`);
  const manifest = readJson(file);
  let theme = null;
  if (manifest.theme && fs.existsSync(path.join(root, manifest.theme))) theme = readJson(path.join(root, manifest.theme));
  return { manifest, theme };
}

/** Manifest entries as check targets: [{kind, name, entry}]. */
function manifestEntries(manifest) {
  const out = [];
  if (manifest.shell && manifest.shell.entry) out.push({ kind: 'shell', name: 'shell', entry: manifest.shell.entry });
  for (const [name, slot] of Object.entries(manifest.slots || {})) if (slot && slot.entry) out.push({ kind: 'slot', name, entry: slot.entry });
  for (const [name, view] of Object.entries(manifest.inline || {})) if (view && view.entry) out.push({ kind: 'inline', name, entry: view.entry });
  for (const [name, app] of Object.entries(manifest.apps || {})) if (app && app.entry) out.push({ kind: 'app', name, entry: app.entry });
  return out;
}

// ───────────────────────────── static audit ─────────────────────────────

/** Theme lint: token names/values the Rose app would drop or render wrong. */
function lintTheme(theme) {
  const violations = [];
  const tokens = (theme && theme.tokens) || {};
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^--[a-z0-9-]+$/.test(name)) violations.push({ rule: 'theme-token', message: `${name}: token names must be lowercase CSS custom properties` });
    else if (typeof value !== 'string' || /url\(|expression|javascript:|@import|[;{}<\\]/i.test(value)) violations.push({ rule: 'theme-token', message: `${name}: value is not a plain CSS value` });
    else if (HSL_TRIPLET_TOKENS.has(name) && !HSL_TRIPLET_RE.test(value)) {
      violations.push({ rule: 'theme-token', message: `${name}: "${value}" must be an HSL triplet like "262 83% 58%" (the app reads hsl(var(${name})))` });
    }
  }
  const fade = theme && theme.background ? theme.background.fadeAfterFirstMessage : undefined;
  if (fade !== undefined && (typeof fade !== 'number' || fade < 0 || fade > 1)) violations.push({ rule: 'theme-background', message: 'background.fadeAfterFirstMessage must be a number in [0, 1]' });
  return violations;
}

/**
 * Static budget audit for one entry: everything under the entry's folder.
 * files: [{path, size, text?}] relative to the bundle root.
 */
function auditEntryFiles(entry, files, budgets = DEFAULT_BUDGETS) {
  const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const own = files.filter((f) => f.path.startsWith(dir) && (dir || !f.path.includes('/')));
  const violations = [];
  const warnings = [];
  const totalBytes = own.reduce((s, f) => s + f.size, 0);
  const scriptBytes = own.filter((f) => SCRIPT_EXT.has(ext(f.path))).reduce((s, f) => s + f.size, 0);
  if (totalBytes > budgets.entryBytesMax) violations.push({ rule: 'bundle-bytes', message: `${dir || './'} is ${fmtBytes(totalBytes)} (max ${fmtBytes(budgets.entryBytesMax)})`, value: totalBytes, limit: budgets.entryBytesMax });
  if (scriptBytes > budgets.scriptBytesMax) violations.push({ rule: 'script-bytes', message: `JS/WASM under ${dir || './'} is ${fmtBytes(scriptBytes)} (max ${fmtBytes(budgets.scriptBytesMax)})`, value: scriptBytes, limit: budgets.scriptBytesMax });
  for (const f of own) {
    const e = ext(f.path);
    if (e === 'gif' && f.size > budgets.gifBytesMax) violations.push({ rule: 'gif-bytes', message: `${f.path} is a ${fmtBytes(f.size)} GIF (max ${fmtBytes(budgets.gifBytesMax)}); use MP4/WebM or animated WebP/AVIF`, value: f.size, limit: budgets.gifBytesMax });
    else if (MEDIA_EXT.has(e) && f.size > budgets.mediaFileBytesMax) violations.push({ rule: 'media-bytes', message: `${f.path} is ${fmtBytes(f.size)} (max ${fmtBytes(budgets.mediaFileBytesMax)} per media file)`, value: f.size, limit: budgets.mediaFileBytesMax });
  }
  const texts = own.filter((f) => typeof f.text === 'string');
  const allText = texts.map((f) => f.text).join('\n');
  const animates = /requestAnimationFrame|@keyframes|animation\s*:|\.animate\(|startViewTransition|<video[^>]*autoplay/i.test(allText);
  if (animates && !/prefers-reduced-motion/.test(allText)) violations.push({ rule: 'reduced-motion-static', message: `${entry} animates but never checks prefers-reduced-motion` });
  for (const f of texts.filter((t) => /\.html?$/.test(t.path))) {
    for (const tag of f.text.match(/<img\b[^>]*>/gi) || []) {
      if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) warnings.push({ rule: 'img-size', message: `${f.path}: <img> without width/height can shift layout: ${tag.slice(0, 80)}` });
    }
    for (const tag of f.text.match(/<video\b[^>]*>/gi) || []) {
      if (/autoplay/i.test(tag) && !/muted/i.test(tag)) warnings.push({ rule: 'video-muted', message: `${f.path}: autoplay <video> must be muted (and playsinline) to play` });
    }
  }
  return { entry, dir: dir || './', totalBytes, scriptBytes, fileCount: own.length, violations, warnings };
}

function readTextForAudit(file) {
  return /\.(html?|js|mjs|css|json|wgsl|glsl)$/i.test(file.path) && file.size <= 2 * MB ? fs.readFileSync(file.abs, 'utf8') : undefined;
}

// ───────────────────────────── budgets ─────────────────────────────

/**
 * Frame-time distribution → fps. times are rAF timestamps in ms.
 * Frames land on display refreshes, so each delta is quantized to a whole number of
 * refresh intervals (the mean of the on-time cluster: deltas within 1.5x of the
 * fastest 10%) before p50/p5 are read: timestamp jitter (33.3 vs 33.4 ms for one
 * missed vsync) must not flip a verdict. p5 >= 30 therefore means "at most one
 * missed refresh at p95" at 60 Hz.
 */
function frameStats(times) {
  if (!times || times.length < 3) return { frames: times ? times.length : 0, p50: null, p5: null, mean: null, worstFrameMs: null, refreshMs: null };
  const deltas = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  const sorted = deltas.slice().sort((a, b) => a - b);
  const pick = (list, q) => list[Math.min(list.length - 1, Math.floor(q * (list.length - 1)))];
  const fast = pick(sorted, 0.1);
  const onTime = sorted.filter((d) => d <= fast * 1.5);
  const measured = Math.max(4, onTime.reduce((s, d) => s + d, 0) / onTime.length);
  // Snap to a standard display rate when within 3% (60 Hz measures 16.6-16.8 ms).
  const hz = STANDARD_REFRESH_HZ.find((r) => Math.abs(1000 / measured - r) / r <= 0.03);
  const refresh = hz ? 1000 / hz : measured;
  const quantized = sorted.map((d) => Math.max(1, Math.round(d / refresh)) * refresh);
  return {
    frames: times.length,
    p50: round(1000 / pick(quantized, 0.5)),
    p5: round(1000 / pick(quantized, 0.95)),
    mean: round(((times.length - 1) * 1000) / (times[times.length - 1] - times[0])),
    worstFrameMs: round(sorted[sorted.length - 1]),
    refreshMs: round(refresh, 2),
  };
}

/**
 * CLS as browsers report it: the largest session window of layout shifts, where a
 * window ends after a 1 s gap or at 5 s. shifts: [{t: ms, v: score}].
 */
function cumulativeLayoutShift(shifts) {
  let best = 0;
  let sum = 0;
  let start = -Infinity;
  let prev = -Infinity;
  for (const { t, v } of (shifts || []).slice().sort((a, b) => a.t - b.t)) {
    if (t - prev > 1000 || t - start > 5000) {
      sum = 0;
      start = t;
    }
    sum += v;
    prev = t;
    best = Math.max(best, sum);
  }
  return best;
}

/**
 * Pure budget evaluation over one measured entry (see measureEntry for the shape).
 * Returns { pass, violations[], warnings[] }; check exits non-zero when any entry fails.
 */
function evaluateBudgets(result, budgets = DEFAULT_BUDGETS) {
  const violations = [...((result.static && result.static.violations) || [])];
  const warnings = [...((result.static && result.static.warnings) || [])];
  const normal = result.normal;
  if (normal) {
    for (const message of normal.errors || []) violations.push({ rule: 'page-error', message });
    const fpsSources = [{ label: 'main thread', stats: normal.fps }, ...(normal.workers || []).map((w, i) => ({ label: `worker ${i + 1}`, stats: w.fps }))];
    const host = result.host || {};
    // Contention measured inside the fps windows themselves: every window the verdict could use
    // ran while other processes held over HOST_BUSY_OTHER_SHARE of the host's CPU. The 1-minute
    // load average lags a host that just became busy, so it alone cannot tell.
    const windows = Array.isArray(normal.hostCpu) ? normal.hostCpu : [];
    const contended = windows.length > 0 && windows.every((w) => w && typeof w.other === 'number' && w.other > HOST_BUSY_OTHER_SHARE);
    const loaded = typeof host.loadPerCore === 'number' && host.loadPerCore > HOST_BUSY_LOAD_PER_CORE;
    const busy = loaded || contended;
    const busyWhy = contended && !loaded
      ? `other processes used ${windows.map((w) => `${round(w.other * 100, 0)}%`).join(' and ')} of the host's CPU while fps was measured`
      : `load ${host.loadPerCore} per core`;
    for (const { label, stats } of fpsSources) {
      if (!stats || stats.frames < 10 || stats.p50 === null) continue;
      const missed = stats.p50 < budgets.fpsP50Min || stats.p5 < budgets.fpsP5Min;
      if (missed && result.hostBaseline && result.hostBaseline.p50 !== null && result.hostBaseline.p50 < budgets.fpsP50Min) {
        warnings.push({ rule: 'fps-inconclusive', message: `${label} ${stats.p50}/${stats.p5} fps not judged: this host renders a blank page at only ${result.hostBaseline.p50} fps` });
        continue;
      }
      if (missed && busy) {
        warnings.push({ rule: 'fps-inconclusive', message: `${label} ${stats.p50}/${stats.p5} fps not judged: host oversubscribed (${busyWhy}); re-run check on a quiet host` });
        continue;
      }
      if (stats.p50 < budgets.fpsP50Min) violations.push({ rule: 'fps-p50', message: `${label} p50 ${stats.p50} fps (min ${budgets.fpsP50Min})`, value: stats.p50, limit: budgets.fpsP50Min });
      if (stats.p5 < budgets.fpsP5Min) violations.push({ rule: 'fps-p5', message: `${label} p5 ${stats.p5} fps (min ${budgets.fpsP5Min}); worst frame ${stats.worstFrameMs} ms`, value: stats.p5, limit: budgets.fpsP5Min });
    }
    // A steady task over budget in CPU time, or in CPU plus time blocked in a call the page made
    // (pageWait: sync XHR, GPU readback), is the page's work. The rest of a long wall time is the
    // host (descheduled, page faults, stopped); such a task fails unless a second window
    // (longTaskRecheck) has no long task at all. Missing evidence is judged as page work.
    const limit = budgets.longTaskMaxMs;
    const steady = (normal.longTasks || []).filter((t) => t.phase === 'steady' && t.duration > limit);
    const pageMs = (t) => (typeof t.cpu === 'number' && typeof t.pageWait === 'number' ? t.cpu + t.pageWait : t.duration);
    const heavy = steady.filter((t) => pageMs(t) > limit);
    const stalls = steady.filter((t) => pageMs(t) <= limit);
    const recheck = Array.isArray(normal.longTaskRecheck) ? normal.longTaskRecheck.filter((t) => t.duration > limit) : null;
    if (heavy.length > 0) {
      const max = Math.max(...heavy.map(pageMs));
      const why = heavy.every((t) => typeof t.cpu === 'number' && typeof t.pageWait === 'number') ? 'of CPU or blocking calls' : 'judged on wall time: no thread-state samples';
      violations.push({ rule: 'long-task', message: `${heavy.length} main-thread task(s) over ${limit} ms while running (max ${round(max)} ms ${why})`, value: max, limit });
    } else if (stalls.length > 0 && (recheck === null || recheck.length > 0)) {
      const max = Math.max(...stalls.map((t) => t.duration), ...(recheck || []).map((t) => t.duration));
      violations.push({ rule: 'long-task', message: `${stalls.length} main-thread task(s) over ${limit} ms while running (max ${round(max)} ms), ${recheck === null ? 'not re-measured' : 'again in a second window'}`, value: max, limit });
    } else if (stalls.length > 0) {
      warnings.push({ rule: 'long-task-stall', message: `${stalls.length} task(s) took over ${limit} ms of wall time (max ${round(Math.max(...stalls.map((t) => t.duration)))} ms) but under ${limit} ms of CPU and blocking calls, and did not recur in a second window: a host stall, not judged` });
    }
    const loading = (normal.longTasks || []).filter((t) => t.phase === 'load' && t.duration > budgets.longTaskMaxMs);
    if (loading.length > 0) warnings.push({ rule: 'load-long-task', message: `${loading.length} task(s) over ${budgets.longTaskMaxMs} ms during load (max ${round(Math.max(...loading.map((t) => t.duration)))} ms)` });
    if (typeof normal.cls === 'number' && normal.cls > budgets.clsMax) violations.push({ rule: 'layout-shift', message: `cumulative layout shift ${round(normal.cls, 3)} (max ${budgets.clsMax})`, value: normal.cls, limit: budgets.clsMax });
    const layoutAnimations = (normal.animations || []).filter((a) => (a.properties || []).some((p) => LAYOUT_PROPERTIES.has(p)));
    for (const a of layoutAnimations) violations.push({ rule: 'layout-animation', message: `animation ${a.name || '(unnamed)'} animates layout (${a.properties.filter((p) => LAYOUT_PROPERTIES.has(p)).join(', ')}); animate transform/opacity instead` });
    if (normal.bytes && normal.bytes.total > budgets.entryBytesMax) violations.push({ rule: 'runtime-bytes', message: `loaded ${fmtBytes(normal.bytes.total)} at runtime (max ${fmtBytes(budgets.entryBytesMax)})`, value: normal.bytes.total, limit: budgets.entryBytesMax });
  }
  const hidden = result.hidden;
  if (hidden) {
    const sources = [{ label: 'page', rate: hidden.callbacksPerSec }, ...(hidden.workers || []).map((w, i) => ({ label: `worker ${i + 1}`, rate: w.callbacksPerSec }))];
    for (const { label, rate } of sources) {
      if (typeof rate === 'number' && rate > budgets.hiddenCallbacksPerSecMax) violations.push({ rule: 'hidden-loop', message: `${label} kept running ${round(rate)} callbacks/s while hidden (max ${budgets.hiddenCallbacksPerSecMax}); stop loops on visibilitychange`, value: rate, limit: budgets.hiddenCallbacksPerSecMax });
    }
  }
  const rm = result.reducedMotion;
  if (rm && typeof rm.changedFraction === 'number' && rm.changedFraction > budgets.reducedMotionChangedMax) {
    violations.push({ rule: 'reduced-motion', message: `${round(rm.changedFraction * 100, 2)}% of pixels still moving under prefers-reduced-motion (max ${round(budgets.reducedMotionChangedMax * 100, 2)}%)`, value: rm.changedFraction, limit: budgets.reducedMotionChangedMax });
  }
  return { pass: violations.length === 0, violations, warnings };
}

// ───────────────────────────── PNG ─────────────────────────────

/** Minimal PNG decoder (8-bit, non-interlaced; what Chromium writes). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit, non-interlaced)');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function rgbAt(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return img.channels >= 3 ? [img.data[i], img.data[i + 1], img.data[i + 2]] : [img.data[i], img.data[i], img.data[i]];
}

/** Coarse content stats used to prove a capture is not blank. */
function pngStats(img) {
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 40000)));
  const counts = new Map();
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b] = rgbAt(img, x, y);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
  }
  const dominant = Math.max(...counts.values()) / n;
  const mean = sum / n;
  return { width: img.width, height: img.height, distinctColors: counts.size, dominantFraction: round(dominant, 4), lumaStdDev: round(Math.sqrt(Math.max(0, sumSq / n - mean * mean)), 2), nonBlank: counts.size > 8 && dominant < 0.98 };
}

/** Fraction of pixels whose max channel differs by more than `threshold`. */
function diffFraction(a, b, threshold = 24) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return 1;
  const n = a.width * a.height;
  const ch = a.channels;
  const colors = Math.min(3, ch);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    for (let c = 0; c < colors; c++) {
      if (Math.abs(a.data[o + c] - b.data[o + c]) > threshold) { changed++; break; }
    }
  }
  return changed / n;
}

// ───────────────────────────── preview servers ─────────────────────────────

function hostHtmlPath() {
  const candidates = [process.env.ROSE_UI_HOST_HTML, path.join(__dirname, '..', 'lib', 'rose-ui', 'preview-host.html')].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`preview host page not found (looked in ${candidates.join(', ')})`);
  return found;
}

function fingerprint(root) {
  const hash = crypto.createHash('sha1');
  for (const f of listFiles(root)) hash.update(`${f.path}:${f.size}:${fs.statSync(f.abs).mtimeMs}\n`);
  return hash.digest('hex').slice(0, 16);
}

function listen(server, port, bind) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve(server.address().port));
  });
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** Published version base URL (…/usercontent/<versionId>/) from the session env. */
function publishedBaseUrl() {
  const base = (process.env.ROSE_UI_PUBLISHED_BASE_URL || '').trim();
  return base ? (base.endsWith('/') ? base : `${base}/`) : null;
}

async function loadPublished(base) {
  const manifest = await fetchJson(`${base}rose-ui.json`);
  const theme = manifest.theme ? await fetchJson(`${base}${manifest.theme}`).catch(() => null) : null;
  const props = {};
  for (const [name, view] of Object.entries(manifest.inline || {})) {
    const dir = view.entry.includes('/') ? `${view.entry.slice(0, view.entry.lastIndexOf('/'))}/` : '';
    const example = await fetchJson(`${base}${dir}props.example.json`).catch(() => null);
    if (example !== null) props[name] = example;
  }
  return { manifest, theme, props };
}

function readExampleProps(root, manifest) {
  const props = {};
  for (const [name, view] of Object.entries(manifest.inline || {})) {
    const dir = view.entry.includes('/') ? view.entry.slice(0, view.entry.lastIndexOf('/')) : '.';
    const file = path.join(root, dir, 'props.example.json');
    if (fs.existsSync(file)) {
      try { props[name] = readJson(file); } catch { /* invalid example props are ignored */ }
    }
  }
  return props;
}

/**
 * Start the preview host + content servers. mode 'local' serves `root`;
 * mode 'published' points frames at the published usercontent base URL.
 */
async function startPreview({ root, published = false, bind = '127.0.0.1', hostPort = 0, contentPort = 0, live = false }) {
  const pubBase = published ? publishedBaseUrl() : null;
  if (published && !pubBase) throw new UsageError('no published version: ROSE_UI_PUBLISHED_BASE_URL is not set (the user has not published a UI yet)');
  const pub = published ? await loadPublished(pubBase) : null;
  const hostHtml = fs.readFileSync(hostHtmlPath(), 'utf8');
  const servers = [];
  let contentAddr = null;
  if (!published) {
    const content = http.createServer((req, res) => {
      res.setHeader('Content-Security-Policy', USERCONTENT_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'no-store');
      let rel = '';
      try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/c\//, '')); } catch { rel = ''; }
      const abs = path.resolve(root, rel);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (rel === BLANK_PAGE) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>blank</title><body style="margin:0;background:#fff"></body>');
        return;
      }
      if (!isPublishablePath(rel) || !abs.startsWith(root + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const stat = fs.statSync(abs);
      // Revalidate every load (files change while you work) but let the browser reuse
      // bytes it already has, like production's immutable per-version caching.
      const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
      res.writeHead(200, { 'Content-Type': contentType(rel), 'Content-Length': stat.size });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(abs).pipe(res);
    });
    contentAddr = await listen(content, contentPort, bind);
    servers.push(content);
  }
  const host = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__rose/state') {
      let state;
      try {
        const local = published ? pub : readLocalManifest(root);
        state = {
          source: published ? 'published' : 'local',
          versionId: published ? process.env.ROSE_UI_PUBLISHED_VERSION_ID || null : null,
          contentBase: published ? pubBase : null,
          contentPort: contentAddr,
          contentPath: '/c/',
          hostPort: hostAddr,
          manifest: local.manifest,
          theme: local.theme,
          props: published ? pub.props : readExampleProps(root, local.manifest),
          live,
        };
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/__rose/fingerprint') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ fingerprint: published ? 'published' : fingerprint(root) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(hostHtml);
  });
  const hostAddr = await listen(host, hostPort, bind);
  servers.push(host);
  const hostOrigin = `http://127.0.0.1:${hostAddr}`;
  return {
    hostOrigin,
    hostPort: hostAddr,
    contentPort: contentAddr,
    contentBase: published ? pubBase : `http://127.0.0.1:${contentAddr}/c/`,
    manifest: published ? pub.manifest : readLocalManifest(root).manifest,
    close: () => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); }))),
  };
}

// ───────────────────────────── browser ─────────────────────────────

function loadPlaywright() {
  const tried = [];
  const candidates = [process.env.ROSE_UI_PLAYWRIGHT_CORE, 'playwright-core', 'playwright'];
  for (const dir of ['/usr/lib/node_modules', '/usr/local/lib/node_modules', path.join(os.homedir(), '.npm-global/lib/node_modules')]) {
    candidates.push(path.join(dir, 'playwright-core'), path.join(dir, 'playwright'));
  }
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (npmRoot) candidates.push(path.join(npmRoot, 'playwright-core'), path.join(npmRoot, 'playwright'));
  } catch { /* npm missing; keep the static candidates */ }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) return mod;
    } catch (err) {
      tried.push(candidate);
    }
  }
  throw new Error(`playwright-core is not installed (tried ${tried.join(', ')}). Install: npm i -g playwright-core && npx playwright-core install --with-deps chromium`);
}

function findChromium() {
  if (process.env.ROSE_UI_CHROMIUM) return process.env.ROSE_UI_CHROMIUM;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    '/ms-playwright',
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const m = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(dir);
      if (!m) continue;
      for (const rel of [
        'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-linux64/chrome', 'chrome-linux/chrome',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-mac/headless_shell', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const exe = path.join(root, dir, rel);
        if (fs.existsSync(exe)) found.push({ exe, rev: Number(m[2]), shell: m[1] === 'chromium_headless_shell' });
      }
    }
  }
  found.sort((a, b) => b.rev - a.rev || Number(b.shell) - Number(a.shell));
  return found.length ? found[0].exe : undefined;
}

async function launchBrowser(opts = {}) {
  const pw = loadPlaywright();
  const args = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'];
  if (!opts.noWebgpu) args.push('--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader');
  if (Array.isArray(opts.args)) args.push(...opts.args);
  try {
    return await pw.chromium.launch({ headless: true, args });
  } catch (err) {
    const exe = findChromium();
    if (!exe) throw new Error(`could not launch Chromium (${err.message.split('\n')[0]}). Install: npx playwright-core install --with-deps chromium`);
    return pw.chromium.launch({ headless: true, args, executablePath: exe });
  }
}

/**
 * Runs in every frame before its scripts (CDP init script, exempt from page CSP).
 * Instruments only user frames on the content origin.
 */
function roseFrameProbe(contentBase) {
  if (window.top === window || !location.href.startsWith(contentBase) || window.__roseProbe) return;
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const probe = { raf: 0, timers: 0, frames: [], sampling: false, windowStart: 0, longTasks: [], shifts: [], errors: [], hidden: false };
  window.__roseProbe = probe;
  window.requestAnimationFrame = function (cb) { return nativeRaf(function (t) { probe.raf++; cb(t); }); };
  const wrapTimer = (native) => function (fn, ms, ...rest) {
    return native(typeof fn === 'function' ? function (...a) { probe.timers++; return fn.apply(this, a); } : fn, ms, ...rest);
  };
  window.setTimeout = wrapTimer(nativeSetTimeout);
  window.setInterval = wrapTimer(nativeSetInterval);
  (function sample(t) { if (probe.sampling && t !== undefined) probe.frames.push(t); nativeRaf(sample); })();
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) probe.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* longtask unsupported */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) probe.shifts.push({ t: e.startTime, v: e.value });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* layout-shift unsupported */ }
  window.addEventListener('error', (e) => probe.errors.push(String(e.message || e.error || 'error')));
  window.addEventListener('unhandledrejection', (e) => probe.errors.push(`unhandled rejection: ${String(e.reason && (e.reason.message || e.reason))}`));
  probe.begin = () => { probe.raf = 0; probe.timers = 0; probe.frames = []; probe.sampling = true; probe.windowStart = performance.now(); };
  probe.setHidden = (hidden) => {
    probe.hidden = hidden;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => probe.hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (probe.hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  probe.snapshot = () => {
    const animations = (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running').map((a) => {
      const frames = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
      const props = new Set();
      for (const k of frames) for (const key of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(key)) props.add(key);
      return { name: a.animationName || a.id || '', properties: [...props] };
    });
    let canvasBytes = 0;
    for (const c of document.querySelectorAll('canvas')) canvasBytes += c.width * c.height * 4 * 2;
    for (const v of document.querySelectorAll('video')) canvasBytes += (v.videoWidth || 0) * (v.videoHeight || 0) * 4 * 2;
    return {
      raf: probe.raf, timers: probe.timers, frames: probe.frames.slice(), windowStart: probe.windowStart, now: performance.now(),
      longTasks: probe.longTasks.map((t) => ({ ...t, phase: t.start >= probe.windowStart && probe.windowStart > 0 ? 'steady' : 'load' })),
      shifts: probe.shifts.slice(), errors: probe.errors.slice(0, 20), animations, gpuMemoryEstimateBytes: canvasBytes,
      dataset: Object.assign({}, document.documentElement.dataset),
    };
  };
}

/** Injected into every dedicated worker as soon as Playwright sees it. */
function roseWorkerProbe() {
  if (self.__roseWorkerProbe) return;
  const p = { raf: 0, timers: 0, frames: [], sampling: false };
  self.__roseWorkerProbe = p;
  if (self.requestAnimationFrame) {
    const native = self.requestAnimationFrame.bind(self);
    self.requestAnimationFrame = (cb) => native((t) => { p.raf++; if (p.sampling) p.frames.push(t); cb(t); });
  }
  for (const name of ['setTimeout', 'setInterval']) {
    const native = self[name].bind(self);
    self[name] = (fn, ms, ...rest) => native(typeof fn === 'function' ? (...a) => { p.timers++; return fn(...a); } : fn, ms, ...rest);
  }
  p.begin = () => { p.raf = 0; p.timers = 0; p.frames = []; p.sampling = true; };
}

async function openHost(browser, preview, route, { viewport, scale = 1, reducedMotion = 'no-preference', probe = false, timeoutMs = 20000 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, reducedMotion });
  const page = await context.newPage();
  const workers = [];
  const bytes = { total: 0, script: 0, media: 0, other: 0, requests: 0 };
  if (probe) {
    await context.addInitScript(roseFrameProbe, preview.contentBase);
    page.on('worker', (worker) => {
      workers.push(worker);
      worker.evaluate(roseWorkerProbe).catch(() => {});
    });
    page.on('requestfinished', async (req) => {
      if (!req.url().startsWith(preview.contentBase)) return;
      const sizes = await req.sizes().catch(() => null);
      const n = sizes ? sizes.responseBodySize : 0;
      const e = ext(new URL(req.url()).pathname);
      bytes.total += n;
      bytes.requests++;
      if (SCRIPT_EXT.has(e)) bytes.script += n;
      else if (MEDIA_EXT.has(e)) bytes.media += n;
      else bytes.other += n;
    });
  }
  await page.goto(`${preview.hostOrigin}${route}`, { waitUntil: 'load', timeout: timeoutMs });
  await page.waitForFunction(() => window.__roseHost && window.__roseHost.settled, null, { timeout: timeoutMs });
  const hostState = await page.evaluate(() => ({ error: window.__roseHost.error || null, frames: window.__roseHost.frames.map((f) => ({ kind: f.kind, name: f.name, src: f.src, loaded: f.loaded, ready: f.ready })) }));
  if (hostState.error) throw new Error(`preview host: ${hostState.error}`);
  return { context, page, workers, bytes, hostState };
}

function userFrames(page, preview) {
  return page.frames().filter((f) => f !== page.mainFrame() && f.url().startsWith(preview.contentBase));
}

async function workerCall(workers, fn) {
  return Promise.all(workers.map((w) => w.evaluate(fn).catch(() => null)));
}

async function measureWindow(page, preview, workers, ms) {
  const frames = userFrames(page, preview);
  await Promise.all(frames.map((f) => f.evaluate(() => window.__roseProbe && window.__roseProbe.begin()).catch(() => {})));
  await workerCall(workers, () => self.__roseWorkerProbe && self.__roseWorkerProbe.begin());
  await sleep(ms);
  const snaps = await Promise.all(frames.map((f) => f.evaluate(() => (window.__roseProbe ? window.__roseProbe.snapshot() : null)).catch(() => null)));
  const workerSnaps = await workerCall(workers, () => (self.__roseWorkerProbe ? { raf: self.__roseWorkerProbe.raf, timers: self.__roseWorkerProbe.timers, frames: self.__roseWorkerProbe.frames.slice() } : null));
  // openHost only appends workers; preserve the registry index before filtering.
  return { frames, snaps, workerSnaps: workerSnaps.map((snapshot, workerIndex) => snapshot && ({ ...snapshot, workerIndex })).filter(Boolean) };
}

async function hostBaseline(browser, preview, viewport) {
  const { context, page, workers } = await openHost(browser, preview, '/__rose/blank', { viewport, probe: true });
  try {
    await sleep(300);
    const { snaps } = await measureWindow(page, preview, workers, 1200);
    return frameStats(snaps[0] ? snaps[0].frames : []);
  } finally {
    await context.close();
  }
}

/**
 * Host CPU counters in clock ticks (Linux /proc): `busy` and `total` over every CPU from
 * /proc/stat, and `own`, the CPU time of rootPid and every descendant (this CLI, the preview
 * server, Playwright and every Chromium process). Reaped children are counted through their
 * parent's cutime/cstime, so a process exiting mid-window keeps its time in the tree.
 * Returns null where /proc is unavailable.
 */
function hostCpuSample(rootPid = process.pid, proc = '/proc') {
  let line;
  try {
    line = fs.readFileSync(`${proc}/stat`, 'utf8').split('\n').find((l) => l.startsWith('cpu '));
  } catch {
    return null;
  }
  if (!line) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  const busy = user + nice + system + irq + softirq + steal;
  const parents = new Map();
  const times = new Map();
  let names;
  try {
    names = fs.readdirSync(proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const stat = fs.readFileSync(`${proc}/${name}/stat`, 'utf8');
      // Fields after the parenthesized command: state ppid ... utime(14) stime cutime cstime.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(name), Number(f[1]));
      times.set(Number(name), Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]));
    } catch { /* exited */ }
  }
  // Without this process's own counters (a /proc from another PID namespace) every CPU tick of
  // the check would read as another process's: no share rather than one that excuses the page.
  if (!times.has(rootPid)) return null;
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parents) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
  }
  let own = 0;
  for (const pid of tree) own += times.get(pid) || 0;
  return { busy, total: busy + idle + iowait, own };
}

/**
 * Shares of the host's CPU time between two hostCpuSample()s: `other` is CPU used by processes
 * outside this check (other jobs, CPU steal), `own` this check's tree, `idle` the rest.
 */
function hostCpuShare(before, after) {
  if (!before || !after) return null;
  const total = after.total - before.total;
  // A tree process reaped outside the tree takes its lifetime CPU out of `own`; a share built on
  // that would count the page's own work as other load, so there is none.
  if (!(total > 0) || after.own < before.own) return null;
  const own = Math.min(after.own - before.own, total);
  const other = Math.min(Math.max(after.busy - before.busy - own, 0), total - own);
  return { other: round(other / total, 3), own: round(own / total, 3), idle: round(1 - (other + own) / total, 3) };
}

/** Runs window() between two host CPU samples; returns [result, share]. */
async function withHostCpu(window) {
  const before = hostCpuSample();
  const result = await window();
  return [result, hostCpuShare(before, hostCpuSample())];
}

/** Trace events that run page script on the main thread, including promise continuations. */
const SCRIPT_EVENTS = new Set(['FunctionCall', 'EvaluateScript', 'v8.evaluateModule', 'v8.callFunction', 'v8.run', 'RunMicrotasks', 'BlinkScheduler_PerformMicrotaskCheckpoint']);

/**
 * Chromium renderer processes descended from rootPid. /proc/<pid>/task/<tid>/children lists only
 * the processes that thread forked, and Chromium launches children from a launcher thread (all of
 * them with --no-zygote), so every thread of every process is followed.
 */
function rendererPids(rootPid, proc = '/proc') {
  const children = (pid) => {
    let tids;
    try {
      tids = fs.readdirSync(`${proc}/${pid}/task`);
    } catch {
      return [];
    }
    const out = [];
    for (const tid of tids) {
      try {
        out.push(...fs.readFileSync(`${proc}/${pid}/task/${tid}/children`, 'utf8').split(/\s+/).filter(Boolean).map(Number));
      } catch { /* thread exited */ }
    }
    return out;
  };
  const found = [];
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...children(pid));
    try {
      if (fs.readFileSync(`${proc}/${pid}/cmdline`, 'utf8').includes('--type=renderer')) found.push(pid);
    } catch { /* exited */ }
  }
  return found;
}

/**
 * Samples the scheduler state of every Chromium renderer main thread under this process
 * (Linux /proc) every ~2 ms, on the trace clock (CLOCK_MONOTONIC, microseconds). Returns
 * { stop() → samples[] | null }; null where /proc is unavailable.
 */
function startThreadSampler() {
  if (process.platform !== 'linux' || !fs.existsSync(`/proc/${process.pid}/task/${process.pid}/children`)) return { stop: () => null };
  const renderers = rendererPids(process.pid);
  const samples = [];
  const sample = () => {
    const t = Number(process.hrtime.bigint() / 1000n);
    for (const pid of renderers) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
        samples.push({ pid, t, state: stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) });
      } catch { /* exited */ }
    }
  };
  sample();
  const timer = setInterval(sample, 2);
  return { stop: () => { clearInterval(timer); sample(); return renderers.length ? samples : null; } };
}

/**
 * Renderer main-thread tasks longer than minMs (wall) in a Chromium trace, with the CPU time
 * the thread spent in each and, when thread samples exist, `pageWait`: time the thread slept
 * voluntarily (state S) while page script was on its stack, i.e. blocked in a call the page
 * made (sync XHR, GPU readback). A host stall is involuntary: runnable but descheduled (R),
 * in a page fault (D) or stopped (T). pageWait is null when the samples do not cover the task.
 */
function traceMainThreadTasks(buf, minMs, samples = null) {
  const events = JSON.parse(buf.toString('utf8')).traceEvents || [];
  const main = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`));
  const onMain = (e) => e.ph === 'X' && main.has(`${e.pid}:${e.tid}`);
  const tasks = events.filter((e) => onMain(e) && e.name === 'ThreadControllerImpl::RunTask');
  if (tasks.length === 0) throw new Error('trace recorded no renderer main-thread tasks');
  const scripts = events.filter((e) => onMain(e) && SCRIPT_EVENTS.has(e.name));
  return tasks
    .filter((e) => e.dur > minMs * 1000)
    .map((e) => {
      if (typeof e.tdur !== 'number') throw new Error('trace has no thread CPU time for main-thread tasks');
      const end = e.ts + e.dur;
      const inScript = (t) => scripts.some((x) => x.pid === e.pid && x.tid === e.tid && x.ts <= t && t < x.ts + x.dur && x.ts >= e.ts && x.ts < end);
      const own = (samples || []).filter((x) => x.pid === e.pid && x.t >= e.ts && x.t <= end).sort((a, b) => a.t - b.t);
      let pageWait = null;
      // Covered when samples bracket the task closely (no gap over 10 ms at either end).
      if (own.length >= 2 && own[0].t - e.ts <= 10000 && end - own[own.length - 1].t <= 10000) {
        const page = (x) => x.state === 'S' && inScript(x.t);
        let us = 0;
        for (let i = 0; i + 1 < own.length; i++) {
          const gap = own[i + 1].t - own[i].t;
          // A sampler gap (the host froze the sampler too) is host time unless both ends saw a page wait.
          if (page(own[i]) && (gap <= 10000 || page(own[i + 1]))) us += gap;
        }
        pageWait = round(us / 1000);
      }
      return { phase: 'steady', duration: round(e.dur / 1000), cpu: round(e.tdur / 1000), pageWait };
    });
}

/** measureWindow under a Chromium trace; adds the window's long main-thread tasks with CPU time. */
async function tracedWindow(browser, page, preview, workers, ms) {
  await browser.startTracing(undefined, { categories: ['-*', 'toplevel', 'devtools.timeline', 'v8.execute'] });
  const sampler = startThreadSampler();
  let win;
  let trace;
  let samples;
  try {
    win = await measureWindow(page, preview, workers, ms);
  } finally {
    samples = sampler.stop();
    trace = await browser.stopTracing();
  }
  return { ...win, tasks: traceMainThreadTasks(trace, DEFAULT_BUDGETS.longTaskMaxMs, samples) };
}

/** Normal + hidden + reduced-motion measurements of one route (one user frame). */
async function measureRoute(browser, preview, route, opts) {
  const viewport = opts.viewport;
  const result = {};
  const run = await openHost(browser, preview, route, { viewport, probe: true });
  try {
    await sleep(opts.settleMs);
    const [normal, normalCpu] = await withHostCpu(() => tracedWindow(browser, run.page, preview, run.workers, opts.seconds * 1000));
    const hostCpu = [normalCpu];
    const snap = normal.snaps.find(Boolean);
    if (!snap) throw new Error(`no user frame measured on ${route}`);
    let longTaskRecheck;
    const limit = DEFAULT_BUDGETS.longTaskMaxMs;
    if (opts.recheckLongTasks && normal.tasks.length > 0 && normal.tasks.every((t) => typeof t.pageWait === 'number' && t.cpu + t.pageWait <= limit)) {
      // Long only in wall time: a one-off host stall does not recur, a page's blocking wait does.
      longTaskRecheck = (await tracedWindow(browser, run.page, preview, run.workers, opts.seconds * 1000)).tasks;
    }
    let fps = frameStats(snap.frames);
    const workerMeasurement = (w) => ({ workerIndex: w.workerIndex, fps: frameStats(w.frames), callbacks: w.raf + w.timers });
    let workers = normal.workerSnaps.map(workerMeasurement);
    const missesFps = (s) => s.frames >= 10 && s.p50 !== null && (s.p50 < DEFAULT_BUDGETS.fpsP50Min || s.p5 < DEFAULT_BUDGETS.fpsP5Min);
    const eligibleFps = (s) => s.frames >= 10 && Number.isFinite(s.p50) && Number.isFinite(s.p5);
    // A window that meets the fps budget beats one that misses it; among windows with the
    // same verdict, higher p5 then higher p50 wins.
    const betterFps = (next, first) => {
      if (!eligibleFps(next)) return false;
      if (!eligibleFps(first)) return true;
      if (missesFps(next) !== missesFps(first)) return !missesFps(next);
      return next.p5 > first.p5 || (next.p5 === first.p5 && next.p50 > first.p50);
    };
    let fpsWindows = 1;
    if (opts.retryFps && [fps, ...workers.map((w) => w.fps)].some(missesFps)) {
      // Host noise (other processes, a software GPU) can cost a window; judge fps on
      // the better of two windows. Other rules keep the first window's evidence.
      const [again, againCpu] = await withHostCpu(() => measureWindow(run.page, preview, run.workers, opts.seconds * 1000));
      hostCpu.push(againCpu);
      const snap2 = again.snaps.find(Boolean);
      fpsWindows = 2;
      if (snap2) {
        const fps2 = frameStats(snap2.frames);
        result.firstWindowFps = fps;
        if (betterFps(fps2, fps)) fps = fps2;
        const workers2 = new Map(again.workerSnaps.filter((w) => Number.isInteger(w.workerIndex)).map((w) => [w.workerIndex, workerMeasurement(w)]));
        workers = workers.map((w) => {
          const next = Number.isInteger(w.workerIndex) ? workers2.get(w.workerIndex) : undefined;
          return next && betterFps(next.fps, w.fps) ? next : w;
        });
      }
    }
    result.normal = {
      fps,
      fpsWindows,
      hostCpu,
      workers: workers.map((w) => ({ fps: w.fps, callbacks: w.callbacks })),
      longTasks: [...snap.longTasks.filter((t) => t.phase === 'load').map((t) => ({ phase: t.phase, duration: round(t.duration) })), ...normal.tasks],
      ...(longTaskRecheck ? { longTaskRecheck } : {}),
      cls: round(cumulativeLayoutShift(snap.shifts), 4),
      errors: snap.errors,
      animations: snap.animations,
      bytes: { ...run.bytes },
      gpuMemoryEstimateBytes: snap.gpuMemoryEstimateBytes,
      dataset: snap.dataset,
      callbacksPerSec: round(((snap.raf + snap.timers) * 1000) / (opts.seconds * 1000)),
    };
    if (opts.hidden !== false) {
      await Promise.all(normal.frames.map((f) => f.evaluate(() => window.__roseProbe && window.__roseProbe.setHidden(true)).catch(() => {})));
      await sleep(300);
      const hiddenMs = 1500;
      const hidden = await measureWindow(run.page, preview, run.workers, hiddenMs);
      const h = hidden.snaps.find(Boolean);
      result.hidden = {
        callbacksPerSec: h ? round(((h.raf + h.timers) * 1000) / hiddenMs) : null,
        workers: hidden.workerSnaps.map((w) => ({ callbacksPerSec: round(((w.raf + w.timers) * 1000) / hiddenMs) })),
      };
    }
  } finally {
    await run.context.close();
  }
  if (opts.reducedMotion !== false) {
    const rm = await openHost(browser, preview, route, { viewport, reducedMotion: 'reduce', probe: true });
    try {
      await sleep(opts.settleMs);
      // Continuous motion changes pixels in every interval; a discrete data update
      // (a clock tick, a new row) changes at most one, so the median ignores it.
      const shots = [];
      for (let i = 0; i < 4; i++) {
        if (i > 0) await sleep(400);
        shots.push(decodePng(await rm.page.screenshot({ type: 'png' })));
      }
      const intervals = [1, 2, 3].map((i) => diffFraction(shots[i - 1], shots[i]));
      const median = intervals.slice().sort((x, y) => x - y)[1];
      result.reducedMotion = { changedFraction: round(median, 5), intervals: intervals.map((d) => round(d, 5)) };
    } finally {
      await rm.context.close();
    }
  }
  return result;
}

// ───────────────────────────── commands ─────────────────────────────

function out(opts, human, json) {
  if (opts.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  else if (!opts.quiet) process.stdout.write(`${human}\n`);
}

async function withPreview(opts, fn) {
  const root = uiRoot();
  const preview = await startPreview({ root, published: Boolean(opts.published) });
  let browser;
  try {
    browser = await launchBrowser({ noWebgpu: Boolean(opts['no-webgpu']) });
    return await fn(preview, browser, root);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await preview.close();
  }
}

async function captureScreenshot(browser, preview, { route, viewport, scale, outPath, settleMs }) {
  const run = await openHost(browser, preview, route, { viewport, scale });
  try {
    await sleep(settleMs);
    const png = await run.page.screenshot({ type: 'png' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, png);
    return { path: outPath, route, viewport, scale, frames: run.hostState.frames, stats: pngStats(decodePng(png)) };
  } finally {
    await run.context.close();
  }
}

async function cmdScreenshot(opts) {
  if (opts.current) return captureCurrentLocked({ quiet: opts.quiet, json: opts.json }, { waitIfBusy: true });
  const route = normalizeRoute(opts.route);
  const viewport = parseViewport(opts.viewport, { width: 1440, height: 900 });
  const scale = numberFlag(opts.scale, 2, 'scale', { min: 0.5, max: 4 });
  const settleMs = numberFlag(opts.wait, 800, 'wait', { max: 30000 });
  const root = uiRoot();
  const outPath = path.resolve(typeof opts.out === 'string' ? opts.out : path.join(root, 'screenshots', `${routeSlug(route)}-${viewport.width}x${viewport.height}@${scale}x.png`));
  const shot = await withPreview(opts, (preview, browser) => captureScreenshot(browser, preview, { route, viewport, scale, outPath, settleMs }));
  out(opts, `${shot.path} (${shot.stats.width}x${shot.stats.height}${shot.stats.nonBlank ? '' : ', looks blank'}; ${shot.frames.length} user frame(s))`, shot);
  return 0;
}

async function captureCurrent({ quiet, json } = {}) {
  const root = uiRoot();
  const dir = path.join(root, 'screenshots', 'current');
  fs.mkdirSync(dir, { recursive: true });
  const versionId = process.env.ROSE_UI_PUBLISHED_VERSION_ID || null;
  const index = { versionId, publishedBaseUrl: publishedBaseUrl(), capturedAt: new Date().toISOString(), host: 'rose-ui preview host', files: [] };
  if (!index.publishedBaseUrl) {
    index.note = 'The user has no published Rose app UI version; they see the stock Rose UI.';
    fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    out({ quiet, json }, index.note, index);
    return 0;
  }
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) fs.rmSync(path.join(dir, f));
  await withPreview({ published: true }, async (preview, browser) => {
    for (const r of CURRENT_ROUTES) {
      for (const v of CURRENT_VIEWPORTS) {
        const file = path.join(dir, `${r.name}-${v.name}.png`);
        const shot = await captureScreenshot(browser, preview, { route: r.route, viewport: { width: v.width, height: v.height }, scale: v.scale, outPath: file, settleMs: 1000 });
        index.files.push({ path: path.relative(root, file), route: r.route, viewport: `${v.width}x${v.height}`, scale: v.scale, pixels: `${shot.stats.width}x${shot.stats.height}` });
      }
    }
  });
  fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  out({ quiet, json }, `captured ${index.files.length} screenshots of published version ${versionId} → ${path.relative(process.cwd(), dir) || dir}`, index);
  return 0;
}

/** O_EXCL lock file; a lock older than 2 minutes belongs to a dead capture. */
function takeLock(lock) {
  try {
    fs.closeSync(fs.openSync(lock, 'wx'));
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < 120000) return false;
    } catch { /* vanished between calls */ }
    fs.rmSync(lock, { force: true });
    try { fs.closeSync(fs.openSync(lock, 'wx')); return true; } catch { return false; }
  }
}

/**
 * One capture of screenshots/current/ at a time: `screenshot --current` waits for
 * a concurrent capture to finish and then captures again. Returns null when skipped.
 */
async function captureCurrentLocked(opts, { waitIfBusy }) {
  const dir = path.join(uiRoot(), 'screenshots', 'current');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.capturing');
  if (!takeLock(lock)) {
    if (!waitIfBusy) return null;
    for (let i = 0; i < 120 && fs.existsSync(lock); i++) await sleep(1000);
    if (!takeLock(lock)) throw new Error('another capture holds screenshots/current/.capturing');
  }
  try {
    return await captureCurrent(opts);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

async function composeStrip(browser, frames, outPath) {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  try {
    const dataUrl = await page.evaluate(async (items) => {
      const imgs = await Promise.all(items.map((f) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ img, t: f.t });
        img.onerror = reject;
        img.src = `data:image/jpeg;base64,${f.data}`;
      })));
      const w = 360;
      const h = Math.round((imgs[0].img.naturalHeight / imgs[0].img.naturalWidth) * w);
      const canvas = document.createElement('canvas');
      canvas.width = w * imgs.length;
      canvas.height = h + 24;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '14px sans-serif';
      imgs.forEach(({ img, t }, i) => {
        ctx.drawImage(img, i * w, 24, w, h);
        ctx.fillStyle = '#eee';
        ctx.fillText(`t=${t.toFixed(2)}s`, i * w + 6, 17);
      });
      return canvas.toDataURL('image/png');
    }, frames);
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await page.close();
  }
}

function findFfmpeg() {
  const candidates = [process.env.ROSE_UI_FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const exe of candidates) {
    const probe = spawnSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status === 0) return { exe, h264: /libx264/.test(probe.stdout) };
  }
  return null;
}

async function cmdRecord(opts) {
  const route = normalizeRoute(opts.route);
  const seconds = numberFlag(opts.seconds, 5, 'seconds', { min: 1, max: 60 });
  const viewport = parseViewport(opts.viewport, { width: 1280, height: 800 });
  const root = uiRoot();
  const outPath = path.resolve(typeof opts.out === 'string' ? opts.out : path.join(root, 'screenshots', `record-${routeSlug(route)}.mp4`));
  const stripPath = outPath.replace(/\.[a-z0-9]+$/i, '') + '-strip.png';
  const result = await withPreview(opts, async (preview, browser) => {
    const run = await openHost(browser, preview, route, { viewport, scale: 1 });
    const frames = [];
    try {
      await sleep(numberFlag(opts.wait, 500, 'wait', { max: 30000 }));
      const cdp = await run.context.newCDPSession(run.page);
      cdp.on('Page.screencastFrame', (f) => {
        frames.push({ t: f.metadata.timestamp, data: f.data });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      const started = Date.now() / 1000;
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
      await sleep(seconds * 1000);
      await cdp.send('Page.stopScreencast');
      if (frames.length === 0) throw new Error('no frames captured');
      const t0 = frames[0].t;
      const end = Math.max(frames[frames.length - 1].t, t0 + seconds, started + seconds);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-ui-record-'));
      try {
        const list = [];
        frames.forEach((f, i) => {
          const name = `f${String(i).padStart(5, '0')}.jpg`;
          fs.writeFileSync(path.join(tmp, name), Buffer.from(f.data, 'base64'));
          const next = i + 1 < frames.length ? frames[i + 1].t : end;
          list.push(`file '${name}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
        });
        list.push(`file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'`);
        fs.writeFileSync(path.join(tmp, 'list.txt'), `${list.join('\n')}\n`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const picks = [];
        const count = Math.min(8, frames.length);
        for (let i = 0; i < count; i++) {
          const target = t0 + ((end - t0) * i) / Math.max(1, count - 1);
          let best = frames[0];
          for (const f of frames) if (f.t <= target) best = f;
          picks.push({ t: best.t - t0, data: best.data });
        }
        await composeStrip(browser, picks, stripPath);
        const ffmpeg = findFfmpeg();
        let video = null;
        if (ffmpeg) {
          const codec = ffmpeg.h264 ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'] : ['-c:v', 'mpeg4', '-q:v', '4'];
          const enc = spawnSync(ffmpeg.exe, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-vf', 'fps=60,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', ...codec, '-movflags', '+faststart', outPath], { encoding: 'utf8' });
          if (enc.status !== 0) throw new Error(`ffmpeg failed: ${enc.stderr.slice(0, 400)}`);
          video = outPath;
        }
        return { video, strip: stripPath, route, seconds, capturedFrames: frames.length, captureFps: round(frames.length / seconds), note: video ? undefined : 'ffmpeg not found: wrote the frame strip only' };
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      await run.context.close();
    }
  });
  out(opts, `${result.video || '(no video: ffmpeg missing)'}\n${result.strip}\ncaptured ${result.capturedFrames} frames in ${seconds}s (${result.captureFps} fps capture; the capture rate is not the render rate, use rose-ui perf for fps)`, result);
  return 0;
}

function hostLoad() {
  const cpus = Math.max(1, os.cpus().length);
  return { cpus, loadPerCore: round(os.loadavg()[0] / cpus, 2) };
}

function perfOpts(opts) {
  return {
    viewport: parseViewport(opts.viewport, { width: 1280, height: 800 }),
    seconds: numberFlag(opts.seconds, 3, 'seconds', { min: 1, max: 30 }),
    settleMs: numberFlag(opts.wait, 1000, 'wait', { max: 30000 }),
  };
}

function fileRoute(entry) {
  return `/file/${entry.split('/').map(encodeURIComponent).join('/')}`;
}

async function cmdPerf(opts) {
  const p = perfOpts(opts);
  const target = typeof opts.entry === 'string' ? fileRoute(opts.entry) : normalizeRoute(opts.route);
  const result = await withPreview(opts, async (preview, browser) => {
    const measured = await measureRoute(browser, preview, target, { ...p, hidden: Boolean(opts.full), reducedMotion: Boolean(opts.full) });
    return { target, viewport: p.viewport, seconds: p.seconds, host: hostLoad(), ...measured };
  });
  if (typeof opts.out === 'string') fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function cmdCheck(opts) {
  const root = uiRoot();
  const p = perfOpts({ ...opts, seconds: opts.seconds || 2 });
  const { manifest, theme } = readLocalManifest(root);
  const files = listFiles(root).map((f) => ({ ...f, text: readTextForAudit(f) }));
  const targets = opts._.length > 0 ? opts._.map((entry) => ({ kind: 'file', name: entry, entry })) : manifestEntries(manifest);
  if (opts.examples) {
    for (const f of files) if (/^examples\/[^/]+\/index\.html$/.test(f.path)) targets.push({ kind: 'example', name: f.path.split('/')[1], entry: f.path });
  }
  for (const t of targets) if (!files.some((f) => f.path === t.entry)) throw new UsageError(`${t.entry} is not a file in ${root}`);
  const report = { root, budgets: DEFAULT_BUDGETS, theme: lintTheme(theme), entries: [] };
  if (targets.length > 0) {
    await withPreview(opts, async (preview, browser) => {
      const baseline = await hostBaseline(browser, preview, p.viewport);
      report.hostBaseline = baseline;
      for (const t of targets) {
        const entryResult = { ...t, static: auditEntryFiles(t.entry, files), hostBaseline: baseline };
        entryResult.host = hostLoad();
        try {
          Object.assign(entryResult, await measureRoute(browser, preview, fileRoute(t.entry), { ...p, retryFps: true, recheckLongTasks: true }));
        } catch (err) {
          entryResult.static.violations.push({ rule: 'measure-failed', message: err.message.split('\n')[0] });
        }
        entryResult.verdict = evaluateBudgets(entryResult);
        report.entries.push(entryResult);
        if (!opts.json && !opts.quiet) printEntry(entryResult);
      }
    });
  }
  const themeFail = report.theme.length > 0;
  report.pass = !themeFail && report.entries.every((e) => e.verdict.pass);
  if (typeof opts.out === 'string') fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (!opts.quiet) {
    for (const v of report.theme) process.stdout.write(`  FAIL theme: ${v.message}\n`);
    process.stdout.write(`${report.pass ? 'PASS' : 'FAIL'}: ${report.entries.filter((e) => e.verdict.pass).length}/${report.entries.length} entries within budget${themeFail ? '; theme has errors' : ''}\n`);
  }
  return report.pass ? 0 : 1;
}

function printEntry(e) {
  const n = e.normal || {};
  const fps = n.fps && n.fps.p50 !== null ? `${n.fps.p50}/${n.fps.p5} fps p50/p5` : 'fps n/a';
  const w = (n.workers || []).filter((x) => x.fps.frames >= 10).map((x) => `worker ${x.fps.p50}/${x.fps.p5}`).join(', ');
  process.stdout.write(`${e.verdict.pass ? 'PASS' : 'FAIL'} ${e.kind} ${e.name} (${e.entry}): ${fps}${w ? `, ${w}` : ''}, CLS ${n.cls ?? 'n/a'}, ${fmtBytes(e.static.totalBytes)}\n`);
  for (const v of e.verdict.violations) process.stdout.write(`    ✗ ${v.rule}: ${v.message}\n`);
  for (const v of e.verdict.warnings) process.stdout.write(`    ! ${v.rule}: ${v.message}\n`);
}

async function cmdDev(opts) {
  const port = numberFlag(opts.port, 5170, 'port', { min: 1, max: 65534 });
  const preview = await startPreview({ root: uiRoot(), published: Boolean(opts.published), bind: '0.0.0.0', hostPort: port, contentPort: opts.published ? 0 : port + 1, live: true });
  const sandbox = process.env.E2B_SANDBOX_ID;
  process.stdout.write(`rose-ui dev: preview host on http://localhost:${preview.hostPort}/  (routes: / /agent /inline/<view> /slot/<name> /shell /file/<path>)\n`);
  if (!opts.published) process.stdout.write(`your files are served from a separate origin on port ${preview.contentPort} with the production CSP\n`);
  if (sandbox) process.stdout.write(`public URL: https://${preview.hostPort}-${sandbox}.e2b.app/ (content: https://${preview.contentPort}-${sandbox}.e2b.app/)\n`);
  process.stdout.write('the page reloads when files change; Ctrl+C to stop\n');
  await new Promise((resolve) => process.once('SIGINT', resolve));
  await preview.close();
  return 0;
}

function collect(root) {
  const files = [];
  let total = 0;
  for (const f of listFiles(root)) {
    if (f.size > MAX_FILE) throw new Error(`${f.path} is larger than 10 MB`);
    total += f.size;
    files.push({ path: f.path, contentBase64: fs.readFileSync(f.abs).toString('base64') });
  }
  if (files.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
  if (total > MAX_TOTAL) throw new Error('bundle is larger than 50 MB');
  return { files, total };
}

/**
 * Write the user's published bundle (or the starting bundle) into a folder.
 * Refuses to overwrite a folder that already has bundle files unless --force;
 * with --force, bundle files missing from the published version are removed.
 * screenshots/ and dotfiles are left alone.
 */
async function cmdPull(opts) {
  const publishUrl = process.env.ROSE_UI_PUBLISH_URL || '';
  const url = process.env.ROSE_UI_BUNDLE_URL || publishUrl.replace(/\/versions\/?$/, '/bundle');
  const token = process.env.ROSE_UI_PUBLISH_TOKEN;
  if (!url || !token) throw new Error('ROSE_UI_BUNDLE_URL and ROSE_UI_PUBLISH_TOKEN must be set (they are injected into Rose code sessions)');
  // --force and --json take no value: `pull --force <dir>` still names the folder.
  const positional = [...opts._];
  for (const flag of ['force', 'json']) {
    if (typeof opts[flag] === 'string') positional.push(opts[flag]);
  }
  const force = opts.force !== undefined;
  const named = positional[0] || dirFlag || process.env.ROSE_UI_DIR;
  const target = path.resolve(named || path.join(os.homedir(), DEFAULT_DIR_NAME));
  const existing = fs.existsSync(target) ? listFiles(target) : [];
  if (existing.length > 0 && !force) {
    throw new UsageError(`${target} already has ${existing.length} bundle file(s); pass --force to replace them with the published version`);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 500) }; }
  if (!res.ok) {
    process.stderr.write(`pull failed (${res.status}): ${body.error || text}\n`);
    return 1;
  }
  const files = Array.isArray(body.files) ? body.files : [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !isPublishablePath(f.path) || typeof f.contentBase64 !== 'string') {
      throw new Error(`refusing to write bundle entry ${f && f.path}`);
    }
  }
  fs.mkdirSync(target, { recursive: true });
  const incoming = new Set(files.map((f) => f.path));
  for (const f of existing) if (!incoming.has(f.path)) fs.rmSync(f.abs, { force: true });
  let total = 0;
  for (const f of files) {
    const abs = path.join(target, f.path);
    const content = Buffer.from(f.contentBase64, 'base64');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    total += content.length;
  }
  const record = { versionId: body.versionId || null, source: body.source || null, pulledAt: new Date().toISOString(), files: files.length, bytes: total, dir: target };
  fs.writeFileSync(path.join(target, PULL_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  fs.mkdirSync(path.dirname(PULLED_DIR_FILE()), { recursive: true });
  fs.writeFileSync(PULLED_DIR_FILE(), `${target}\n`);
  const human = record.versionId
    ? `pulled published version ${record.versionId} (${files.length} files, ${fmtBytes(total)}) → ${target}`
    : `the user has no published UI yet; wrote the starting bundle (${files.length} files) → ${target}`;
  out({ ...opts, json: opts.json !== undefined }, human, record);
  return 0;
}

async function cmdPublish(opts) {
  const activate = !opts['no-activate'];
  const url = process.env.ROSE_UI_PUBLISH_URL;
  const token = process.env.ROSE_UI_PUBLISH_TOKEN;
  if (!url || !token) throw new Error('ROSE_UI_PUBLISH_URL and ROSE_UI_PUBLISH_TOKEN must be set (they are injected into Rose code sessions)');
  const root = uiRoot();
  if (!fs.existsSync(path.join(root, 'rose-ui.json'))) throw new Error(`no rose-ui.json in ${root}`);
  const { files, total } = collect(root);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ files, activate }) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!res.ok) {
    process.stderr.write(`publish failed (${res.status}): ${body.error || text}\n`);
    for (const detail of body.details || []) process.stderr.write(`  - ${detail}\n`);
    return 1;
  }
  process.stdout.write(`published version ${body.versionId} (${files.length} files, ${total} bytes)${activate ? ' — now active for the user' : ' — not activated'}\n`);
  return 0;
}

const USAGE = `usage: rose-ui <command> [options] [--dir <dir>]

  pull [<dir>] [--force] [--json]      the user's published bundle (or a starting bundle) into <dir>
                                       (default ~/rose_user_ui); later commands use that folder
  publish [--no-activate]              publish the folder (and show it to the user)
  dev [--port 5170] [--published]      live preview host for your local, unpublished files
  screenshot [--route /] [--viewport 1440x900] [--scale 2] [--out file.png] [--published] [--json]
  screenshot --current                 capture the user's published UI into screenshots/current/
  record [--route /] [--seconds 5] [--viewport 1280x800] [--out file.mp4]   MP4 + frame strip
  perf [--entry path.html | --route /] [--seconds 3] [--viewport 1280x800] [--full] [--out file.json]
                                       (--route measures the route's first user frame; --full adds hidden + reduced-motion)
  check [entry.html ...] [--examples] [--json] [--out report.json]   exits 1 on budget violations

routes: / (home)  /agent  /inline/<view>  /slot/<name>  /shell  /file/<path>   add ?safe=1 for stock UI
the folder: --dir, then $ROSE_UI_DIR, then the last pulled folder, then ~/rose_user_ui`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  if (cmd === undefined || cmd === '--help' || cmd === 'help' || opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return cmd === undefined || cmd === '--help' || cmd === 'help' || opts.help ? 0 : 1;
  }
  if (cmd === '--version') { process.stdout.write(`${CLI_VERSION}\n`); return 0; }
  if (opts.dir === true) throw new UsageError('--dir needs a folder');
  dirFlag = typeof opts.dir === 'string' ? opts.dir : null;
  if (cmd === 'pull') return cmdPull(opts);
  if (cmd === 'publish') return cmdPublish(opts);
  const commands = { dev: cmdDev, screenshot: cmdScreenshot, record: cmdRecord, perf: cmdPerf, check: cmdCheck };
  if (!commands[cmd]) { process.stderr.write(`${USAGE}\n`); return 1; }
  return commands[cmd](opts);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stderr.write(`rose-ui: ${err instanceof UsageError ? err.message : err.stack || err.message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}

module.exports = {
  CLI_VERSION, USERCONTENT_CSP, DEFAULT_BUDGETS, CURRENT_VIEWPORTS, CURRENT_ROUTES, LOCAL_ONLY_DIRS, USAGE,
  parseArgs, parseViewport, routeSlug, isPublishablePath, listFiles, manifestEntries, lintTheme,
  auditEntryFiles, frameStats, cumulativeLayoutShift, evaluateBudgets, traceMainThreadTasks, rendererPids, hostCpuSample, hostCpuShare, decodePng, pngStats, diffFraction, startPreview, launchBrowser, main,
};
