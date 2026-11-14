/**
 * Pre-agent LLM calls bind to the caller's archive roots.
 *
 *   POST /api/generate-llm-judge-prompt   no auth ─► 401
 *                                         auth    ─► v2 start+final records under user-<uid>
 *   schema records linked to (uid, X) + POST /api/agents {agent_id: X}
 *        same uid  ─► copied into X's root bundle (create-only; user copy kept)
 *        other uid ─► never copied
 */
import { randomUUID } from 'node:crypto';
import {
  encryptArtifact,
  listArchivedObjects,
  storeEncryptedArtifact,
} from '../../providers/traceArchive';
import { recordSchemaArchiveLink } from '../../providers/schemaArchiveLinks';
import {
  BASE_URL,
  assert,
  assertStatus,
  authHeaders,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  request,
  sleep,
  test,
} from './agents-blackbox-harness';

async function archivedPaths(rootAgentId: string): Promise<string[]> {
  return (await listArchivedObjects(rootAgentId, { throwOnError: true })).map((o) => o.path);
}

async function waitForPaths(
  rootAgentId: string,
  predicate: (paths: string[]) => boolean,
  label: string
): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const paths = await archivedPaths(rootAgentId);
    if (predicate(paths)) return paths;
    if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(paths)}`);
    await sleep(250);
  }
}

/** Archive a schema-generation-like record under user-<uid> and link it to agentId. */
async function linkedSchemaRecord(userId: string, agentId: string): Promise<string> {
  const objectPath = `llm/${randomUUID()}.json.gz.enc`;
  const encrypted = encryptArtifact(
    objectPath,
    Buffer.from(
      JSON.stringify({
        schema_version: 2,
        record: 'start',
        call_site: 'response_schema_generation',
      })
    ),
    'application/json'
  );
  assert(encrypted !== null, 'trace archive encryption must be configured');
  await storeEncryptedArtifact({
    rootAgentId: `user-${userId}`,
    objectPath,
    ciphertext: encrypted!.ciphertext,
    metadata: encrypted!.metadata,
  });
  await recordSchemaArchiveLink(userId, agentId, objectPath);
  return objectPath;
}

test('POST /generate-llm-judge-prompt — no auth → 401', async () => {
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    body: JSON.stringify({ goal: 'find the population of Tokyo' }),
  });
  assertStatus(res.status, 401, res.data);
});

test('POST /generate-llm-judge-prompt — archived under the caller user root', async () => {
  const session = await createAnonymousSession('judge-prompt-archive');
  const res = await request(`${BASE_URL}/api/generate-llm-judge-prompt`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({ goal: 'find the population of Tokyo' }),
  });
  assertStatus(res.status, 200, res.data);
  const paths = await waitForPaths(
    `user-${session.user.id}`,
    (current) =>
      current.some((path) => path.startsWith('llm/')) &&
      current.some((path) =>
        /^llm-updates\/.+-llm_judge_prompt_generation\.json\.gz\.enc$/.test(path)
      ),
    'judge prompt start+final records under user root'
  );
  assert(paths.length >= 2, 'start and final records archived');
});

test('POST /agents with a pre-allocated agent_id copies only the creator’s schema records', async () => {
  const owner = await createAnonymousSession('schema-link-owner');
  const other = await createAnonymousSession('schema-link-other');
  const ownedId = randomUUID();
  const ownedPath = await linkedSchemaRecord(owner.user.id, ownedId);
  // The other user linked records to an id that the OWNER later creates…
  const foreignId = randomUUID();
  const foreignPath = await linkedSchemaRecord(other.user.id, foreignId);
  const ownerOnForeign = await linkedSchemaRecord(owner.user.id, foreignId);
  try {
    await createTestAgent(owner.user.id, 'Schema link copy test', { agent_id: ownedId });
    await createTestAgent(owner.user.id, 'Schema link isolation test', { agent_id: foreignId });
    await waitForPaths(ownedId, (paths) => paths.includes(ownedPath), 'owned record copied');
    const foreignBundle = await waitForPaths(
      foreignId,
      (paths) => paths.includes(ownerOnForeign),
      "creator's own record copied"
    );
    assert(!foreignBundle.includes(foreignPath), "another user's record is never copied");
    assert(
      (await archivedPaths(`user-${owner.user.id}`)).includes(ownedPath),
      'the user-root copy is kept (no deletes)'
    );
  } finally {
    await deleteTestAgent(ownedId, owner.user.id).catch(() => undefined);
    await deleteTestAgent(foreignId, owner.user.id).catch(() => undefined);
  }
});
