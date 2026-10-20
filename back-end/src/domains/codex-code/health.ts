import { connectToSandbox } from '../../providers/e2b';
import { createLogger } from '../../providers/logger';
import { isLocalDeviceSandboxId } from '../../providers/localDevices/hub';
import { localDeviceSessionHealth } from '../../providers/localDevices/session';
import { logJson } from '../../utils/log';

const log = createLogger('CodexCode');

export interface HealthCheckResult {
  alive: boolean;
  sandbox_id: string;
  ws_server_running?: boolean;
  codex_running?: boolean;
  diagnostics?: Record<string, string>;
  error?: string;
}

interface SandboxConnection {
  commands: {
    run: (
      cmd: string,
      opts: { timeoutMs: number }
    ) => Promise<{ exitCode: number; stdout: string }>;
  };
}

async function extractDiagnostics(sandbox: SandboxConnection): Promise<Record<string, string>> {
  const diagnostics: Record<string, string> = {};

  const dmesgResult = await sandbox.commands.run(
    'dmesg 2>/dev/null | grep -i "killed process\\|oom\\|out of memory" | tail -10 || echo "no_oom"',
    { timeoutMs: 5000 }
  );
  diagnostics.oom_check = dmesgResult.stdout.trim();

  const memResult = await sandbox.commands.run('free -m 2>/dev/null || echo "free not available"', {
    timeoutMs: 5000,
  });
  diagnostics.memory = memResult.stdout.trim();

  const psResult = await sandbox.commands.run(
    'ps aux --sort=-%mem 2>/dev/null | head -15 || echo "ps not available"',
    { timeoutMs: 5000 }
  );
  diagnostics.processes = psResult.stdout.trim();

  const crashResult = await sandbox.commands.run(
    'ls -la /tmp/*.log /var/crash/* 2>/dev/null || echo "no_crash_files"',
    { timeoutMs: 5000 }
  );
  diagnostics.crash_files = crashResult.stdout.trim();

  const logsResult = await sandbox.commands.run(
    'tail -50 /tmp/ws-server.log 2>/dev/null || echo "no_ws_log"',
    { timeoutMs: 5000 }
  );
  diagnostics.ws_log = logsResult.stdout.trim();

  return diagnostics;
}

async function probeSandboxProcesses(
  sandbox: SandboxConnection,
  sandboxId: string
): Promise<HealthCheckResult> {
  const wsCheck = await sandbox.commands.run('pgrep -f ws-server.mjs || echo not_running', {
    timeoutMs: 5000,
  });
  const wsRunning = !wsCheck.stdout.includes('not_running');

  const codexCheck = await sandbox.commands.run('pgrep -f "codex" || echo not_running', {
    timeoutMs: 5000,
  });
  const codexRunning = !codexCheck.stdout.includes('not_running');

  let diagnostics: Record<string, string> | undefined;
  if (!wsRunning || !codexRunning) {
    try {
      diagnostics = await extractDiagnostics(sandbox);
      log.info(`Sandbox ${sandboxId} diagnostics: ${logJson(diagnostics)}`);
    } catch (diagErr) {
      log.error('Failed to extract diagnostics', {
        error: diagErr instanceof Error ? diagErr.message : String(diagErr),
      });
    }
  }

  log.info(
    `Sandbox ${sandboxId} is alive (ws=${String(wsRunning)}, codex=${String(codexRunning)})`
  );

  return {
    alive: true,
    sandbox_id: sandboxId,
    ws_server_running: wsRunning,
    codex_running: codexRunning,
    diagnostics,
  };
}

export async function checkSandboxHealth(sandboxId: string): Promise<HealthCheckResult> {
  log.info(`Health check for sandbox ${sandboxId}`);
  if (isLocalDeviceSandboxId(sandboxId)) return localDeviceSessionHealth(sandboxId);

  try {
    const sandbox = await connectToSandbox(sandboxId);
    const result = await sandbox.commands.run('echo alive', { timeoutMs: 5000 });

    if (result.exitCode === 0 && result.stdout.includes('alive')) {
      return await probeSandboxProcesses(sandbox, sandboxId);
    }

    log.info(`Sandbox ${sandboxId} exists but command failed`);
    return {
      alive: true,
      sandbox_id: sandboxId,
      ws_server_running: false,
      codex_running: false,
      error: 'Command failed',
    };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.info(`Sandbox ${sandboxId} is dead: ${errorMsg}`);

    return {
      alive: false,
      sandbox_id: sandboxId,
      error: errorMsg,
    };
  }
}
