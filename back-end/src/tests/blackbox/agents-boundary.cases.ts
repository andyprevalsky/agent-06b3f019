import {
  BASE_URL,
  trackedAgentIds,
  CapturedCall,
  ErrorResponse,
  authHeaders,
  apiKeyHeaders,
  request,
  assertStatus,
  assertSchema,
  assert,
  createAnonymousSession,
  createTestAgent,
  deleteTestAgent,
  postAgentWithRetry,
  clearCaptures,
  readCaptures,
  sleep,
  randomUUID,
} from './agents-blackbox-harness';
import { selectGithubRepoCreationCall } from '../helpers/github-repo-capture';

// ---------------------------------------------------------------------------
// Boundary capture tests (run sequentially — shared capture buffer)
// ---------------------------------------------------------------------------

/**
 * POST / (create agent) triggers synchronous outbound calls:
 *   1. openrouter.ai/api/v1/models  (model pricing — GET)
 *   2. ip-api.com/json/{ip}         (geolocation — GET)
 * And fire-and-forget calls:
 *   3. api.github.com/user/repos    (repo creation — POST)
 *   4. supabase .../completions      (chat handler — POST)
 *   5. supabase .../realtime/...     (broadcast — POST)
 */

export async function testBoundary_createAgentModelPricing(): Promise<void> {
  const session = await createAnonymousSession('boundary-model-pricing');
  await clearCaptures();

  await createTestAgent(session.user.id, 'Boundary model pricing test');

  // Wait briefly for fire-and-forget calls to complete
  await sleep(1500);
  const calls = await readCaptures();

  // Filter for the OpenRouter model pricing call specifically (models list).
  // Post-rose-migration, openrouter.ai is also used for chat completions via
  // the in-process Rose provider (/api/v1/chat/completions), so we must
  // narrow to the /v1/models endpoint to test the pricing path only.
  const pricingCalls = calls.filter((c) => c.url.includes('openrouter.ai/api/v1/models'));
  // May be 0 if result was cached in-memory by modelPricing.ts (24h TTL)
  // or 1 if cache expired. Assert on shape when present.
  if (pricingCalls.length > 0) {
    const call = pricingCalls[0];
    assert(
      call.url === 'https://openrouter.ai/api/v1/models',
      `Expected OpenRouter models URL, got ${call.url}`
    );
    assert(call.method === 'GET', `Expected GET, got ${call.method}`);
    assert(
      call.requestHeaders['authorization']?.startsWith('Bearer ') ||
        call.requestHeaders['Authorization']?.startsWith('Bearer '),
      'Expected Bearer auth header for OpenRouter'
    );
  }

  await deleteTestAgent(
    await request(`${BASE_URL}/api/agents`, { headers: apiKeyHeaders(session.user.id) })
      .then((r) => (r.data as Record<string, unknown>).agents as { agent_id: string }[] | undefined)
      .then((agents) => agents?.[0]?.agent_id ?? ''),
    session.user.id
  ).catch(() => {});
}

export async function testBoundary_createAgentGeoip(): Promise<void> {
  const session = await createAnonymousSession('boundary-geoip');
  await clearCaptures();

  await createTestAgent(session.user.id, 'Boundary geoip test');

  await sleep(1500);
  const calls = await readCaptures();

  // Filter for ip-api.com geolocation call
  const geoCalls = calls.filter((c) => c.url.includes('ip-api.com'));
  // May be 0 if client IP is null (common in test env with localhost requests)
  if (geoCalls.length > 0) {
    const call = geoCalls[0];
    assert(
      call.url.startsWith('http://ip-api.com/json/'),
      `Expected ip-api.com URL, got ${call.url}`
    );
    assert(call.method === 'GET', `Expected GET for geoip, got ${call.method}`);
  }

  // Cleanup via list+delete
  const listRes = await request(`${BASE_URL}/api/agents`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const agents = ((listRes.data as Record<string, unknown>).agents || []) as { agent_id: string }[];
  for (const a of agents) {
    await deleteTestAgent(a.agent_id, session.user.id).catch(() => {});
  }
}

export async function testBoundary_createAgentGithubRepo(): Promise<void> {
  const session = await createAnonymousSession('boundary-github');
  // Scope to this request. Parallel domains (auto-RCA) write /dispatches into
  // the shared buffer; taking githubCalls[0] then fails with
  // "Expected GitHub repos URL, got .../dispatches".
  const captureToken = `github-repo-${randomUUID()}`;
  const createRes = await postAgentWithRetry(
    { ...apiKeyHeaders(session.user.id), 'X-Capture-Token': captureToken },
    { goal: 'Boundary github test' }
  );
  if (createRes.status === 201) {
    const body = createRes.data as { agent_id: string };
    trackedAgentIds.add(body.agent_id);
  } else {
    assertStatus(createRes.status, 201, createRes.data);
  }

  await sleep(3000);
  const capturesRes = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const calls = (capturesRes.data as { captures: CapturedCall[] }).captures;
  // A chat agent never creates a GitHub repo: the tree's repo is created on its
  // first code session (2026-10-28: per-chat creates on the shared token tripped
  // GitHub's secondary limit for production users).
  const call = selectGithubRepoCreationCall(calls);
  assert(
    call === undefined,
    `creating a chat agent must not create a GitHub repo, got ${call?.url}`
  );

  const listRes = await request(`${BASE_URL}/api/agents`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const agents = ((listRes.data as Record<string, unknown>).agents || []) as { agent_id: string }[];
  for (const a of agents) {
    await deleteTestAgent(a.agent_id, session.user.id).catch(() => {});
  }
}

export async function testBoundary_createAgentCallOrdering(): Promise<void> {
  const session = await createAnonymousSession('boundary-ordering');
  await clearCaptures();

  // Tag this test's outbound fetches so we can filter out cross-test contamination
  // (prior tests' fire-and-forget handlers may still be making calls in our window).
  // The backend's captureTokenMiddleware + AsyncLocalStorage propagates the tag
  // through the full async chain — synchronous awaits AND fire-and-forget.
  const captureToken = `ordering-${randomUUID()}`;
  const createRes = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(session.user.id), 'X-Capture-Token': captureToken },
    body: JSON.stringify({ goal: 'Boundary ordering test' }),
  });
  if (createRes.status === 201) {
    const body = createRes.data as { agent_id: string };
    trackedAgentIds.add(body.agent_id);
  }

  await sleep(2000);

  // Filter captures to only those tagged with our token.
  const res = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(res.status, 200, res.data);
  const calls = (res.data as { captures: CapturedCall[] }).captures;

  // Synchronous calls (model pricing, geoip) should be INITIATED before
  // fire-and-forget calls (github, chat). Compare request-start `timestamp`
  // values rather than array indices — captures are pushed on response
  // completion, so fast-forward caching can invert array order.
  const syncCall = calls.find(
    (c) => c.url.includes('openrouter.ai/api/v1/models') || c.url.includes('ip-api.com')
  );
  const asyncCall = calls.find(
    (c) => c.url.includes('api.github.com') || c.url.includes('/chat/completions')
  );

  if (syncCall && asyncCall) {
    const syncT = new Date(syncCall.timestamp).getTime();
    const asyncT = new Date(asyncCall.timestamp).getTime();
    assert(
      syncT <= asyncT,
      `Synchronous boundary call (${syncCall.url} @ ${syncCall.timestamp}) should be initiated before fire-and-forget call (${asyncCall.url} @ ${asyncCall.timestamp})`
    );
  }
  // If either set is empty (e.g., cached or unconfigured), the ordering check is vacuously true

  const listRes = await request(`${BASE_URL}/api/agents`, {
    headers: apiKeyHeaders(session.user.id),
  });
  const agents = ((listRes.data as Record<string, unknown>).agents || []) as { agent_id: string }[];
  for (const a of agents) {
    await deleteTestAgent(a.agent_id, session.user.id).catch(() => {});
  }
}

function isAgentBoundaryOutbound(call: CapturedCall): boolean {
  return (
    call.url.includes('openrouter.ai') ||
    call.url.includes('ip-api.com') ||
    call.url.includes('api.github.com')
  );
}

export async function testBoundary_validationShortCircuitNoOutbound(): Promise<void> {
  const session = await createAnonymousSession('boundary-validation');
  // Prior create-agent cases (and parallel blackbox domains under coverage) share the
  // global capture buffer. Scope this assertion with X-Capture-Token so only outbound
  // attributed to THIS request can fail the zero-call check.
  const captureToken = `validation-${randomUUID()}`;

  // Missing goal → 400: should not make any outbound calls
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: {
      ...authHeaders(session.session.access_token),
      'X-Capture-Token': captureToken,
    },
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'validation short-circuit');

  const capturesRes = await request(`${BASE_URL}/api/test/captures?token=${captureToken}`);
  assertStatus(capturesRes.status, 200, capturesRes.data);
  const agentCalls = ((capturesRes.data as { captures: CapturedCall[] }).captures || []).filter(
    isAgentBoundaryOutbound
  );
  assert(
    agentCalls.length === 0,
    `Validation failure should make 0 outbound calls, got ${agentCalls.length}: ${JSON.stringify(
      agentCalls.map((c) => ({ url: c.url, timestamp: c.timestamp }))
    ).slice(0, 500)}`
  );
}
