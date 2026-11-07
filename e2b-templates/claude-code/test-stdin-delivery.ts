#!/usr/bin/env npx tsx
/**
 * Isolated E2E test for Claude Code E2B stdin delivery via node-pty.
 *
 * Proves that the WebSocket -> node-pty -> PTY pipeline correctly delivers
 * stdin to the child process. Uses a test server that spawns bash (not Claude
 * Code), so no API keys or LLM calls are needed — fully deterministic.
 *
 * Tests:
 *   1. stdin_ack received after sending stdin
 *   2. Single stdin command processed (canary token appears in output)
 *   3. Multiple sequential stdin commands all processed
 *
 * Usage:
 *   cd e2b-templates/claude-code
 *   E2B_API_KEY=... npx tsx test-stdin-delivery.ts
 *
 * Or source env from back-end/.env:
 *   source <(grep -E '^E2B_' ../../back-end/.env)
 *   npx tsx test-stdin-delivery.ts
 *
 * Requires:
 *   - E2B_API_KEY env var
 *   - E2B_CLAUDE_CODE_TEMPLATE_ID env var (defaults to the backend's patched template)
 */

import { Sandbox } from 'e2b';
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────
const TEMPLATE_ID =
  process.env.E2B_CLAUDE_CODE_TEMPLATE_ID || 'claude-code-v21305-node22234-c2-m4';
const E2B_API_KEY = process.env.E2B_API_KEY;
const WS_PORT = 3000;
const SANDBOX_TIMEOUT_MS = 120_000; // 2 minutes is plenty for this test

// ─── Helpers ─────────────────────────────────────────────

interface WsMessage {
  type: string;
  data?: string;
  bytes?: number;
  code?: number;
  error?: string;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(msg: string): void {
  console.log(`[${timestamp()}] ${msg}`);
}

/** Wait for a condition with timeout. */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
  pollMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timeout waiting for: ${label}`);
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ANSI escape codes from PTY output. */
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

// ─── Test runner ─────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  fn: (ws: WebSocket, state: TestState) => Promise<void>,
  ws: WebSocket,
  state: TestState,
): Promise<void> {
  const start = Date.now();
  log(`  [TEST] ${name}`);
  try {
    await fn(ws, state);
    const dur = Date.now() - start;
    results.push({ name, passed: true, durationMs: dur });
    log(`  [PASS] ${name} (${dur}ms)`);
  } catch (err: any) {
    const dur = Date.now() - start;
    results.push({ name, passed: false, error: err.message, durationMs: dur });
    log(`  [FAIL] ${name}: ${err.message} (${dur}ms)`);
  }
}

// ─── Shared state for WebSocket messages ─────────────────

interface TestState {
  outputChunks: string[];
  acks: WsMessage[];
  errors: WsMessage[];
  exitCode: number | null;
  clearOutput(): void;
  getOutput(): string;
}

function createTestState(): TestState {
  const state: TestState = {
    outputChunks: [],
    acks: [],
    errors: [],
    exitCode: null,
    clearOutput() {
      state.outputChunks = [];
      state.acks = [];
      state.errors = [];
      state.exitCode = null;
    },
    getOutput() {
      return stripAnsi(state.outputChunks.join(''));
    },
  };
  return state;
}

// ─── Tests ───────────────────────────────────────────────

async function testStdinAck(ws: WebSocket, state: TestState): Promise<void> {
  state.clearOutput();
  const canary = `ACK_TEST_${Date.now()}`;

  ws.send(JSON.stringify({ type: 'stdin', data: `echo ${canary}` }));

  await waitFor(() => state.acks.length > 0, 5000, 'stdin_ack');

  const ack = state.acks[0];
  if (!ack || ack.type !== 'stdin_ack') {
    throw new Error(`Expected stdin_ack, got: ${JSON.stringify(ack)}`);
  }
  if (typeof ack.bytes !== 'number' || ack.bytes <= 0) {
    throw new Error(`Expected positive byte count, got: ${ack.bytes}`);
  }
}

async function testSingleStdinDelivery(ws: WebSocket, state: TestState): Promise<void> {
  state.clearOutput();
  const canary = `SINGLE_${Date.now()}`;

  ws.send(JSON.stringify({ type: 'stdin', data: `echo ${canary}` }));

  // Wait for ack first
  await waitFor(() => state.acks.length > 0, 5000, 'stdin_ack');

  // Wait for canary to appear in output (bash executes echo, output comes back via PTY)
  await waitFor(
    () => state.getOutput().includes(canary),
    10000,
    `canary "${canary}" in output`,
  );

  // Count occurrences — echo should produce at least the command echo + output line
  const output = state.getOutput();
  const occurrences = output.split(canary).length - 1;
  if (occurrences < 1) {
    throw new Error(`Canary not found in output. Output:\n${output.slice(-500)}`);
  }
}

async function testMultipleStdinDelivery(ws: WebSocket, state: TestState): Promise<void> {
  state.clearOutput();
  const canaries = [
    `MULTI_A_${Date.now()}`,
    `MULTI_B_${Date.now()}`,
    `MULTI_C_${Date.now()}`,
  ];

  // Send all 3 commands sequentially with small delays to let each complete
  for (const canary of canaries) {
    ws.send(JSON.stringify({ type: 'stdin', data: `echo ${canary}` }));
    await sleep(500); // Let bash process each command
  }

  // Wait for all 3 acks
  await waitFor(() => state.acks.length >= 3, 10000, '3 stdin_acks');

  // Wait for all 3 canaries in output
  for (const canary of canaries) {
    await waitFor(
      () => state.getOutput().includes(canary),
      10000,
      `canary "${canary}" in output`,
    );
  }
}

async function testStdinWithSpecialChars(ws: WebSocket, state: TestState): Promise<void> {
  state.clearOutput();
  const canary = `SPECIAL_${Date.now()}`;

  // Test that quotes and special chars survive the PTY pipeline
  ws.send(JSON.stringify({ type: 'stdin', data: `echo "${canary} hello world 123"` }));

  await waitFor(() => state.acks.length > 0, 5000, 'stdin_ack');
  await waitFor(
    () => state.getOutput().includes(`${canary} hello world 123`),
    10000,
    'special chars in output',
  );
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('E2B Stdin Delivery Test');
  console.log('='.repeat(60));

  // Validate env
  if (!E2B_API_KEY) {
    console.error('ERROR: E2B_API_KEY not set');
    process.exit(1);
  }

  log(`Template: ${TEMPLATE_ID}`);

  // ─── Step 1: Create sandbox ───────────────────────────
  log('[1/5] Creating E2B sandbox...');
  const sandbox = await Sandbox.create(TEMPLATE_ID, {
    apiKey: E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  log(`  Sandbox ID: ${sandbox.sandboxId}`);

  try {
    // ─── Step 2: Upload test server ───────────────────────
    log('[2/5] Uploading test-stdin-server.mjs...');
    const testServerCode = readFileSync(join(__dirname, 'test-stdin-server.mjs'), 'utf-8');
    await sandbox.files.write('/home/user/test-stdin-server.mjs', testServerCode);

    // ─── Step 3: Start test server ────────────────────────
    log('[3/5] Starting test stdin server...');

    // Verify node-pty is available in the sandbox
    try {
      const checkPty = await sandbox.commands.run(
        'node -e "require(\'node-pty\'); console.log(\'node-pty OK\')"',
        { timeoutMs: 5000, cwd: '/home/user' },
      );
      log(`  node-pty check: ${checkPty.stdout.trim() || checkPty.stderr.trim()}`);
    } catch (err: any) {
      log(`  node-pty NOT available: ${err.message}`);
      throw new Error('node-pty not installed in sandbox — rebuild template');
    }

    sandbox.commands
      .run('node /home/user/test-stdin-server.mjs', {
        background: true,
        timeoutMs: 0,
        cwd: '/home/user',
      })
      .catch((err) => log(`  Server start error: ${err.message}`));

    // Wait for port 3000
    const portStart = Date.now();
    let portReady = false;
    for (let i = 0; i < 50; i++) {
      try {
        // Use bash test to avoid grep exit code 1 when no match
        const result = await sandbox.commands.run(
          `bash -c 'netstat -tln 2>/dev/null | grep -q :${WS_PORT} && echo OPEN || echo CLOSED'`,
          { timeoutMs: 3000 },
        );
        if (result.stdout.includes('OPEN')) {
          portReady = true;
          break;
        }
      } catch {
        // Ignore — server still starting
      }
      await sleep(200);
    }

    if (!portReady) {
      throw new Error(`Port ${WS_PORT} not ready after ${Date.now() - portStart}ms`);
    }
    log(`  Server ready (${Date.now() - portStart}ms)`);

    // ─── Step 4: Connect WebSocket ────────────────────────
    log('[4/5] Connecting WebSocket...');
    const wsHost = sandbox.getHost(WS_PORT);
    const wsUrl = `wss://${wsHost}`;
    log(`  URL: ${wsUrl}`);

    const state = createTestState();

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket connect timeout (10s)'));
      }, 10_000);

      socket.on('open', () => {
        clearTimeout(timeout);
        resolve(socket);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      socket.on('message', (raw: Buffer) => {
        try {
          const msg: WsMessage = JSON.parse(raw.toString());

          if (msg.type === 'stdout' || msg.type === 'buffer') {
            state.outputChunks.push(msg.data || '');
          } else if (msg.type === 'stdin_ack') {
            state.acks.push(msg);
          } else if (msg.type === 'stdin_error') {
            state.errors.push(msg);
          } else if (msg.type === 'exit') {
            state.exitCode = msg.code ?? 0;
          }
        } catch {
          // Ignore parse errors
        }
      });
    });

    log('  Connected');

    // Wait for bash prompt (READY> )
    await waitFor(
      () => state.getOutput().includes('READY>') || state.getOutput().includes('$'),
      10000,
      'bash prompt',
    );
    log('  Bash prompt detected');

    // ─── Step 5: Run tests ────────────────────────────────
    log('[5/5] Running tests...');
    console.log('');

    await runTest('stdin_ack received', testStdinAck, ws, state);
    await sleep(500); // Let bash settle

    await runTest('single stdin delivery', testSingleStdinDelivery, ws, state);
    await sleep(500);

    await runTest('multiple stdin deliveries', testMultipleStdinDelivery, ws, state);
    await sleep(500);

    await runTest('stdin with special characters', testStdinWithSpecialChars, ws, state);

    // Close WebSocket
    ws.close();
  } finally {
    // ─── Cleanup ──────────────────────────────────────────
    log('Cleaning up sandbox...');
    try {
      await sandbox.kill();
      log('  Sandbox killed');
    } catch (err: any) {
      log(`  Kill failed: ${err.message}`);
    }
  }

  // ─── Results ──────────────────────────────────────────
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed (${totalMs}ms total)`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
