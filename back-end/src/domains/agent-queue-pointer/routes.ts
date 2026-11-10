import { WorkflowStartAdmissionPendingError } from '../../providers/workflowQueueAdmission';
/**
 * Internal AgentQueuePointer read for cooperative Temporal cutover.
 *
 * Workers call GET /api/agent-queue-pointer (X-API-Key) at each run_agent
 * checkpoint to decide whether to continue_as_new onto the live generation.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticateInternal, type AuthRequest } from '../../providers/auth';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { getAgentQueuePointerPayload } from './service';
import { recordWorkerQueueCapabilities } from '../../providers/workerQueueCapabilities';

const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    // Workers authenticate with the shared backend API key (isInternal).
    // Do not expose the pointer to end-user JWT/API-key clients.
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal API key required' });
      return;
    }

    const workflowId = req.get('X-Workflow-Id');
    const runId = req.get('X-Workflow-Run-Id');
    try {
      res.json(
        await getAgentQueuePointerPayload(
          workflowId !== undefined &&
            workflowId.length > 0 &&
            runId !== undefined &&
            runId.length > 0
            ? { workflowId, runId }
            : undefined,
          req.get('X-Queue-Pointer-Observe') === '1'
        )
      );
    } catch (error) {
      if (!(error instanceof WorkflowStartAdmissionPendingError)) throw error;
      res.status(409).json({ error: error.message });
    }
  })
);

/** The worker's capability record: its queue and the workflow types it registers. */
const capabilitiesBodySchema = z.object({
  task_queue: z.string().min(1).max(200),
  workflow_types: z.array(z.string().min(1).max(100)).min(1).max(50),
});

/**
 * PUT /api/agent-queue-pointer/capabilities {task_queue, workflow_types}: a worker
 * records the workflow types it registers for its queue at start (idempotent).
 * Internal callers only (the shared backend API key).
 */
router.put(
  '/capabilities',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req, res) => {
    const body = capabilitiesBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid body', details: body.error.issues });
      return;
    }
    try {
      await recordWorkerQueueCapabilities(body.data.task_queue, body.data.workflow_types);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    res.json({ recorded: true });
  })
);

export default router;
