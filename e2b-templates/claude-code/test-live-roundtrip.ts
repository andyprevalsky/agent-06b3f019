#!/usr/bin/env npx tsx
/**
 * Live round-trip test for Claude Code stdin delivery in E2B.
 *
 * Full integration test that proves the meta-agent → Claude Code stdin
 * pipeline works end-to-end with a real Claude Code session:
 *
 *   1. Start Claude Code with goal: "Hi Claude - ask me any question"
 *   2. Wait for Claude to respond with a question (silence = Claude waiting)
 *   3. Send a meta-agent response via stdin
 *   4. Wait for Claude to respond to the meta-agent's answer
 *   5. Print full terminal output
 *
 * Usage:
 *   cd e2b-templates/claude-code
 *   export $(grep -E '^(E2B_|ANTHROPIC_API_KEY)' ../../back-end/.env | xargs)
 *   npx tsx test-live-roundtrip.ts
 */

import { Sandbox } from 'e2b';
import WebSocket from 'ws';

// ─── Config ──────────────────────────────────────────────
import { readFileSync } from 'fs';

const TEMPLATE_ID = process.env.E2B_CLAUDE_CODE_TEMPLATE_ID || 'claude-code-v21305-c2-m4';
const E2B_API_KEY = process.env.E2B_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Per-user credentials (claudeAuth) — pass as env var or file path
const CLAUDE_CODE_CREDENTIALS =
  process.env.CLAUDE_CODE_CREDENTIALS ||
  (() => {
    try {
      return readFileSync('/tmp/claude_code_credentials.json', 'utf-8');
    } catch {
      return undefined;
    }
  })();
const WS_PORT = 3000;
const SANDBOX_TIMEOUT_MS = 300_000; // 5 minutes
const SILENCE_THRESHOLD_MS = 5_000; // 5s of silence = Claude is waiting for input
const META_AGENT_RESPONSE = 'My favorite color is blue. What do you think about that?';

// ─── Helpers ─────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip ANSI escape codes from PTY output. */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Claude Code Live Round-Trip Test');
  console.log('='.repeat(60));

  if (!E2B_API_KEY) {
    console.error('ERROR: E2B_API_KEY not set');
    process.exit(1);
  }
  if (!CLAUDE_CODE_CREDENTIALS && !ANTHROPIC_API_KEY) {
    console.error('ERROR: Neither CLAUDE_CODE_CREDENTIALS nor ANTHROPIC_API_KEY set');
    console.error('  Prefer CLAUDE_CODE_CREDENTIALS (claudeAuth) for prod-like behavior.');
    console.error('  To fetch: cd back-end && npx tsx scripts/query-db.ts (see test docs)');
    process.exit(1);
  }

  const GOAL = 'Hi Claude - ask me any question';
  log(`Template: ${TEMPLATE_ID}`);
  log(`Auth: ${CLAUDE_CODE_CREDENTIALS ? 'claudeAuth (per-user credentials)' : 'ANTHROPIC_API_KEY (shared key)'}`);
  log(`Goal: "${GOAL}"`);
  log(`Meta-agent response: "${META_AGENT_RESPONSE}"`);
  console.log('');

  // ─── Step 1: Create sandbox with Claude Code ──────────
  log('[1/6] Creating E2B sandbox...');
  // Build sandbox env vars — prefer claudeAuth over shared API key
  const sandboxEnvs: Record<string, string> = {
    CLAUDE_CODE_GOAL: GOAL,
  };
  if (CLAUDE_CODE_CREDENTIALS) {
    sandboxEnvs.CLAUDE_CODE_CREDENTIALS = CLAUDE_CODE_CREDENTIALS;
  } else if (ANTHROPIC_API_KEY) {
    sandboxEnvs.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
  }

  const sandbox = await Sandbox.create(TEMPLATE_ID, {
    apiKey: E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs: sandboxEnvs,
  });
  log(`  Sandbox ID: ${sandbox.sandboxId}`);

  try {
    // ─── Step 2: Start ws-server.mjs (which starts Claude Code) ─
    log('[2/6] Starting ws-server.mjs (launches Claude Code)...');
    sandbox.commands
      .run('node /home/user/ws-server.mjs', {
        background: true,
        timeoutMs: 0,
        cwd: '/home/user',
      })
      .catch((err) => log(`  ws-server error: ${err.message}`));

    // Wait for port 3000
    const portStart = Date.now();
    let portReady = false;
    for (let i = 0; i < 100; i++) {
      try {
        const result = await sandbox.commands.run(
          `bash -c 'netstat -tln 2>/dev/null | grep -q :${WS_PORT} && echo OPEN || echo CLOSED'`,
          { timeoutMs: 3000 },
        );
        if (result.stdout.includes('OPEN')) {
          portReady = true;
          break;
        }
      } catch {
        // Server still starting
      }
      await sleep(200);
    }

    if (!portReady) {
      throw new Error(`Port ${WS_PORT} not ready after ${Date.now() - portStart}ms`);
    }
    log(`  WS server ready (${Date.now() - portStart}ms)`);

    // ─── Step 3: Connect WebSocket ──────────────────────
    log('[3/6] Connecting WebSocket...');
    const wsHost = sandbox.getHost(WS_PORT);
    const wsUrl = `wss://${wsHost}`;
    log(`  URL: ${wsUrl}`);

    const outputChunks: string[] = [];
    let lastOutputTime = Date.now();
    let stdinAckReceived = false;
    let processExited = false;
    let exitCode: number | null = null;

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket connect timeout'));
      }, 15_000);

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
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'stdout' || msg.type === 'buffer') {
            outputChunks.push(msg.data || '');
            lastOutputTime = Date.now();
          } else if (msg.type === 'stdin_ack') {
            stdinAckReceived = true;
            log('  [stdin_ack received]');
          } else if (msg.type === 'stdin_error') {
            log(`  [stdin_error: ${msg.error}]`);
          } else if (msg.type === 'exit') {
            processExited = true;
            exitCode = msg.code ?? 0;
            log(`  [process exited: code=${exitCode}]`);
          }
        } catch {
          // Ignore parse errors
        }
      });
    });

    log('  Connected');

    // ─── Step 4a: Wait for server-side trust dialog auto-dismiss ─────
    log('[4/7] Waiting for server-side trust dialog handling...');

    // The server (ws-server.mjs) auto-detects and dismisses the trust dialog
    // by writing \r to the PTY. We just wait for output to stabilize.
    await sleep(5000);
    lastOutputTime = Date.now();

    // ─── Step 4b: Wait for Claude to ask a question ─────
    log('[5/7] Waiting for Claude Code to respond (silence detection)...');

    const phaseStart = Date.now();
    const MAX_WAIT_MS = 120_000; // 2 minutes max
    let silenceDetected = false;

    while (Date.now() - phaseStart < MAX_WAIT_MS) {
      if (processExited) {
        log('  Claude Code exited before we could send stdin!');
        break;
      }

      const silenceMs = Date.now() - lastOutputTime;
      const totalOutput = stripAnsi(outputChunks.join(''));

      // Need meaningful output beyond just the dialog AND silence
      // Look for substantial text (Claude's actual question)
      if (totalOutput.length > 300 && silenceMs >= SILENCE_THRESHOLD_MS) {
        silenceDetected = true;
        log(`  Silence detected (${silenceMs}ms) after ${totalOutput.length} chars of output`);
        break;
      }

      await sleep(500);
    }

    if (!silenceDetected && !processExited) {
      throw new Error(`No silence detected after ${MAX_WAIT_MS / 1000}s`);
    }

    // Print Claude's initial response
    const phase1Output = stripAnsi(outputChunks.join(''));
    console.log('');
    console.log('─'.repeat(60));
    console.log('CLAUDE CODE OUTPUT (before stdin):');
    console.log('─'.repeat(60));
    console.log(phase1Output.slice(-3000)); // Last 3000 chars
    console.log('─'.repeat(60));
    console.log('');

    if (processExited) {
      log('Cannot send stdin — process already exited');
    } else {
      // ─── Step 6: Send meta-agent response via stdin ─────
      log(`[6/7] Sending meta-agent response: "${META_AGENT_RESPONSE}"`);

      // Record output length before stdin so we can detect new output
      const outputLenBefore = outputChunks.join('').length;
      lastOutputTime = Date.now();
      stdinAckReceived = false;

      ws.send(JSON.stringify({ type: 'stdin', data: META_AGENT_RESPONSE }));

      // Wait for ack
      const ackStart = Date.now();
      while (!stdinAckReceived && Date.now() - ackStart < 5000) {
        await sleep(100);
      }

      if (stdinAckReceived) {
        log('  stdin delivered successfully (ack received)');
      } else {
        log('  WARNING: No stdin_ack received within 5s');
      }

      // ─── Step 7: Wait for Claude's response to our input ─
      log('[7/7] Waiting for Claude to respond to meta-agent input...');

      const phase2Start = Date.now();
      const PHASE2_MAX_MS = 120_000; // 2 minutes
      let phase2SilenceDetected = false;

      while (Date.now() - phase2Start < PHASE2_MAX_MS) {
        if (processExited) {
          log('  Claude Code exited');
          break;
        }

        const currentLen = outputChunks.join('').length;
        const newOutput = currentLen - outputLenBefore;
        const silenceMs = Date.now() - lastOutputTime;

        // Need new output AND silence to know Claude finished responding
        if (newOutput > 50 && silenceMs >= SILENCE_THRESHOLD_MS) {
          phase2SilenceDetected = true;
          log(`  Claude responded (${newOutput} new chars, ${silenceMs}ms silence)`);
          break;
        }

        await sleep(500);
      }

      if (!phase2SilenceDetected && !processExited) {
        const currentLen = outputChunks.join('').length;
        const newOutput = currentLen - outputLenBefore;
        log(`  Timeout — got ${newOutput} new chars but no silence`);
      }

      // Print Claude's response to our stdin
      const fullOutput = stripAnsi(outputChunks.join(''));
      const newPortion = fullOutput.slice(phase1Output.length);

      console.log('');
      console.log('─'.repeat(60));
      console.log('CLAUDE CODE OUTPUT (after meta-agent stdin):');
      console.log('─'.repeat(60));
      console.log(newPortion || '(no new output)');
      console.log('─'.repeat(60));
    }

    // Print full output
    console.log('');
    console.log('='.repeat(60));
    console.log('FULL TERMINAL OUTPUT:');
    console.log('='.repeat(60));
    const fullClean = stripAnsi(outputChunks.join(''));
    console.log(fullClean);
    console.log('='.repeat(60));

    // Close WebSocket
    ws.close();

    // ─── Verdict ──────────────────────────────────────────
    console.log('');
    const fullOutput = stripAnsi(outputChunks.join(''));
    const hasInitialResponse = fullOutput.length > 100;
    const hasStdinDelivery = stdinAckReceived;
    const hasPostStdinOutput = fullOutput.length > phase1Output.length + 50;

    console.log('='.repeat(60));
    console.log('VERDICT');
    console.log('='.repeat(60));
    console.log(`  Claude produced initial output:       ${hasInitialResponse ? 'PASS' : 'FAIL'}`);
    console.log(`  stdin_ack received:                   ${hasStdinDelivery ? 'PASS' : 'FAIL'}`);
    console.log(`  Claude responded after stdin:          ${hasPostStdinOutput ? 'PASS' : 'FAIL'}`);
    console.log('');

    if (hasInitialResponse && hasStdinDelivery && hasPostStdinOutput) {
      console.log('  RESULT: PASS — Full round-trip stdin delivery confirmed');
    } else {
      console.log('  RESULT: FAIL — See output above for details');
      process.exitCode = 1;
    }
  } finally {
    console.log('');
    log('Cleaning up sandbox...');
    try {
      await sandbox.kill();
      log('  Sandbox killed');
    } catch (err: any) {
      log(`  Kill failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
