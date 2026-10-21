/** HTTP mapping for a live Tilion replacement attempted without worker-carried state. */
import type { Response } from 'express';
import { TilionUncarriedStateError } from '../../providers/browser/tilion';

export function respondIfCarriedStateRequired(error: unknown, res: Response): boolean {
  if (!(error instanceof TilionUncarriedStateError)) return false;
  res.status(409).json({
    error: 'carried_state_required',
    provider: 'tilion',
    task_id: error.taskId,
    message:
      'The live Tilion session holds browser state only the worker can capture; ' +
      'retry with storage_state (Playwright storageState) in the request body.',
  });
  return true;
}
