#!/usr/bin/env node
import { WebSocketServer } from 'ws';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { spawn, execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = '/tmp/codex-ws-server.log';
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ timestamp, level, message, ...data });
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // Best-effort diagnostic log only.
  }
}

const PORT = 3000;
const GOAL = process.env.CODEX_GOAL;
const CODEX_AUTH_JSON = process.env.CODEX_AUTH_JSON;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.4';
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GOAL) {
  log('error', 'CODEX_GOAL not set');
  process.exit(1);
}
if (!CODEX_AUTH_JSON && !OPENAI_API_KEY) {
  log('error', 'Neither CODEX_AUTH_JSON nor OPENAI_API_KEY set');
  process.exit(1);
}

let outputBuffer = '';
let exitCode = null;
let processExited = false;
let stdoutLineBuffer = '';
const clients = new Set();
const wss = new WebSocketServer({ port: PORT });

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function appendOutput(type, data) {
  outputBuffer += data;
  broadcast(type, data);
}

function describeFileChanges(changes = []) {
  return changes
    .map((change) => {
      const kind = change.kind || 'change';
      const path = change.path || '<unknown>';
      return `${kind} ${path}`;
    })
    .join(', ');
}

function renderCodexJsonLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line.endsWith('\n') ? line : `${line}\n`;
  }

  if (event.type === 'thread.started') {
    return `[Codex] Thread started: ${event.thread_id || 'unknown'}\n`;
  }
  if (event.type === 'turn.started') {
    return '[Codex] Turn started\n';
  }
  if (event.type === 'turn.completed') {
    const usage = event.usage || {};
    return [
      '[Codex] Turn completed',
      `input_tokens=${usage.input_tokens ?? 0}`,
      `cached_input_tokens=${usage.cached_input_tokens ?? 0}`,
      `output_tokens=${usage.output_tokens ?? 0}`,
      `reasoning_output_tokens=${usage.reasoning_output_tokens ?? 0}`,
    ].join(' ') + '\n';
  }

  const item = event.item;
  if (!item) return '';

  if (item.type === 'agent_message' && item.text) {
    return `[Codex] ${item.text}\n`;
  }

  if (item.type === 'file_change' && event.type === 'item.completed') {
    return `[Codex file_change ${item.status || 'completed'}] ${describeFileChanges(item.changes)}\n`;
  }

  if (item.type === 'command_execution') {
    if (event.type === 'item.started') {
      return `[Codex command started] ${item.command}\n`;
    }

    const output = item.aggregated_output ? `\n${item.aggregated_output.replace(/\n?$/, '\n')}` : '\n';
    return [
      `[Codex command completed] ${item.command}`,
      `[Codex command output]${output}`,
      `[Codex exit_code] ${item.exit_code ?? 'unknown'}\n`,
    ].join('\n');
  }

  return '';
}

function appendCodexStdout(data) {
  stdoutLineBuffer += data;
  const lines = stdoutLineBuffer.split('\n');
  stdoutLineBuffer = lines.pop() || '';
  for (const line of lines) {
    appendOutput('stdout', renderCodexJsonLine(line));
  }
}

async function shutdown(code = 0) {
  log('info', 'Starting graceful shutdown', { code });
  for (const client of clients) {
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'exit', code }));
    client.close();
  }
  wss.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 5000);
}

wss.on('connection', (ws) => {
  log('info', 'Client connected', { total: clients.size + 1 });
  clients.add(ws);

  if (outputBuffer.length > 0) ws.send(JSON.stringify({ type: 'buffer', data: outputBuffer }));
  if (processExited) ws.send(JSON.stringify({ type: 'exit', code: exitCode ?? 0 }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'stdin') {
        ws.send(JSON.stringify({ type: 'stdin_error', error: 'Codex exec is non-interactive' }));
      }
    } catch (err) {
      log('error', 'Failed to parse message', { error: err.message });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log('info', 'Client disconnected', { total: clients.size });
  });
  ws.on('error', (err) => {
    clients.delete(ws);
    log('error', 'Client error', { error: err.message });
  });
});

process.on('SIGINT', () => shutdown(exitCode ?? 0));
process.on('SIGTERM', () => shutdown(exitCode ?? 0));

log('info', 'Server listening', { port: PORT });

const home = homedir();
const codexHome = join(home, '.codex');
mkdirSync(codexHome, { recursive: true });
mkdirSync('/home/user/attachments', { recursive: true });
mkdirSync('/home/user/output', { recursive: true });

if (CODEX_AUTH_JSON) {
  try {
    JSON.parse(CODEX_AUTH_JSON);
    writeFileSync(join(codexHome, 'auth.json'), CODEX_AUTH_JSON);
    log('info', 'Wrote Codex ChatGPT auth envelope');
  } catch (err) {
    log('error', 'CODEX_AUTH_JSON is not valid JSON', { error: err.message });
    process.exit(1);
  }
} else {
  const login = spawn('codex', ['login', '--with-api-key'], {
    env: { ...process.env, CODEX_HOME: codexHome, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  login.stdin.end(`${OPENAI_API_KEY}\n`);
  login.stdout.on('data', (data) => appendOutput('stdout', data.toString()));
  login.stderr.on('data', (data) => appendOutput('stderr', data.toString()));
  const loginCode = await new Promise((resolve) => login.on('close', resolve));
  if (loginCode !== 0) {
    log('error', 'Codex API-key login failed', { loginCode });
    process.exit(1);
  }
}

let workDir = '/home/user';
if (GITHUB_REPO_URL) {
  try {
    const parsed = new URL(GITHUB_REPO_URL);
    const repoName = parsed.pathname.split('/').filter(Boolean).pop()?.replace(/\.git$/, '');
    if (!repoName) throw new Error(`Invalid GitHub URL: ${GITHUB_REPO_URL}`);
    workDir = `/home/user/${repoName}`;
    if (GITHUB_TOKEN) {
      parsed.username = 'x-access-token';
      parsed.password = GITHUB_TOKEN;
    }
    execFileSync('git', ['clone', parsed.toString(), workDir], {
      stdio: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    execFileSync('git', ['config', 'user.name', 'Rose Agent'], { cwd: workDir });
    execFileSync('git', ['config', 'user.email', 'agent@roselabs.ai'], { cwd: workDir });
    writeFileSync(
      join(workDir, 'AGENTS.md'),
      [
        `You are working in a cloned GitHub repository: ${GITHUB_REPO_URL}`,
        '',
        'After completing repository changes, push them before finishing.',
        'User attachments are in /home/user/attachments.',
        'Place user-facing output files in /home/user/output.',
        '',
      ].join('\n')
    );
    log('info', 'Repository cloned', { workDir });
  } catch (err) {
    appendOutput('stderr', `[Setup] Failed to clone repository: ${err.message}\n`);
    log('error', 'Failed to clone repository', { error: err.message });
  }
}

const sanitizedGoal = GOAL.replace(/\0/g, '');
const args = [
  'exec',
  '--ignore-user-config',
  '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox',
  '--json',
  '--cd',
  workDir,
  '-m',
  CODEX_MODEL,
  sanitizedGoal,
];

log('info', 'Starting Codex exec', { model: CODEX_MODEL, workDir, goal: sanitizedGoal.slice(0, 120) });
const codex = spawn('codex', args, {
  cwd: workDir,
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: home,
    TERM: 'xterm-256color',
  },
});
codex.stdin.end();

codex.stdout.on('data', (data) => appendCodexStdout(data.toString()));
codex.stderr.on('data', (data) => appendOutput('stderr', data.toString()));
codex.on('error', (err) => {
  appendOutput('stderr', `[Codex] Failed to start: ${err.message}\n`);
  log('error', 'Codex spawn error', { error: err.message });
});
codex.on('close', (code, signal) => {
  if (stdoutLineBuffer) {
    appendOutput('stdout', renderCodexJsonLine(stdoutLineBuffer));
    stdoutLineBuffer = '';
  }
  exitCode = code ?? 1;
  processExited = true;
  log('info', 'Codex exited', { code, signal });
  broadcast('exit', exitCode);
  setTimeout(() => shutdown(exitCode ?? 0), 120000);
});
