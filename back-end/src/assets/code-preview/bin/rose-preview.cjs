#!/usr/bin/env node
'use strict';
/**
 * rose-preview: this code session's live dev-server preview (vite HMR).
 * Installed by Rose at ~/.rose/bin/rose-preview for Rose dev accounts and
 * regenerated every session; do not edit.
 *
 *   rose-preview start [--dir DIR] [--port N] [--wait-startup --since MS] [--json]
 *   rose-preview status [--json]      running? pid, port, url
 *   rose-preview url                  the URL the user opens
 *   rose-preview stop
 *
 *   start ─► front-end dir: --dir │ $ROSE_PREVIEW_DIR │ ~/workspace/front-end │ ~/workspace
 *        ─► (--wait-startup) wait for this boot's project startup report
 *        ─► vite missing? npm install (workspace root when DIR is a workspace)
 *        ─► vite --host 0.0.0.0 --port N --strictPort   (own process group, detached)
 *        ─► answers HTTP ─► ~/.rose/preview/state.json
 *
 * Port: --port, else $ROSE_PREVIEW_PORT (5173 in a cloud sandbox, whose public
 * URL is $ROSE_PREVIEW_URL), else a free local port. The preview reaches the
 * Rose backend through vite's /api proxy: VITE_BACKEND_SAME_ORIGIN=true and
 * VITE_BACKEND_API_URL=$ROSE_PREVIEW_BACKEND_URL. Plain CommonJS, no deps.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const CLI_VERSION = '1';
const READY_TIMEOUT_MS = 240_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const STOP_GRACE_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function home() {
  return process.env.HOME || os.homedir();
}
function previewDir() {
  return path.join(home(), '.rose', 'preview');
}
function statePath() {
  return path.join(previewDir(), 'state.json');
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) opts[key] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
    else opts[key] = true;
  }
  return opts;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(previewDir(), { recursive: true });
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, statePath());
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** HTTP status of GET http://127.0.0.1:port/ (0 when nothing answers). */
function probe(port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasViteProject(dir) {
  if (!existsDir(dir)) return false;
  const names = fs.readdirSync(dir);
  return names.some((n) => /^vite\.config\.(c|m)?(j|t)s$/.test(n)) || names.includes('index.html');
}

/** The directory the dev server runs in. */
function resolveDir(opts) {
  const workspace = path.join(home(), 'workspace');
  const given = opts.dir || process.env.ROSE_PREVIEW_DIR || '';
  if (given) {
    const abs = path.isAbsolute(given) ? given : path.resolve(existsDir(workspace) ? workspace : process.cwd(), given);
    if (!existsDir(abs)) throw new Error(`preview directory ${abs} does not exist`);
    return abs;
  }
  for (const candidate of [path.join(workspace, 'front-end'), workspace, process.cwd()]) {
    if (hasViteProject(candidate)) return candidate;
  }
  throw new Error('no front-end found: pass --dir <path to the vite app>');
}

function resolveVite(dir) {
  try {
    const pkg = require.resolve('vite/package.json', { paths: [dir] });
    const bin = path.join(path.dirname(pkg), 'bin', 'vite.js');
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** The npm workspace root that lists `dir`, else `dir` itself. */
function installRoot(dir) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  const root = top.status === 0 ? top.stdout.trim() : '';
  if (root && root !== dir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const rel = path.relative(root, dir);
      const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces && pkg.workspaces.packages) || [];
      if (workspaces.includes(rel)) return root;
    } catch {
      // no root package.json: install in dir
    }
  }
  return dir;
}

async function ensureVite(dir, log) {
  let vite = resolveVite(dir);
  if (vite) return vite;
  const root = installRoot(dir);
  log(`vite is not installed; running npm install in ${root} (log: ${path.join(previewDir(), 'install.log')})`);
  fs.mkdirSync(previewDir(), { recursive: true });
  const out = fs.openSync(path.join(previewDir(), 'install.log'), 'w');
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: root,
    stdio: ['ignore', out, out],
    timeout: INSTALL_TIMEOUT_MS,
  });
  fs.closeSync(out);
  if (result.status !== 0) throw new Error(`npm install failed in ${root} (exit ${result.status}); see ${path.join(previewDir(), 'install.log')}`);
  vite = resolveVite(dir);
  if (!vite) throw new Error(`vite still not resolvable from ${dir} after npm install`);
  return vite;
}

/** Wait until this boot's project startup finished (its report is newer than `since`). */
async function waitForStartup(sinceMs, log) {
  const cfgPath = path.join(home(), '.rose', 'project', 'startup.json');
  const reportPath = path.join(home(), '.rose', 'project', 'startup-report.json');
  if (!fs.existsSync(cfgPath)) return;
  let timeoutS = 120;
  try {
    const t = Number(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).timeoutS);
    if (Number.isFinite(t) && t > 0) timeoutS = t;
  } catch {
    // default
  }
  const deadline = Date.now() + (timeoutS + 60) * 1000;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(reportPath).mtimeMs >= sinceMs) return;
    } catch {
      // not written yet
    }
    await sleep(1_000);
  }
  log('project startup did not report in time; starting the preview anyway');
}

function tail(file, chars = 2_000) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.slice(-chars);
  } catch {
    return '';
  }
}

function publicUrl(port, envPort) {
  const configured = (process.env.ROSE_PREVIEW_URL || '').trim();
  if (configured && String(port) === String(envPort)) return configured.endsWith('/') ? configured : `${configured}/`;
  return `http://127.0.0.1:${port}/`;
}

async function cmdStart(opts) {
  const quiet = Boolean(opts.json);
  const log = (msg) => {
    if (!quiet) process.stdout.write(`rose-preview: ${msg}\n`);
  };
  const existing = readState();
  if (existing && alive(existing.pid) && (await probe(existing.port)) > 0) {
    return report(opts, { ...existing, running: true, already_running: true }, `already running: ${existing.url}`);
  }
  const dir = resolveDir(opts);
  if (opts['wait-startup']) await waitForStartup(Number(opts.since) || Date.now() - 1_000, log);
  const vite = await ensureVite(dir, log);
  const envPort = (process.env.ROSE_PREVIEW_PORT || '').trim();
  const port = Number(opts.port || envPort || (await freePort()));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${opts.port || envPort}`);
  const url = publicUrl(port, opts.port ? opts.port : envPort);
  const env = { ...process.env, BROWSER: 'none', VITE_DEV_PORT: String(port), VITE_BACKEND_SAME_ORIGIN: 'true' };
  const backend = (process.env.ROSE_PREVIEW_BACKEND_URL || '').trim();
  if (backend) env.VITE_BACKEND_API_URL = backend.replace(/\/+$/, '');
  // Behind the sandbox's https proxy: allow its host and send HMR over :443.
  if (url.startsWith('https://')) env.VITE_ALLOWED_HOSTS = new URL(url).hostname;
  fs.mkdirSync(previewDir(), { recursive: true });
  const logPath = path.join(previewDir(), 'vite.log');
  const out = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [vite, '--host', '0.0.0.0', '--port', String(port), '--strictPort'], {
    cwd: dir,
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  child.unref();
  const state = {
    version: 1,
    pid: child.pid,
    port,
    dir,
    url,
    log: logPath,
    started_at: new Date().toISOString(),
  };
  writeState(state);
  const deadline = Date.now() + (Number(opts.timeout) > 0 ? Number(opts.timeout) * 1000 : READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (!alive(child.pid)) {
      fs.rmSync(statePath(), { force: true });
      throw new Error(`vite exited before it answered on port ${port}:\n${tail(logPath)}`);
    }
    if ((await probe(port)) > 0) {
      const ready = { ...state, ready_at: new Date().toISOString() };
      writeState(ready);
      return report(opts, { ...ready, running: true }, `running: ${url} (vite on port ${port}, ${dir})`);
    }
    await sleep(250);
  }
  throw new Error(`vite did not answer on port ${port} in time; log: ${logPath}`);
}

function report(opts, body, human) {
  if (opts.json) process.stdout.write(`${JSON.stringify(body)}\n`);
  else process.stdout.write(`rose-preview: ${human}\n`);
  return 0;
}

async function cmdStatus(opts) {
  const state = readState();
  const running = Boolean(state && alive(state.pid) && (await probe(state.port)) > 0);
  const body = state ? { ...state, running } : { running: false };
  return report(opts, body, state ? `${running ? 'running' : 'not running'}: ${state.url}` : 'not running');
}

async function cmdUrl() {
  const state = readState();
  const envPort = (process.env.ROSE_PREVIEW_PORT || '').trim();
  const url = state ? state.url : envPort ? publicUrl(envPort, envPort) : null;
  if (!url) {
    process.stderr.write('rose-preview: no preview yet; run `rose-preview start`\n');
    return 1;
  }
  process.stdout.write(`${url}\n`);
  return 0;
}

async function cmdStop() {
  const state = readState();
  if (!state || !alive(state.pid)) {
    fs.rmSync(statePath(), { force: true });
    process.stdout.write('rose-preview: not running\n');
    return 0;
  }
  const signal = (sig) => {
    try {
      process.kill(-state.pid, sig);
    } catch {
      try {
        process.kill(state.pid, sig);
      } catch {
        // gone
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && alive(state.pid)) await sleep(100);
  if (alive(state.pid)) signal('SIGKILL');
  fs.rmSync(statePath(), { force: true });
  process.stdout.write('rose-preview: stopped\n');
  return 0;
}

const USAGE = `usage: rose-preview <command>

  start [--dir DIR] [--port N] [--json]   start the live preview (vite HMR) and print its URL
  status [--json]                          is it running? pid, port, url
  url                                      the preview URL the user opens
  stop                                     stop the preview

DIR defaults to $ROSE_PREVIEW_DIR, then ~/workspace/front-end, then ~/workspace.`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  if (cmd === '--version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  const commands = { start: cmdStart, status: cmdStatus, url: cmdUrl, stop: cmdStop };
  if (!commands[cmd]) {
    process.stdout.write(`${USAGE}\n`);
    return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
  return commands[cmd](opts);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`rose-preview: ${err.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { CLI_VERSION, parseArgs, resolveDir, installRoot, publicUrl, main };
