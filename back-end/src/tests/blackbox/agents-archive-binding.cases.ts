/**
 * Pre-agent LLM calls bind to the caller's archive roots.
 *
 *   POST /api/generate-llm-judge-prompt          no auth ─► 401
 *                                                auth    ─► v2 start+final records under user-<uid>
 *   POST /api/agents/generate-response-schema    auth    ─► v2 start+final records under user-<uid>
 */
import { listArchivedObjects } from '../../providers/traceArchive';
import {
  BASE_URL,
  assert,
  assertStatus,
  authHeaders,
  createAnonymousSession,
  request,
  test,
} from './agents-blackbox-harness';
import { waitFor } from '../helpers/waitFor';

async function archivedPaths(rootAgentId: string): Promise<string[]> {
  return (await listArchivedObjects(rootAgentId, { throwOnError: true })).map((o) => o.path);
}

async function waitForPaths(
  rootAgentId: string,
  predicate: (paths: string[]) => boolean,
  label: string
): Promise<string[]> {
  return waitFor(
    label,
    async () => {
      const paths = await archivedPaths(rootAgentId);
      return predicate(paths) ? paths : false;
    },
    20_000
  );
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

test('POST /agents/generate-response-schema — archived under the caller user root', async () => {
  const session = await createAnonymousSession('schema-gen-archive');
  const res = await request(`${BASE_URL}/api/agents/generate-response-schema`, {
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
        /^llm-updates\/.+-response_schema_generation\.json\.gz\.enc$/.test(path)
      ),
    'schema generation start+final records under user root'
  );
  assert(paths.length >= 2, 'start and final records archived');
});
