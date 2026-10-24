export interface CodexWsOutput {
  output: string;
  events: unknown[];
  exitCode?: number;
}

export async function waitForCodexOutput(
  wsUrl: string,
  timeoutMs = 240_000
): Promise<CodexWsOutput> {
  const WebSocket = (await import('ws')).default;
  let output = '';
  const events: unknown[] = [];
  let connected = false;
  let exitSeen = false;
  let turnCompleted = false;

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
          };
          if (
            typed.type === 'agent_message' &&
            typed.partial !== true &&
            typeof typed.text === 'string'
          ) {
            output += `${typed.text}\n`;
          }
          if (typed.type === 'turn_ended' && typed.raw_type === 'turn/completed') {
            turnCompleted = true;
          }
        }
        if (msg.type === 'exit' || turnCompleted) {
          exitSeen = true;
          clearTimeout(timeout);
          ws.close();
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
