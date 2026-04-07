#!/usr/bin/env node
/**
 * WebSocket server that runs Claude Code in a proper PTY and streams output.
 *
 * Uses node-pty for direct PTY management (replaces `script` command):
 * - Characters written via pty.write() go directly to the PTY master
 * - No middleman process between us and Claude Code
 * - Proper raw mode support for stdin injection
 *
 * Architecture:
 * - Accumulates all stdout in a buffer (never flushed)
 * - On client connect: sends full buffer, then streams live
 * - Agent worker sends stdin via WebSocket for follow-up prompts
 * - Logs to /tmp/ws-server.log for debugging
 */

import { WebSocketServer } from 'ws';
import pty from 'node-pty';
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

  // Handle incoming messages (stdin from parent agent)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'stdin') {
        log('info', 'Received stdin', { bytes: msg.data?.length || 0 });

        // Write directly to PTY — no middleman process
        if (claude && !processExited) {
          // Ensure carriage return at end for prompt submission
          // In raw PTY mode, \r is the Enter key
          const input = msg.data.endsWith('\r') ? msg.data : msg.data + '\r';

          try {
            claude.write(input);
            log('info', 'stdin write successful', { bytes: input.length });
            ws.send(JSON.stringify({ type: 'stdin_ack', bytes: input.length }));
            // Broadcast stdin to all clients so FE can display what was typed
            broadcast('stdin_echo', input);
          } catch (err) {
            log('error', 'stdin write error', { error: err.message });
            ws.send(JSON.stringify({ type: 'stdin_error', error: err.message }));
          }
        } else {
          log('error', 'Cannot write to stdin - process not ready or exited');
          ws.send(JSON.stringify({ type: 'stdin_error', error: 'Process not ready or exited' }));
        }
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


// Handle shutdown gracefully
let processExited = false;

async function shutdown(exitCode = 0) {
  log('info', 'Starting graceful shutdown', { exitCode });

  // Notify clients with exit code (sent directly, not wrapped in data)
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

const projects = {
  '/home/user': { allowedTools: ['*'], hasTrustDialogAccepted: true },
  '/': { allowedTools: ['*'], hasTrustDialogAccepted: true },
};

writeFileSync(join(home, '.claude.json'), JSON.stringify(config));
writeFileSync(join(home, '.claude', 'projects.json'), JSON.stringify(projects));

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

    // Write repo-specific CLAUDE.md with auto-push instructions
    const claudeMd = `# Rose Labs Agent - ${repoName}

You are working in a cloned GitHub repository: ${GITHUB_REPO_URL}

## CRITICAL: Auto-Push Instructions

After completing your task, you MUST push your changes:
1. Stage all changes: \`git add -A\`
2. Commit with a descriptive message: \`git commit -m "feat: [description]"\`
3. Push to main: \`git push origin main\`

If there are merge conflicts:
1. Pull latest: \`git pull origin main --rebase\`
2. Resolve any conflicts
3. Continue rebase: \`git rebase --continue\`
4. Push: \`git push origin main\`

IMPORTANT: Always push your changes before the session ends. The sandbox is ephemeral - unpushed changes will be lost!

## Repository Info
- Repo: ${GITHUB_REPO_URL}
- Working directory: ${workDir}

## File Locations
- **User attachments**: \`/home/user/attachments/\` - Files uploaded by the user
- **Output files**: \`/home/user/output/\` - Place files user needs (auto-extracted)
`;
    writeFileSync(join(workDir, 'CLAUDE.md'), claudeMd);

    // Trust the repo directory for Claude Code
    projects[workDir] = { allowedTools: ['*'], hasTrustDialogAccepted: true };
    writeFileSync(join(home, '.claude', 'projects.json'), JSON.stringify(projects));

    console.log(`[Setup] Repo cloned to ${workDir}`);
  } catch (err) {
    console.error(`[Setup] Failed to clone repo:`, err.message);
    // Continue without clone - Claude will see the error in goal context
  }
}

// Start Claude Code with node-pty for proper PTY management
log('info', 'Starting Claude Code', { goal: GOAL.slice(0, 100) });

// Strip NUL bytes which would truncate at the C level
const sanitizedGoal = GOAL.replace(/\0/g, '');

// Spawn Claude Code directly in a PTY — no `script` middleman.
// node-pty creates a real PTY pair and gives us direct write access
// to the master side, ensuring stdin delivery is reliable.
const claude = pty.spawn('bash', [
  '-l', '-c', 'claude --dangerously-skip-permissions "$CLAUDE_GOAL"'
], {
  name: 'xterm-256color',
  cols: 200,
  rows: 50,
  cwd: workDir,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    CLAUDE_GOAL: sanitizedGoal,
  },
});

log('info', 'Claude Code spawned via node-pty', { pid: claude.pid });

// Auto-dismiss the "trust this folder" dialog if it appears.
// Newer Claude Code versions ignore the projects.json hasTrustDialogAccepted
// config, so we detect the dialog in PTY output and press Enter.
let trustDialogDismissed = false;

claude.onData((data) => {
  outputBuffer += data;
  broadcast('stdout', data);

  // Detect trust dialog and auto-dismiss by pressing Enter
  if (!trustDialogDismissed && outputBuffer.includes('trust') && outputBuffer.includes('Esc to cancel')) {
    trustDialogDismissed = true;
    log('info', 'Auto-dismissing trust folder dialog');
    setTimeout(() => claude.write('\r'), 500);
  }
});

claude.onExit(({ exitCode, signal }) => {
  processExited = true;
  log('info', 'Claude Code exited', { exitCode, signal });
  shutdown(exitCode || 0);
});
