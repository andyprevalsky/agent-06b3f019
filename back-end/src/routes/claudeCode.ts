import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, authenticate } from '../middleware/auth';
import {
  createClaudeCodeSession,
  closeClaudeCodeSession,
  getClaudeCodeSession,
} from '../lib/e2b';
import { FilePointer } from '../lib/storage';

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
});

const closeSessionSchema = z.object({
  task_id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
});

/**
 * POST /api/claude-code-session/create
 * Create a new E2B sandbox with Claude Code and WebSocket streaming.
 * Called by agents service to create a new session.
 * ANTHROPIC_API_KEY is injected from backend environment.
 */
router.post('/create', authenticate, async (req: AuthRequest, res) => {
  try {
    const { agent_id, goal, attachments } = createSessionSchema.parse(req.body);

    console.log(`[ClaudeCode] Creating session for agent ${agent_id}${attachments?.length ? ` with ${attachments.length} attachments` : ''}`);

    const session = await createClaudeCodeSession(agent_id, goal, attachments as FilePointer[] | undefined);

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
    const { task_id, user_id, agent_id } = closeSessionSchema.parse(req.body);

    console.log(`🖥️ Closing Claude Code session ${task_id}`);

    const result = await closeClaudeCodeSession(task_id, user_id, agent_id);

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

export default router;
