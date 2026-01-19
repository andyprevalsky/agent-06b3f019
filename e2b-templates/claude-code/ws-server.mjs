#!/usr/bin/env node
/**
 * WebSocket server that runs Claude Code and streams stdout to connected clients.
 *
 * - Accumulates all stdout in a buffer (never flushed)
 * - On client connect: sends full buffer, then streams live
 * - Manages multiple client connections
 * - Agent worker is responsible for persisting output to DB
 * - Logs to /tmp/ws-server.log for debugging
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { appendFileSync } from 'fs';

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

// Validate required env vars
if (!ANTHROPIC_API_KEY) {
  log('error', 'ANTHROPIC_API_KEY not set');
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

        // Write to Claude Code's stdin
        if (claude && claude.stdin && !claude.stdin.destroyed) {
          // Ensure newline at end for prompt submission
          const input = msg.data.endsWith('\n') ? msg.data : msg.data + '\n';
          claude.stdin.write(input, (err) => {
            if (err) {
              log('error', 'stdin write error', { error: err.message });
              ws.send(JSON.stringify({ type: 'stdin_error', error: err.message }));
            } else {
              log('info', 'stdin write successful');
              ws.send(JSON.stringify({ type: 'stdin_ack', bytes: input.length }));
              // Broadcast stdin to all clients so FE can display what was typed
              broadcast('stdin_echo', input);
            }
          });
        } else {
          log('error', 'Cannot write to stdin - process not ready');
          ws.send(JSON.stringify({ type: 'stdin_error', error: 'Process not ready or stdin destroyed' }));
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

const apiKeyLast20 = ANTHROPIC_API_KEY.slice(-20);
const config = {
  theme: 'dark',
  hasCompletedOnboarding: true,
  bypassPermissionsModeAccepted: true,
  autoUpdaterStatus: 'disabled',
  shiftEnterKeyBindingInstalled: true,
  customApiKeyResponses: {
    approved: [apiKeyLast20],
    rejected: [],
  },
};
const projects = {
  '/home/user': { allowedTools: ['*'], hasTrustDialogAccepted: true },
  '/': { allowedTools: ['*'], hasTrustDialogAccepted: true },
};

import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const home = homedir();
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude.json'), JSON.stringify(config));
writeFileSync(join(home, '.claude', 'projects.json'), JSON.stringify(projects));

log('info', 'Configuration written');

// Start Claude Code with PTY via script command
log('info', 'Starting Claude Code', { goal: GOAL.slice(0, 100) });

// Pass goal via environment variable to avoid shell injection vulnerabilities.
// The shell command reads $CLAUDE_GOAL directly, which doesn't undergo shell
// interpretation/expansion like command-line arguments would.
const claude = spawn('script', [
  '-q', '/dev/null',
  '-c', 'claude --dangerously-skip-permissions "$CLAUDE_GOAL"'
], {
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    CLAUDE_GOAL: GOAL,
  },
});

claude.stdout.on('data', (data) => {
  const chunk = data.toString();
  outputBuffer += chunk;
  broadcast('stdout', chunk);
});

claude.stderr.on('data', (data) => {
  const chunk = data.toString();
  outputBuffer += chunk;
  broadcast('stderr', chunk);
});

claude.on('close', (code) => {
  log('info', 'Claude Code exited', { exitCode: code });
  shutdown(code || 0);
});

claude.on('error', (err) => {
  log('error', 'Failed to start Claude Code', { error: err.message });
  broadcast('error', err.message);
  shutdown(1);
});
