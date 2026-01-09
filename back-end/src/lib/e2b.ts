import { Sandbox } from 'e2b';
import { prisma } from './prisma';

// Validate required environment variables
if (!process.env.E2B_API_KEY) {
  console.warn('E2B_API_KEY environment variable not set - Claude Code sessions disabled');
}

if (!process.env.E2B_CLAUDE_CODE_TEMPLATE_ID) {
  console.warn('E2B_CLAUDE_CODE_TEMPLATE_ID environment variable not set - Claude Code sessions disabled');
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY environment variable not set - Claude Code sessions disabled');
}

const WS_PORT = 3000;
const SANDBOX_TIMEOUT_MS = 600000; // 10 minutes
const WS_READY_TIMEOUT_MS = 10000;
const WS_READY_POLL_INTERVAL_MS = 100;

/**
 * Create a new E2B sandbox with Claude Code and WebSocket streaming.
 *
 * @param agentId - The agent creating this session
 * @param goal - The goal for Claude Code to accomplish
 * @returns Session info including WebSocket URL for terminal streaming
 */
export async function createClaudeCodeSession(
  agentId: string,
  goal: string
): Promise<{ wsUrl: string; taskId: string; sandboxId: string }> {
  console.log(`[E2B] Creating Claude Code session for agent ${agentId}...`);

  if (!process.env.E2B_API_KEY || !process.env.E2B_CLAUDE_CODE_TEMPLATE_ID || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('E2B or ANTHROPIC_API_KEY environment variables not configured');
  }

  // Create DB session first to get the ID
  const dbSession = await prisma.claudeCodeSession.create({
    data: {
      agentId,
      sandboxId: 'pending', // Will update after sandbox creation
      streamUrl: 'pending', // Will update with wsUrl
      goal,
      status: 'ACTIVE',
    }
  });

  // Create sandbox with env vars for the WS server
  const sandbox = await Sandbox.create(process.env.E2B_CLAUDE_CODE_TEMPLATE_ID, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: SANDBOX_TIMEOUT_MS,
    envs: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_GOAL: goal,
    },
  });

  console.log(`[E2B] Created sandbox: ${sandbox.sandboxId}`);

  // Get WebSocket URL for the frontend to connect to
  const wsHost = sandbox.getHost(WS_PORT);
  const wsUrl = `wss://${wsHost}`;

  // Start the WebSocket server (runs Claude Code internally)
  sandbox.commands.run('node /home/user/ws-server.mjs', {
    background: true,
  }).catch(err => console.error(`[E2B] Failed to start WS server:`, err));

  // Wait for WS server to be ready
  console.log(`[E2B] Waiting for WebSocket server to start...`);
  const startTime = Date.now();

  while (Date.now() - startTime < WS_READY_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, WS_READY_POLL_INTERVAL_MS));
    try {
      // Check if port 3000 is listening
      const result = await sandbox.commands.run(`netstat -tln | grep :${WS_PORT}`, { timeoutMs: 2000 });
      if (result.exitCode === 0 && result.stdout.includes(`:${WS_PORT}`)) {
        const elapsedMs = Date.now() - startTime;
        console.log(`[E2B] WebSocket server ready in ${elapsedMs}ms`);
        break;
      }
    } catch {
      // Ignore errors, just retry
    }
  }

  const totalElapsed = Date.now() - startTime;
  if (totalElapsed >= WS_READY_TIMEOUT_MS) {
    console.warn(`[E2B] WebSocket server readiness check timed out after ${totalElapsed}ms`);
  }

  // Update DB with actual sandbox ID and WS URL
  await prisma.claudeCodeSession.update({
    where: { id: dbSession.id },
    data: {
      sandboxId: sandbox.sandboxId,
      streamUrl: wsUrl,
    }
  });

  console.log(`[E2B] Session ready: ${dbSession.id}, WS: ${wsUrl}`);

  return {
    wsUrl,
    taskId: dbSession.id,
    sandboxId: sandbox.sandboxId,
  };
}

/**
 * Close a Claude Code session (stops the sandbox).
 */
export async function closeClaudeCodeSession(taskId: string): Promise<void> {
  console.log(`[E2B] Closing Claude Code session ${taskId}...`);

  const session = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId }
  });

  if (!session) {
    throw new Error(`Claude Code session not found: ${taskId}`);
  }

  try {
    // Kill the sandbox
    const desktop = await Sandbox.connect(session.sandboxId, {
      apiKey: process.env.E2B_API_KEY,
    });
    await desktop.kill();
    console.log(`[E2B] Killed sandbox: ${session.sandboxId}`);
  } catch (error) {
    console.error(`[E2B] Failed to kill sandbox:`, error);
    // Continue to update DB even if kill fails
  }

  // Update DB
  await prisma.claudeCodeSession.update({
    where: { id: taskId },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
    }
  });

  console.log(`[E2B] Session closed: ${taskId}`);
}

/**
 * Get session info from database.
 */
export async function getClaudeCodeSession(taskId: string) {
  return await prisma.claudeCodeSession.findUnique({
    where: { id: taskId }
  });
}

/**
 * Get session by sandbox ID.
 */
export async function getClaudeCodeSessionBySandboxId(sandboxId: string) {
  return await prisma.claudeCodeSession.findUnique({
    where: { sandboxId }
  });
}

/**
 * Connect to an existing sandbox for automation.
 * Returns the sandbox instance for running commands.
 */
export async function connectToSandbox(sandboxId: string): Promise<Sandbox> {
  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B_API_KEY not configured');
  }

  return await Sandbox.connect(sandboxId, {
    apiKey: process.env.E2B_API_KEY,
  });
}
