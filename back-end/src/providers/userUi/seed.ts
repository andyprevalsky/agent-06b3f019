/**
 * Seed contents for a code agent's `~/rose_user_ui/` folder and the `rose-ui`
 * CLI installed on the session PATH. Kept as string constants so the compiled
 * backend (tsc → dist) ships them without an asset-copy step.
 *
 * README text is user/agent-facing instructions (prompt-scoped, CLAUDE.md
 * rule 26): changes need fresh approval.
 */
import type { UserUiBundleFile } from './manifest';

export const USER_UI_DIR_NAME = 'rose_user_ui';
export const USER_UI_CLI_NAME = 'rose-ui';
/** Bumped whenever the README or CLI contract changes. */
export const USER_UI_CLI_VERSION = '2';

export const USER_UI_README = `# rose_user_ui — your user's Rose app

Everything in this folder is the Rose app UI for ONE user (the user you are
working for). When you run \`rose-ui publish\`, the folder becomes a new immutable
version and — unless you pass \`--no-activate\` — the user sees it immediately.
Publish when the user should see the change, the same way you would merge.
Rollback = publish/activate an earlier version.

## Layout

    rose_user_ui/
      README.md        this file (regenerated every session)
      rose-ui.json     manifest (required) — see "Manifest" below
      root/
        theme.json     CSS tokens + background (data only, no code)
        shell/         optional full-viewport shell ("OS mode")
        slots/<slot>/  widgets mounted into named host slots
        assets/        images, gifs, video, fonts
      inline/<view>/   views rendered inline in the chat trajectory
      tools/<tool>/    tools for this user's agent (tool.json + handler)
      examples/        reference implementations (not published unless referenced)

Files and folders whose name starts with "." and any node_modules/ are never
published. Limits: 10 MB per file, 50 MB total, 2000 files.

## Manifest (rose-ui.json)

    {
      "version": 1,
      "theme": "root/theme.json",
      "shell": { "entry": "root/shell/index.html" },
      "slots": {
        "background":     { "entry": "root/slots/background/index.html" },
        "sidebar.header": { "entry": "..." },
        "menu":           { "entry": "..." },
        "home.dashboard": { "entry": "..." },
        "agent.panel":    { "entry": "..." }
      },
      "inline": {
        "<view-name>": { "entry": "inline/<view-name>/index.html",
                         "summary": "one line describing the view",
                         "poster": "inline/<view-name>/poster.png" }
      },
      "tools": { "<tool_name>": { "manifest": "tools/<tool_name>/tool.json" } },
      "capabilities": ["read", "subscribe", "navigate", "create_agent", "send_message"]
    }

Every key except "version" is optional. Paths are relative to this folder (no
"/" prefix, no ".."). Every referenced path must exist or publishing fails.
View names match [a-z0-9-]+; tool names match [a-z0-9_]+.

theme.json:

    {
      "tokens": { "--primary": "#7c3aed", "--radius": "14px" },
      "background": { "image": "root/assets/wallpaper.jpg", "fadeAfterFirstMessage": 0.2 }
    }

Token names are CSS custom properties; values are plain CSS values (no url(),
no ";", "{", "}" or markup). fadeAfterFirstMessage is the chat pane opacity
(0..1, default 0.2) once the first message is sent.

## How your code runs

Every entry is an HTML page loaded in a sandboxed cross-origin iframe
(sandbox="allow-scripts", strict CSP). It cannot read the Rose session or call
the Rose API directly; it talks to the host with postMessage:

From your view to the host (window.parent.postMessage(msg, "*")):
  { type: "rose:ready" }                  you are initialised
  { type: "rose:resize", height: <px> }   your content height (inline views)

From the host to your view (window.addEventListener("message", ...)):
  { type: "rose:props", props: {...} }    inline view props from the message

Inline views: an agent shows one in the chat with
send_message_to_user(message, inline_view={ view: "<view-name>", props: {...} }).
The message pins the published version, so later publishes never change old
messages. Keep props small JSON.

## Something for the user to see or play

Build a game, app, chart or other visual the user asked to see as an inline
view: write inline/<view-name>/index.html (scripts and data in the bundle; the
CSP blocks external scripts and fetches), add it under "inline" in rose-ui.json
with a one-line summary, run \`rose-ui publish\`, then name the view in your
final response. If you cannot call send_message_to_user yourself, the agent
that spawned you shows it.

## Tools for the user's agent

tools/<tool_name>/tool.json:

    {
      "name": "<tool_name>",
      "description": "one sentence the agent reads to decide when to call it",
      "input_schema": { "type": "object", "properties": { ... } },
      "output_schema": { ... },              optional; results are validated
      "render": { "view": "<view-name>" },   optional; result becomes that inline view's props
      "side_effects": false,                 v1 supports read-only tools only
      "timeout_s": 60,                       default 60, max 300
      "runtime": "node",                     or "python"
      "entry": "tools/<tool_name>/handler.js",
      "files": ["lib.js"]                    optional extra files, relative to tools/<tool_name>/
    }

The handler reads one JSON object (the input) on stdin and writes one JSON
object on stdout. A non-zero exit is reported to the agent as a tool error.
It runs with no secrets in its environment and a 256 KB output cap. After
publishing, the user's next root-agent run can call it as user__<tool_name>.

## Performance rules (enforced in review)

- Target 60 fps, 120 fps on ProMotion displays; no main-thread task > 50 ms.
- Render canvases at devicePixelRatio (clamp to 2–3 for heavy shaders).
- Animate only compositor properties (transform, opacity, filter); never
  animate layout (width, height, top, left, margin).
- Respect prefers-reduced-motion and prefers-reduced-transparency.
- Stop animation loops when hidden (document.visibilitychange) or offscreen.
- Lazy-load and size media; prefer AVIF/WebP and MP4/WebM over large GIFs.

## Commands

    rose-ui publish                 publish this folder and show it to the user
    rose-ui publish --no-activate   publish a version without showing it yet

See examples/ for an inline view (examples/inline-hello) and a WebGL2 shader
background (examples/shader-background).
`;

export const USER_UI_SEED_MANIFEST = `${JSON.stringify({ version: 1, theme: 'root/theme.json' }, null, 2)}\n`;
export const USER_UI_SEED_THEME = '{}\n';

export const USER_UI_EXAMPLE_INLINE_HELLO = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>inline-hello</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 0; padding: 16px; }
  .card { border-radius: 14px; padding: 16px; background: color-mix(in srgb, CanvasText 6%, Canvas); }
  .count { font-size: 32px; font-weight: 600; transition: transform 160ms ease-out; }
  @media (prefers-reduced-motion: reduce) { .count { transition: none; } }
</style>
</head>
<body>
<div class="card">
  <div>Hello, <span id="name">there</span>!</div>
  <div class="count" id="count">0</div>
  <button id="bump" type="button">+1</button>
</div>
<script>
  // Host → view: { type: 'rose:props', props }. View → host: rose:ready, rose:resize.
  const nameEl = document.getElementById('name');
  const countEl = document.getElementById('count');
  let count = 0;
  function reportHeight() {
    window.parent.postMessage({ type: 'rose:resize', height: Math.ceil(document.documentElement.scrollHeight) }, '*');
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'rose:props') return;
    const props = msg.props || {};
    if (typeof props.name === 'string') nameEl.textContent = props.name;
    if (typeof props.start === 'number') { count = props.start; countEl.textContent = String(count); }
    reportHeight();
  });
  document.getElementById('bump').addEventListener('click', () => {
    count += 1;
    countEl.textContent = String(count);
    countEl.animate([{ transform: 'scale(1.2)' }, { transform: 'scale(1)' }], { duration: 160 });
  });
  new ResizeObserver(reportHeight).observe(document.body);
  window.parent.postMessage({ type: 'rose:ready' }, '*');
  reportHeight();
</script>
</body>
</html>
`;

export const USER_UI_EXAMPLE_SHADER_BACKGROUND = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shader-background</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0b12; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
  // WebGL2 full-screen shader. DPR-aware, paused when hidden, static frame
  // under prefers-reduced-motion.
  const canvas = document.getElementById('c');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const vs = \`#version 300 es
  in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }\`;
  const fs = \`#version 300 es
  precision highp float;
  uniform vec2 uRes; uniform float uTime; out vec4 o;
  void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / min(uRes.x, uRes.y);
    float t = uTime * 0.15;
    float v = sin(uv.x * 3.0 + t) + sin(uv.y * 4.0 - t * 1.3) + sin(length(uv) * 5.0 - t * 2.0);
    vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 0.6, 1.2) + v + t);
    o = vec4(col * 0.35, 1.0);
  }\`;
  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  if (gl) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    let raf = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
    function frame(ms) {
      resize();
      gl.uniform1f(uTime, ms / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = reduceMotion.matches || document.hidden ? 0 : requestAnimationFrame(frame);
    }
    function start() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }
    function stop() { cancelAnimationFrame(raf); raf = 0; }
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    reduceMotion.addEventListener('change', start);
    window.addEventListener('resize', () => { if (!raf) frame(performance.now()); });
    start();
  }
  window.parent.postMessage({ type: 'rose:ready' }, '*');
</script>
</body>
</html>
`;

/**
 * The \`rose-ui\` CLI (dependency-free Node script). Reads ~/rose_user_ui (or
 * ROSE_UI_DIR), skips dot-entries and node_modules, and POSTs the bundle to
 * ROSE_UI_PUBLISH_URL with the session's ROSE_UI_PUBLISH_TOKEN.
 */
export const USER_UI_CLI_SCRIPT = `#!/usr/bin/env node
'use strict';
// rose-ui CLI v${USER_UI_CLI_VERSION} — generated by Rose; do not edit.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_FILES = 2000;

function usage(code) {
  console.log('usage: rose-ui publish [--no-activate]');
  process.exit(code);
}

function collect(root) {
  const files = [];
  let total = 0;
  function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(abs, relPath); continue; }
      if (!entry.isFile()) continue;
      const content = fs.readFileSync(abs);
      if (content.length > MAX_FILE) throw new Error(relPath + ' is larger than 10 MB');
      total += content.length;
      files.push({ path: relPath, contentBase64: content.toString('base64') });
    }
  }
  walk(root, '');
  if (files.length > MAX_FILES) throw new Error('more than ' + MAX_FILES + ' files');
  if (total > MAX_TOTAL) throw new Error('bundle is larger than 50 MB');
  return { files, total };
}

async function publish(args) {
  const activate = !args.includes('--no-activate');
  const url = process.env.ROSE_UI_PUBLISH_URL;
  const token = process.env.ROSE_UI_PUBLISH_TOKEN;
  if (!url || !token) throw new Error('ROSE_UI_PUBLISH_URL and ROSE_UI_PUBLISH_TOKEN must be set (they are injected into Rose code sessions)');
  const root = process.env.ROSE_UI_DIR || path.join(os.homedir(), 'rose_user_ui');
  if (!fs.existsSync(path.join(root, 'rose-ui.json'))) throw new Error('no rose-ui.json in ' + root);
  const { files, total } = collect(root);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ files, activate }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!res.ok) {
    console.error('publish failed (' + res.status + '): ' + (body.error || text));
    for (const detail of body.details || []) console.error('  - ' + detail);
    process.exit(1);
  }
  console.log('published version ' + body.versionId + ' (' + files.length + ' files, ' + total + ' bytes)' + (activate ? ' — now active for the user' : ' — not activated'));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'publish') {
  publish(rest).catch((err) => { console.error('rose-ui: ' + err.message); process.exit(1); });
} else if (cmd === '--version') {
  console.log('${USER_UI_CLI_VERSION}');
} else {
  usage(cmd === undefined || cmd === '--help' || cmd === 'help' ? 0 : 1);
}
`;

const text = (path: string, content: string): UserUiBundleFile => ({
  path,
  content: Buffer.from(content, 'utf8'),
});

/** The starting bundle for a user with no published version. */
export function userUiSeedFiles(): UserUiBundleFile[] {
  return [
    text('README.md', USER_UI_README),
    text('rose-ui.json', USER_UI_SEED_MANIFEST),
    text('root/theme.json', USER_UI_SEED_THEME),
    text('examples/inline-hello/index.html', USER_UI_EXAMPLE_INLINE_HELLO),
    text('examples/shader-background/index.html', USER_UI_EXAMPLE_SHADER_BACKGROUND),
  ];
}
