/**
 * Worker-posted artifacts are filed under the TRUE root of the agent tree.
 *
 *   worker POST { rootAgentId: child-or-root } ─► resolveArchiveRoot ─► store under root
 *
 * A worker that only knows its own (sub-)agent id must never create a disjoint
 * sub-agent bundle; the record bytes (and the agent_id inside them) are kept.
 */
import { resolveArchiveRoot } from '../../providers/archiveRootResolver';
import { createLogger } from '../../providers/logger';
import {
  storeWorkerArtifact as storeArtifactUnderRoot,
  storeWorkerArtifacts as storeArtifactsUnderRoot,
} from '../../providers/traceArchiveLifecycle';
import type { StoreEncryptedArtifactRequest } from './types';

export { captureAgentStart, finalizeAgent } from '../../providers/traceArchiveLifecycle';

const log = createLogger('ArchiveRoutes');

async function trueRoot(posted: string): Promise<string> {
  const root = await resolveArchiveRoot(posted);
  if (root !== posted) {
    log.info('archive.artifact.refiled_under_root', {
      posted_root_agent_id: posted,
      root_agent_id: root,
    });
  }
  return root;
}

export async function storeWorkerArtifact(
  body: StoreEncryptedArtifactRequest
): Promise<{ ref: string }> {
  return storeArtifactUnderRoot({ ...body, rootAgentId: await trueRoot(body.rootAgentId) });
}

export async function storeWorkerArtifacts(body: unknown): Promise<{
  artifacts: { path: string; ref: string }[];
}> {
  if (body !== null && typeof body === 'object' && 'rootAgentId' in body) {
    const posted = (body as { rootAgentId: unknown }).rootAgentId;
    if (typeof posted === 'string') {
      return storeArtifactsUnderRoot({ ...body, rootAgentId: await trueRoot(posted) });
    }
  }
  return storeArtifactsUnderRoot(body);
}
