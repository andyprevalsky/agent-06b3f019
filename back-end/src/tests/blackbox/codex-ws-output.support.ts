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
        if (msg.type === 'code_agent_event' && msg.data) {
          events.push(msg.data);
        }
        if (msg.type === 'code_agent_events' && Array.isArray(msg.data)) {
          events.push(...msg.data);
        }
        if (msg.type === 'exit') {
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
