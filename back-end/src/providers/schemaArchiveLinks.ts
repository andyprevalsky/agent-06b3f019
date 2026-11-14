/**
 * Schema-generation records for a PRE-ALLOCATED agent id are archived under the
 * caller's `user-<userId>` root (strict ownership: never into an unowned future
 * bundle). This index lets the agent's creation copy them into its own root:
 *
 *   POST /generate-response-schema {agent_id: X} ─► user-<uid>/llm/…   + link (uid, X) → paths
 *   POST /api/agents {agent_id: X} by the SAME uid ─► copy linked records into X's root
 *                                                     (create-only; user-<uid> copy kept)
 *
 * Keyed by (userId, agentId): one SharedEphemeralState row per pre-allocated id,
 * read by primary key at creation — no scans. Another user creating X finds no link.
 */
import { createLogger } from './logger';
import { getEphemeral, putEphemeral, withSerializedLock } from './sharedState';
import { readArchivedArtifactStrict, storeEncryptedArtifact } from './traceArchive';
import { userArchiveRoot } from './llmArchiveRecord';

const log = createLogger('SchemaArchiveLinks');
const NAMESPACE = 'schema-generation-archive-links';
const LINK_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_LINKED_PATHS = 64;

function linkKey(userId: string, agentId: string): string {
  return `${userId}:${agentId}`;
}

/** Called after a schema-generation record is durably stored under user-<userId>. */
export async function recordSchemaArchiveLink(
  userId: string,
  agentId: string,
  objectPath: string
): Promise<void> {
  const key = linkKey(userId, agentId);
  await withSerializedLock(`${NAMESPACE}:${key}`, async () => {
    const current = (await getEphemeral<{ paths?: string[] }>(NAMESPACE, key))?.paths ?? [];
    if (current.includes(objectPath) || current.length >= MAX_LINKED_PATHS) return;
    await putEphemeral(NAMESPACE, key, { paths: [...current, objectPath] }, LINK_TTL_MS);
  });
}

/** Copy the creator's linked schema-generation records into the new agent's root bundle. */
export async function copyLinkedSchemaArchive(
  userId: string,
  agentId: string,
  rootAgentId: string
): Promise<number> {
  const paths = (await getEphemeral<{ paths?: string[] }>(NAMESPACE, linkKey(userId, agentId)))
    ?.paths;
  if (!paths || paths.length === 0) return 0;
  const source = userArchiveRoot(userId);
  let copied = 0;
  for (const objectPath of paths) {
    const stored = await readArchivedArtifactStrict({ rootAgentId: source, objectPath });
    if (stored === null) {
      log.warn('Linked schema-generation record missing', { source, object_path: objectPath });
      continue;
    }
    // Same object path (it is the GCM AAD) and envelope: a byte-identical copy.
    await storeEncryptedArtifact({
      rootAgentId,
      objectPath,
      ciphertext: stored.ciphertext,
      metadata: stored.metadata,
      contentType: stored.metadata.content_type,
      createOnly: true,
    });
    copied += 1;
  }
  log.info('Copied schema-generation records into the agent root', {
    agent_id: agentId,
    root_agent_id: rootAgentId,
    copied,
  });
  return copied;
}

/** Fire-and-forget copy at agent creation (creation latency never waits on archive I/O). */
export function copyLinkedSchemaArchiveInBackground(
  userId: string,
  agentId: string,
  rootAgentId: string
): void {
  void copyLinkedSchemaArchive(userId, agentId, rootAgentId).catch((error: unknown) => {
    log.warn('Schema-generation archive copy failed', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
