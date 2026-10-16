import { WorkflowStartAdmissionPendingError } from '../../providers/workflowQueueAdmission';
/**
 * Internal AgentQueuePointer read for cooperative Temporal cutover.
 *
 * Workers call GET /api/agent-queue-pointer (X-API-Key) at each run_agent
 * checkpoint to decide whether to continue_as_new onto the live generation.
 */
import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { getAgentQueuePointerPayload } from './service';

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

export default router;
