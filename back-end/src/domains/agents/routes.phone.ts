/**
 * First-party phone-call recording playback.
 * Mounted by routes.ts.
 */
import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as routeGuards from './routes.guards';
import * as phoneCallRecordingService from './phoneCallRecordingService';
import { handleRouteError } from './routes.helpers';

const router = Router({ mergeParams: true });
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.get(
  '/:id/phone-calls/:callId/recording',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const { userId } = routeGuards.resolveAgentReadAccess(req);
      const result = await phoneCallRecordingService.getPhoneCallRecording({
        agentId: req.params.id,
        callId: req.params.callId,
        requesterUserId: userId,
        isInternal: req.isInternal === true,
      });
      if (result.status !== 200) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Type', result.contentType);
      res.send(result.body);
    } catch (error) {
      handleRouteError(res, error, 'Failed to load phone call recording', {
        agent_id: req.params.id,
        call_id: req.params.callId,
      });
    }
  })
);

export default router;
