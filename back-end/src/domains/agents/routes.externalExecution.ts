import type { Response } from 'express';
import type { HybridAuthRequest } from '../../providers/hybridAuth';
import type { CreateAgentBody } from './types';
import { incompatibleExternalLaunch } from './agentExternalExecution';

/** Server-only root execution mode: persistence is shared, execution has one owner. */
export function externalExecutionOptions(
  req: HybridAuthRequest,
  res: Response,
  body: CreateAgentBody
) {
  const mode = req.header('x-agent-execution-mode');
  if (mode === undefined) return {};
  if (req.isInternal !== true) {
    res.status(403).json({ error: 'External execution requires internal authentication' });
    return null;
  }
  if (mode !== 'external' || incompatibleExternalLaunch(body)) {
    res
      .status(400)
      .json({ error: 'External execution requires an independent root without launch options' });
    return null;
  }
  return { externalExecution: true };
}
