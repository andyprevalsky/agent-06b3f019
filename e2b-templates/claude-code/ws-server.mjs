#!/usr/bin/env node
/**
 * WebSocket server that runs Claude through the Agent SDK and streams both
 * readable output and normalized JSON events.
 */

import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import { appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Log to both console and file for debugging
const LOG_FILE = '/tmp/ws-server.log';
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({ timestamp, level, message, ...data });
  console.log(logLine);
  try {
    appendFileSync(LOG_FILE, logLine + '\n');
  } catch (e) {
    // Ignore file write errors
  }
}

const PORT = 3000;
const GOAL = process.env.CLAUDE_CODE_GOAL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_CODE_CREDENTIALS = process.env.CLAUDE_CODE_CREDENTIALS;
const CODE_AGENT_SYSTEM_PROMPT = process.env.CODE_AGENT_SYSTEM_PROMPT || '';
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// Validate required env vars
if (!ANTHROPIC_API_KEY && !CLAUDE_CODE_CREDENTIALS) {
  log('error', 'Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_CREDENTIALS set');
  process.exit(1);
}
if (!GOAL) {
  log('error', 'CLAUDE_CODE_GOAL not set');
  process.exit(1);
}

// Buffer to accumulate all stdout (never flushed)
let outputBuffer = '';
let eventBuffer = [];

// Track connected clients
const clients = new Set();

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

log('info', 'Server listening', { port: PORT });

wss.on('connection', (ws) => {
  log('info', 'Client connected', { total: clients.size + 1 });
  clients.add(ws);

  // Send full buffer to new client
  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'buffer', data: outputBuffer }));
  }
  if (eventBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'code_agent_events', data: eventBuffer }));
  }

  // Handle incoming messages (stdin from parent agent)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'stdin') {
        log('info', 'Received stdin', { bytes: msg.data?.length || 0 });

        if (!msg.data) {
          ws.send(JSON.stringify({ type: 'stdin_error', error: 'Missing data field' }));
          return;
        }

        ws.send(JSON.stringify({ type: 'stdin_error', error: 'Claude Agent SDK session is non-interactive' }));
      }
    } catch (e) {
      log('error', 'Failed to parse message', { error: e.message });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log('info', 'Client disconnected', { total: clients.size });
  });

  ws.on('error', (err) => {
    log('error', 'Client error', { error: err.message });
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

function appendOutput(type, data) {
  outputBuffer += data;
  broadcast(type, data);
}

function appendEvent(event) {
  const normalized = {
    version: 1,
    provider: 'claude',
    timestamp: new Date().toISOString(),
    ...event,
  };
  eventBuffer.push(normalized);
  broadcast('code_agent_event', normalized);
}


// Handle shutdown gracefully
let processExited = false;

async function shutdown(exitCode = 0) {
  log('info', 'Starting graceful shutdown', { exitCode });

  // Notify clients with exit code (sent directly, not wrapped in data)
  appendEvent({ type: 'final', status: exitCode === 0 ? 'completed' : 'failed', exit_code: exitCode });
  const exitMessage = JSON.stringify({ type: 'exit', code: exitCode });
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(exitMessage);
    }
  }

  // Close all client connections
  for (const client of clients) {
    client.close();
  }

  // Close server
  wss.close(() => {
    log('info', 'Shutdown complete');
    process.exit(exitCode);
  });

  // Force exit after 5s if graceful shutdown hangs
  setTimeout(() => {
    log('error', 'Forced exit after timeout');
    process.exit(exitCode);
  }, 5000);
}

// Handle signals
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Pre-configure Claude Code to skip all prompts
log('info', 'Configuring Claude Code');

const home = homedir();
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync('/home/user/attachments', { recursive: true });
mkdirSync('/home/user/output', { recursive: true });

const config = {
  theme: 'dark',
  hasCompletedOnboarding: true,
  bypassPermissionsModeAccepted: true,
  autoUpdaterStatus: 'disabled',
  shiftEnterKeyBindingInstalled: true,
};

// Per-user credentials: write ~/.claude/.credentials.json
// API key mode: add customApiKeyResponses to config
if (CLAUDE_CODE_CREDENTIALS) {
  log('info', 'Using per-user credentials');
  writeFileSync(join(home, '.claude', '.credentials.json'), CLAUDE_CODE_CREDENTIALS);
} else {
  log('info', 'Using shared API key');
  const apiKeyLast20 = ANTHROPIC_API_KEY.slice(-20);
  config.customApiKeyResponses = {
    approved: [apiKeyLast20],
    rejected: [],
  };
}

// Trust configuration: write in BOTH legacy and modern formats so any
// Claude Code version recognises the workspace as trusted.
const projects = {
  '/home/user': { allowedTools: ['*'], hasTrustDialogAccepted: true },
  '/': { allowedTools: ['*'], hasTrustDialogAccepted: true },
};

writeFileSync(join(home, '.claude.json'), JSON.stringify(config));
writeFileSync(join(home, '.claude', 'projects.json'), JSON.stringify(projects));

// Modern per-project settings: Claude Code >= 1.x stores trust per directory
// in ~/.claude/settings.json under an allowedDirectories array.
const settingsPath = join(home, '.claude', 'settings.json');
const settings = {
  allowedDirectories: ['/home/user', '/'],
};
writeFileSync(settingsPath, JSON.stringify(settings));

log('info', 'Configuration written');

// Clone GitHub repo if specified
let workDir = '/home/user';
let repoName = null;

if (GITHUB_REPO_URL) {
  console.log(`[Setup] Cloning GitHub repo: ${GITHUB_REPO_URL}`);

  // Extract repo name for working directory
  const repoMatch = GITHUB_REPO_URL.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) {
    console.error(`[Setup] Invalid GitHub URL: ${GITHUB_REPO_URL}`);
    process.exit(1);
  }
  const owner = repoMatch[1];
  repoName = repoMatch[2].replace(/\.git$/, '');
  workDir = `/home/user/${repoName}`;

  // Build authenticated clone URL
  const authUrl = GITHUB_TOKEN
    ? GITHUB_REPO_URL.replace('https://github.com', `https://x-access-token:${GITHUB_TOKEN}@github.com`)
    : GITHUB_REPO_URL;

  try {
    // Clone repo
    execSync(`git clone ${authUrl} ${workDir}`, {
      stdio: 'inherit',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    // Configure git for commits
    execSync(`git config user.name "Rose Agent"`, { cwd: workDir });
    execSync(`git config user.email "agent@roselabs.ai"`, { cwd: workDir });

    writeFileSync(join(workDir, 'CLAUDE.md'), CODE_AGENT_SYSTEM_PROMPT);

    // Trust the repo directory for Claude Code (both legacy and modern formats)
    projects[workDir] = { allowedTools: ['*'], hasTrustDialogAccepted: true };
    writeFileSync(join(home, '.claude', 'projects.json'), JSON.stringify(projects));
    settings.allowedDirectories.push(workDir);
    writeFileSync(settingsPath, JSON.stringify(settings));

    console.log(`[Setup] Repo cloned to ${workDir}`);
  } catch (err) {
    console.error(`[Setup] Failed to clone repo:`, err.message);
    // Continue without clone - Claude will see the error in goal context
  }
}

if (!GITHUB_REPO_URL && CODE_AGENT_SYSTEM_PROMPT) {
  writeFileSync(join(workDir, 'CLAUDE.md'), CODE_AGENT_SYSTEM_PROMPT);
}

function promptVersion() {
  return CODE_AGENT_SYSTEM_PROMPT.match(/Rose Labs code-agent instructions \(([^)]+)\)/)?.[1] || null;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function pathsFromToolInput(input) {
  if (!input || typeof input !== 'object') return [];
  return [
    input.file_path,
    input.path,
    input.notebook_path,
  ].filter((value) => typeof value === 'string' && value.startsWith('/home/user/'));
}

function emitSdkMessage(message) {
  if (message.type === 'system' && message.subtype === 'init') {
    appendEvent({
      type: 'session',
      raw_type: 'system.init',
      session_id: message.session_id,
      cwd: message.cwd,
      model: message.model,
      tools: message.tools || [],
      permission_mode: message.permissionMode,
      prompt_version: promptVersion(),
    });
    appendOutput('stdout', `[Claude] Session started in ${message.cwd}\n`);
    return;
  }

  if (message.type === 'assistant') {
    const text = textFromContent(message.message?.content);
    if (text) {
      appendEvent({ type: 'agent_message', raw_type: 'assistant', text, usage: message.message?.usage || null });
      appendOutput('stdout', `[Claude] ${text}\n`);
    }
    for (const part of message.message?.content || []) {
      if (part?.type === 'tool_use') {
        const paths = pathsFromToolInput(part.input);
        appendEvent({
          type: 'tool_use',
          raw_type: 'assistant.tool_use',
          tool: part.name,
          tool_use_id: part.id,
          input: part.input || {},
          paths,
        });
        appendOutput('stdout', `[Claude tool] ${part.name}${paths.length ? ` ${paths.join(', ')}` : ''}\n`);
      }
    }
    return;
  }

  if (message.type === 'user' && message.tool_use_result !== undefined) {
    appendEvent({
      type: 'tool_result',
      raw_type: 'user.tool_result',
      tool_use_result: message.tool_use_result,
    });
    return;
  }

  if (message.type === 'result') {
    const isSuccess = message.subtype === 'success';
    appendEvent({
      type: 'result',
      raw_type: `result.${message.subtype}`,
      status: isSuccess ? 'completed' : 'failed',
      text: isSuccess ? message.result : (message.errors || []).join('\n'),
      usage: message.usage || null,
      model_usage: message.modelUsage || null,
      structured_output: message.structured_output,
    });
    if (isSuccess && message.result) {
      appendOutput('stdout', `[Claude result] ${message.result}\n`);
    } else if (!isSuccess) {
      appendOutput('stderr', `[Claude result] ${(message.errors || []).join('\n')}\n`);
    }
    return;
  }

  appendEvent({ type: 'sdk_message', raw_type: message.type, sdk_message: message });
}

async function runClaudeAgent() {
  const sanitizedGoal = GOAL.replace(/\0/g, '');
  const prompt = [
    CODE_AGENT_SYSTEM_PROMPT ? `System instructions:\n${CODE_AGENT_SYSTEM_PROMPT}` : '',
    `Task:\n${sanitizedGoal}`,
  ].filter(Boolean).join('\n\n');

  appendEvent({
    type: 'session',
    status: 'starting',
    cwd: workDir,
    prompt_version: promptVersion(),
  });
  log('info', 'Starting Claude Agent SDK', { workDir, goal: sanitizedGoal.slice(0, 100) });

  try {
    const messages = query({
      prompt,
      options: {
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: CODE_AGENT_SYSTEM_PROMPT,
          excludeDynamicSections: true,
        },
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'TodoWrite'],
      },
    });

    for await (const message of messages) {
      emitSdkMessage(message);
    }

    processExited = true;
    log('info', 'Claude Agent SDK completed');
    await shutdown(0);
  } catch (err) {
    processExited = true;
    appendOutput('stderr', `[Claude] Failed: ${err.message}\n`);
    appendEvent({ type: 'error', message: err.message, stack: err.stack || null });
    log('error', 'Claude Agent SDK failed', { error: err.message, stack: err.stack });
    await shutdown(1);
  }
}

runClaudeAgent();
