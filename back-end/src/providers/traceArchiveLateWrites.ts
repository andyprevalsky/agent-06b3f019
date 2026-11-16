/**
 * Late trajectory writes (code/, llm/, llm-updates/) that land after a root
 * bundle's finalization fence are reconciled into its manifests.
 */

import { createLogger } from './logger';
import { TRACE_ARCHIVE_FINALIZING_MARKER_PATH } from './traceArchivePaths';

const log = createLogger('TraceArchive');

/** Trajectory artifacts that may legitimately arrive after the root bundle finalized. */
const LATE_RECONCILED_PREFIXES = ['code/', 'llm/', 'llm-updates/'];

export async function reconcileLateArtifact(
  rootAgentId: string,
  objectPath: string
): Promise<void> {
  if (!LATE_RECONCILED_PREFIXES.some((prefix) => objectPath.startsWith(prefix))) return;
  try {
    // Lazy imports: both modules import this one. The manifest module (and its
    // database pool) loads only for a root that has actually finalized.
    const { plainArchiveArtifactExists } = await import('./traceArchiveStrict');
    const fenced = await plainArchiveArtifactExists({
      rootAgentId,
      objectPath: TRACE_ARCHIVE_FINALIZING_MARKER_PATH,
    });
    if (!fenced) return;
    const { reconcileAfterLateWrite } = await import('./traceArchiveManifest');
    await reconcileAfterLateWrite(rootAgentId);
  } catch (error) {
    // The object is stored; a stale manifest is repaired by
    // scripts/backfill-trace-archive-manifests.ts and flagged by the lossless audit.
    log.error('Trace archive late artifact left the finalized manifest stale', {
      root_agent_id: rootAgentId,
      object_path: objectPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
