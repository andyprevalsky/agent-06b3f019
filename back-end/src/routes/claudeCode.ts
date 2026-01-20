import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';
import {
  createClaudeCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
  connectToSandbox,
} from '../lib/e2b';
import { FilePointer } from '../lib/storage';
import { checkGithubRepoAccess } from '../lib/github';

const router = Router();

// Validation schemas
const filePointerSchema = z.object({
  id: z.string(),
  storage_path: z.string().optional(),
  base64_data: z.string().optional(),
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number(),
  created_at: z.string(),
  created_by_agent_id: z.string().optional(),
});

const createSessionSchema = z.object({
  agent_id: z.string().uuid(),
  goal: z.string(),
  attachments: z.array(filePointerSchema).optional(),
  github_repo_url: z.string().optional(),
  user_id: z.string().uuid().optional(), // Required for GitHub repo access check
});

const closeSessionSchema = z.object({
  task_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
  additional_paths: z.array(z.string()).optional(), // Additional file paths to extract (e.g., from verifier)
});

/**
 * POST /api/claude-code-session/create
 * Create a new E2B sandbox with Claude Code and WebSocket streaming.
 * Called by agents service to create a new session.
 * ANTHROPIC_API_KEY is injected from backend environment.
 */
router.post('/create', authenticate, async (req: AuthRequest, res) => {
  try {
    const { agent_id, goal, attachments, github_repo_url, user_id } = createSessionSchema.parse(req.body);

    console.log(`[ClaudeCode] Creating session for agent ${agent_id}${attachments?.length ? ` with ${attachments.length} attachments` : ''}${github_repo_url ? ` with GitHub repo ${github_repo_url}` : ''}`);

    // Check GitHub repo access if specified
    let normalizedRepoUrl: string | undefined;
    if (github_repo_url) {
      if (!user_id) {
        return res.status(400).json({
          error: 'user_id is required when using github_repo_url',
          code: 'MISSING_USER_ID',
        });
      }

      const accessCheck = await checkGithubRepoAccess(user_id, github_repo_url);
      if (!accessCheck.allowed) {
        console.log(`[ClaudeCode] GitHub access denied for user ${user_id}: ${accessCheck.error}`);
        return res.status(403).json({
          error: accessCheck.error,
          code: 'GITHUB_ACCESS_DENIED',
        });
      }
      normalizedRepoUrl = accessCheck.normalizedUrl!;
      console.log(`[ClaudeCode] GitHub access granted for ${normalizedRepoUrl}`);
    }

    const session = await createClaudeCodeSession(
      agent_id,
      goal,
      attachments as FilePointer[] | undefined,
      normalizedRepoUrl
    );

    res.json({
      success: true,
      task_id: session.taskId,
      sandbox_id: session.sandboxId,
      ws_url: session.wsUrl,
      uploaded_files: session.uploadedFiles,
    });

  } catch (error) {
    console.error('Failed to create Claude Code session:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create Claude Code session'
    });
  }
});

/**
 * POST /api/claude-code-session/close
 * Close a Claude Code session (kills the sandbox).
 */
router.post('/close', authenticate, async (req: AuthRequest, res) => {
  try {
    const { task_id, user_id, agent_id, additional_paths } = closeSessionSchema.parse(req.body);

    console.log(`🖥️ Closing Claude Code session ${task_id}${additional_paths?.length ? ` with ${additional_paths.length} additional paths` : ''}`);

    const result = await closeClaudeCodeSession(task_id, user_id, agent_id, additional_paths);

    res.json({
      success: true,
      status: 'CLOSED',
      output_files: result.outputFiles,
    });

  } catch (error) {
    console.error('❌ Failed to close Claude Code session:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to close Claude Code session'
    });
  }
});

/**
 * GET /api/claude-code-session/:taskId
 * Get session info for a task.
 */
router.get('/:taskId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { taskId } = req.params;

    const session = await getClaudeCodeSession(taskId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      task_id: session.id,
      sandbox_id: session.sandboxId,
      stream_url: session.streamUrl,
      goal: session.goal,
      status: session.status,
      output: session.output,
      created_at: session.createdAt,
      closed_at: session.closedAt,
    });

  } catch (error) {
    console.error('❌ Failed to get Claude Code session:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get session info'
    });
  }
});

/**
 * GET /api/claude-code-session/agent/:agentId
 * Get all sessions for an agent.
 */
router.get('/agent/:agentId', authenticate, async (req: AuthRequest, res) => {
  try {
    const { agentId } = req.params;

    const sessions = await prisma.claudeCodeSession.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    res.json({ sessions });

  } catch (error) {
    console.error('❌ Failed to get agent sessions:', error);
    res.status(500).json({ error: 'Failed to get agent sessions' });
  }
});

/**
 * POST /api/claude-code-session/:taskId/output
 * Persist terminal output for a Claude Code session.
 * Called by the agent worker after the session completes.
 */
router.post('/:taskId/output', authenticate, async (req: AuthRequest, res) => {
  try {
    const { taskId } = req.params;
    const { output } = req.body;

    if (!output || typeof output !== 'string') {
      return res.status(400).json({ error: 'output field required' });
    }

    console.log(`[ClaudeCode] Persisting output for session ${taskId} (${output.length} bytes)`);

    await prisma.claudeCodeSession.update({
      where: { id: taskId },
      data: {
        output,
        status: 'COMPLETED',
        closedAt: new Date(),
      },
    });

    res.json({ success: true });

  } catch (error) {
    console.error('Failed to persist Claude Code output:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to persist output'
    });
  }
});

/**
 * GET /api/claude-code-session/:sandboxId/health
 * Check if an E2B sandbox is still alive and responsive.
 * Used by agents to determine root cause of WebSocket disconnects.
 *
 * If sandbox is alive, extracts diagnostic info to help debug crashes.
 */
router.get('/:sandboxId/health', authenticate, async (req: AuthRequest, res) => {
  const { sandboxId } = req.params;

  console.log(`[ClaudeCode] Health check for sandbox ${sandboxId}`);

  try {
    // Try to connect to the sandbox
    const sandbox = await connectToSandbox(sandboxId);

    // Try to run a simple command to verify it's responsive
    const result = await sandbox.commands.run('echo alive', { timeoutMs: 5000 });

    if (result.exitCode === 0 && result.stdout.includes('alive')) {
      // Sandbox is alive - also check if WS server process is running
      const wsCheck = await sandbox.commands.run('pgrep -f ws-server.mjs || echo not_running', { timeoutMs: 5000 });
      const wsRunning = !wsCheck.stdout.includes('not_running');

      // Check if Claude process is running
      const claudeCheck = await sandbox.commands.run('pgrep -f "claude" || echo not_running', { timeoutMs: 5000 });
      const claudeRunning = !claudeCheck.stdout.includes('not_running');

      // If WS or Claude not running, extract diagnostic info
      let diagnostics: Record<string, string> | undefined;
      if (!wsRunning || !claudeRunning) {
        diagnostics = {};
        try {
          // Check for OOM killer
          const dmesgResult = await sandbox.commands.run('dmesg 2>/dev/null | grep -i "killed process\\|oom\\|out of memory" | tail -10 || echo "no_oom"', { timeoutMs: 5000 });
          diagnostics.oom_check = dmesgResult.stdout.trim();

          // Get memory usage
          const memResult = await sandbox.commands.run('free -m 2>/dev/null || echo "free not available"', { timeoutMs: 5000 });
          diagnostics.memory = memResult.stdout.trim();

          // Get process list
          const psResult = await sandbox.commands.run('ps aux --sort=-%mem 2>/dev/null | head -15 || echo "ps not available"', { timeoutMs: 5000 });
          diagnostics.processes = psResult.stdout.trim();

          // Check if there's a core dump or crash log
          const crashResult = await sandbox.commands.run('ls -la /tmp/*.log /var/crash/* 2>/dev/null || echo "no_crash_files"', { timeoutMs: 5000 });
          diagnostics.crash_files = crashResult.stdout.trim();

          // Get last lines of any log files that might exist
          const logsResult = await sandbox.commands.run('tail -50 /tmp/ws-server.log 2>/dev/null || echo "no_ws_log"', { timeoutMs: 5000 });
          diagnostics.ws_log = logsResult.stdout.trim();

          console.log(`[ClaudeCode] Sandbox ${sandboxId} diagnostics:`, JSON.stringify(diagnostics, null, 2));
        } catch (diagErr) {
          console.error(`[ClaudeCode] Failed to extract diagnostics:`, diagErr);
        }
      }

      console.log(`[ClaudeCode] Sandbox ${sandboxId} is alive (ws=${wsRunning}, claude=${claudeRunning})`);

      res.json({
        alive: true,
        sandbox_id: sandboxId,
        ws_server_running: wsRunning,
        claude_running: claudeRunning,
        diagnostics,
      });
    } else {
      // Sandbox exists but command failed
      console.log(`[ClaudeCode] Sandbox ${sandboxId} exists but command failed`);
      res.json({
        alive: true,
        sandbox_id: sandboxId,
        ws_server_running: false,
        claude_running: false,
        error: 'Command failed',
      });
    }
  } catch (error) {
    // Sandbox doesn't exist or can't connect
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`[ClaudeCode] Sandbox ${sandboxId} is dead: ${errorMsg}`);

    res.json({
      alive: false,
      sandbox_id: sandboxId,
      error: errorMsg,
    });
  }
});

export default router;
