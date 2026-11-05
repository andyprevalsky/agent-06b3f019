/**
 * `rose-project-startup`: the program a code session runs to execute its
 * project's startup script. Written into the session home by
 * restoreWorkspace() and run by ws-server.mjs before the CLI starts (every
 * boot, so also on resume) or on demand by runProjectStartup().
 *
 * Contract (startup.json written next to it):
 *   - runs `bash <scriptPath>` in repoDir as its own process group;
 *   - after timeoutS: SIGTERM the group, SIGKILL 5 s later, status "timeout";
 *   - never waits on pipes held by daemons the script left running;
 *   - redacts every env-file value (≥ 6 chars) from the streamed output, the
 *     0600 log and the report;
 *   - writes the report atomically to reportPath and prints it as the last
 *     line `ROSE_PROJECT_STARTUP_REPORT {...}`.
 *
 * Plain CommonJS with no dependencies: it must run on any Node the session has.
 * It is written as `.cjs` so a `"type": "module"` package.json above it (the
 * E2B templates' HOME has one) cannot turn it into an ES module.
 */
export const STARTUP_RUNNER_REPORT_PREFIX = 'ROSE_PROJECT_STARTUP_REPORT ';

export const STARTUP_RUNNER_SCRIPT = String.raw`#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const configPath =
  process.argv[2] || path.join(process.env.HOME || '.', '.rose', 'project', 'startup.json');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const TAIL_CHARS = 4000;
const KILL_GRACE_MS = 5000;

function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) return v.slice(1, -1);
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

function secretValues() {
  const out = new Set();
  for (const file of cfg.envFiles || []) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=(.*)$/.exec(line);
      if (!m) continue;
      const value = unquote(m[1]);
      if (value.length >= 6) out.add(value);
      const escaped = value.replace(/\\n/g, '\n');
      if (escaped !== value && escaped.length >= 6) out.add(escaped);
    }
  }
  for (const extra of cfg.extraRedactions || []) if (extra && extra.length >= 6) out.add(extra);
  return [...out].sort((a, b) => b.length - a.length);
}

const secrets = secretValues();
const holdBack = secrets.reduce((max, s) => Math.max(max, s.length), 1) - 1;
function redact(text) {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

const startedMs = Date.now();
const startedAt = new Date(startedMs).toISOString();
fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true });
const logFd = fs.openSync(cfg.logPath, 'w', 0o600);
let pending = '';
let tail = '';
function emit(text) {
  if (!text) return;
  fs.writeSync(logFd, text);
  process.stdout.write(text);
  tail = (tail + text).slice(-TAIL_CHARS);
}
function onChunk(chunk) {
  pending = redact(pending + chunk.toString('utf8'));
  const cut = pending.length - holdBack;
  if (cut > 0) {
    emit(pending.slice(0, cut));
    pending = pending.slice(cut);
  }
}
function flush() {
  emit(redact(pending));
  pending = '';
}

let finished = false;
function finish(status, exitCode) {
  if (finished) return;
  finished = true;
  flush();
  fs.closeSync(logFd);
  const finishedMs = Date.now();
  const report = {
    status,
    exitCode: exitCode === undefined ? null : exitCode,
    durationMs: finishedMs - startedMs,
    timeoutS: cfg.timeoutS,
    outputTail: tail,
    logPath: cfg.logPath,
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
  };
  const tmp = cfg.reportPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(report), { mode: 0o600 });
  fs.renameSync(tmp, cfg.reportPath);
  process.stdout.write('\n${STARTUP_RUNNER_REPORT_PREFIX}' + JSON.stringify(report) + '\n', () =>
    process.exit(status === 'ok' || status === 'skipped' ? 0 : 1)
  );
}

if (!cfg.scriptPath || !fs.existsSync(cfg.scriptPath)) {
  finish('skipped', null);
} else {
  let timedOut = false;
  const child = spawn('bash', [cfg.scriptPath], {
    cwd: cfg.repoDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { ROSE_PROJECT_DIR: cfg.repoDir }),
  });
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (_) {
      try {
        child.kill(signal);
      } catch (__) {}
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    emit('\n[rose-project-startup] timed out after ' + cfg.timeoutS + 's; stopping\n');
    killGroup('SIGTERM');
    setTimeout(() => {
      killGroup('SIGKILL');
      finish('timeout', null);
    }, KILL_GRACE_MS).unref();
  }, Math.max(1, cfg.timeoutS) * 1000);
  child.on('error', (err) => {
    clearTimeout(timer);
    emit('[rose-project-startup] failed to start: ' + err.message + '\n');
    finish('failed', null);
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    // Let already-buffered pipe data drain, but never wait for 'close':
    // daemons the script started may hold the pipes open indefinitely.
    setTimeout(() => finish(timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed', code), 50);
  });
}
`;
