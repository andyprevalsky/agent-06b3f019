/**
 * Losing hedge legs → schema `attempts[]` (outcome `lost_race`). Their tokens
 * were never shown to the caller; the archive is their only record.
 */

import type { ArchiveAttempt } from '../llmArchiveRecord';
import type { AttemptCollector } from '../llmDump';
import {
  archiveOutputFromAccumulator,
  createStreamAccumulator,
  dumpDisplayModel,
  foldRoseChunk,
} from './completionChunks';

export function archiveAttempts(lost: AttemptCollector['lost']): ArchiveAttempt[] {
  return lost.map(({ branch, chunks }) => {
    const acc = createStreamAccumulator();
    for (const chunk of chunks) foldRoseChunk(acc, chunk);
    // Loser chunks are folded after the race, so call-relative timing is unknown.
    const output = { ...archiveOutputFromAccumulator(acc), timing: {} };
    return {
      model: acc.metadata.actual_model ? dumpDisplayModel(acc.metadata.actual_model) : null,
      pool_name: acc.metadata.pool_name || null,
      outcome: 'lost_race',
      branch,
      output,
    };
  });
}
