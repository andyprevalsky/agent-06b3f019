import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CodexWsOutput {
  output: string;
  events: unknown[];
  exitCode?: number;
}

export async function waitForCodexOutput(
  wsUrl: string,
  timeoutMs = 240_000,
  waitForGoal = false
): Promise<CodexWsOutput> {
  const WebSocket = (await import('ws')).default;
  let output = '';
  const events: unknown[] = [];
  let connected = false;
  let exitSeen = false;
  let turnCompleted = false;
  let goalCompleted = false;

  return await new Promise<CodexWsOutput>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `Timed out waiting for Codex smoke. connected=${connected}, exit=${exitSeen}, output=${output.slice(-1200)}`
        )
      );
    }, timeoutMs);

    ws.on('open', () => {
      connected = true;
    });
    ws.on('message', (data: Buffer) => {
      const raw = data.toString();
      try {
        const msg = JSON.parse(raw);
        if ((msg.type === 'stdout' || msg.type === 'stderr' || msg.type === 'buffer') && msg.data) {
          output += msg.data;
        }
        const received: unknown[] =
          msg.type === 'code_agent_event' && msg.data
            ? [msg.data]
            : msg.type === 'code_agent_events' && Array.isArray(msg.data)
              ? msg.data
              : [];
        for (const event of received) {
          events.push(event);
          // The app-server transport is a persistent process: a finished turn
          // ends with turn/completed (the worker's contract), not an exit, and
          // the agent's reply arrives as a completed agent_message, not stdout.
          const typed = event as {
            type?: string;
            raw_type?: string;
            text?: unknown;
            partial?: unknown;
            status?: string;
          };
          if (
            typed.type === 'agent_message' &&
            typed.partial !== true &&
            typeof typed.text === 'string'
          ) {
            output += `${typed.text}\n`;
          }
          if (
            typed.type === 'goal' &&
            ['complete', 'blocked', 'failed', 'cleared'].includes(typed.status ?? '')
          ) {
            goalCompleted = true;
          }
          if (typed.type === 'turn_started') turnCompleted = false;
          if (typed.type === 'turn_ended' && typed.raw_type === 'turn/completed') {
            turnCompleted = true;
          }
        }
        if (msg.type === 'exit' || (turnCompleted && (!waitForGoal || goalCompleted))) {
          exitSeen = true;
          clearTimeout(timeout);
          ws.close();
          const artifactDir = process.env.BLACKBOX_TEST_ARTIFACT_DIR;
          if (artifactDir) {
            const host = new URL(wsUrl).hostname;
            writeFileSync(
              join(artifactDir, `codex-events-${host}.json`),
              JSON.stringify({ output, events }, null, 2)
            );
          }
          resolve({
            output,
            events,
            exitCode: typeof msg.code === 'number' ? msg.code : undefined,
          });
        }
      } catch {
        output += raw;
      }
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on('close', () => {
      if (!exitSeen && output.includes('CODEX_E2B_DONE')) {
        clearTimeout(timeout);
        resolve({ output, events });
      }
    });
  });
}
