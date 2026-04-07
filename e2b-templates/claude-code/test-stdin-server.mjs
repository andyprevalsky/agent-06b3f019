#!/usr/bin/env node
/**
 * Minimal WebSocket server that spawns bash in a PTY via node-pty.
 *
 * Same architecture as ws-server.mjs but deterministic — no Claude Code,
 * no API keys needed. Used to test the WebSocket → node-pty → PTY stdin
 * delivery pipeline in isolation.
 *
 * Protocol (identical to ws-server.mjs):
 *   Client → Server:  { type: "stdin", data: "..." }
 *   Server → Client:  { type: "stdin_ack", bytes: N }
 *                      { type: "stdin_error", error: "..." }
 *                      { type: "stdout", data: "..." }
 *                      { type: "buffer", data: "..." }
 *                      { type: "exit", code: N }
 */

import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const PORT = 3000;
let outputBuffer = '';
const clients = new Set();

const wss = new WebSocketServer({ port: PORT });

// Spawn bash in a PTY — same mechanism as ws-server.mjs spawns Claude Code
const shell = pty.spawn('bash', ['--norc', '--noprofile'], {
  name: 'xterm-256color',
  cols: 200,
  rows: 50,
  cwd: '/home/user',
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    // Simple prompt so we can detect readiness
    PS1: 'READY> ',
  },
});

let processExited = false;

shell.onData((data) => {
  outputBuffer += data;
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'stdout', data }));
    }
  }
});

shell.onExit(({ exitCode }) => {
  processExited = true;
  const exitMessage = JSON.stringify({ type: 'exit', code: exitCode });
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(exitMessage);
    }
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);

  // Send full buffer to new client (same as ws-server.mjs)
  if (outputBuffer.length > 0) {
    ws.send(JSON.stringify({ type: 'buffer', data: outputBuffer }));
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'stdin') {
        if (shell && !processExited) {
          // Same stdin handling as ws-server.mjs:
          // Ensure carriage return at end for prompt submission
          const input = msg.data.endsWith('\r') ? msg.data : msg.data + '\r';

          try {
            shell.write(input);
            ws.send(JSON.stringify({ type: 'stdin_ack', bytes: input.length }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'stdin_error', error: err.message }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'stdin_error', error: 'Process not ready or exited' }));
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'stdin_error', error: e.message }));
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

console.log(`[test-stdin-server] Listening on port ${PORT}`);
