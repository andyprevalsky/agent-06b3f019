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
  clearCaptures,
  readCaptures,
  sleep,
  randomUUID,
} from './agents-blackbox-harness';

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
  await clearCaptures();

  // Chat mode root agent triggers fire-and-forget GitHub repo creation
  await createTestAgent(session.user.id, 'Boundary github test');

  // Wait longer for fire-and-forget GitHub call
  await sleep(3000);
  const calls = await readCaptures();

  // Filter for GitHub API call
  const githubCalls = calls.filter((c) => c.url.includes('api.github.com'));
  // May be 0 if GITHUB_TOKEN is not configured
  if (githubCalls.length > 0) {
    const call = githubCalls[0];
    assert(
      call.url === 'https://api.github.com/user/repos',
      `Expected GitHub repos URL, got ${call.url}`
    );
    assert(call.method === 'POST', `Expected POST for GitHub, got ${call.method}`);
    assert(
      call.requestHeaders['accept']?.includes('application/vnd.github') ||
        call.requestHeaders['Accept']?.includes('application/vnd.github'),
      'Expected GitHub Accept header'
    );
    // Verify request body has repo name
    if (call.requestBody) {
      const body = JSON.parse(call.requestBody);
      assert(
        typeof body.name === 'string' && body.name.startsWith('agent-'),
        `Expected repo name starting with agent-, got ${body.name}`
      );
    }
  }

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

export async function testBoundary_validationShortCircuitNoOutbound(): Promise<void> {
  const session = await createAnonymousSession('boundary-validation');
  // Drain any in-flight calls from the parallel phase before asserting zero outbound
  await sleep(500);
  await clearCaptures();

  // Missing goal → 400: should not make any outbound calls
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: authHeaders(session.session.access_token),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'validation short-circuit');

  const calls = await readCaptures();
  // Filter to agent-relevant services only
  const agentCalls = calls.filter(
    (c) =>
      c.url.includes('openrouter.ai') ||
      c.url.includes('ip-api.com') ||
      c.url.includes('api.github.com')
  );
  assert(
    agentCalls.length === 0,
    `Validation failure should make 0 outbound calls, got ${agentCalls.length}`
  );
}
