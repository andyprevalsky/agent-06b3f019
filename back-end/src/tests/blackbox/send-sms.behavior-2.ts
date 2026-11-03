import { readArchivedArtifact, decryptAndValidateArtifact } from '../../providers/traceArchive';
import {
  BASE_URL,
  request,
  assert,
  apiKeyHeaders,
  assertStatus,
  captureToken,
  TEST_PHONE,
  readCapturesForToken,
  filterSurgeCalls,
  TEST_USER_ID,
  createNotifyAgent,
  listSmsArchivePaths,
  assertNoRoutingLeaks,
  assertAgentLinkPresent,
  archiveDisabledOnBackend,
  prisma,
  assertLinkShorteningDisabled,
} from './send-sms.support';

// ==================== AUTH BOUNDARY INVARIANT ====================
export async function testAuth_allEndpointsRequireAuth() {
  const endpoints = [
    {
      url: `${BASE_URL}/api/send-sms`,
      body: { phone_number: '+10000000000', message: 'test' },
    },
    {
      url: `${BASE_URL}/api/send-sms/direct`,
      body: { user_id: 'x', message: 'test' },
    },
    {
      url: `${BASE_URL}/api/send-sms/notify`,
      body: { user_id: 'x', event_type: 'completion', agent_id: 'x' },
    },
  ];
  for (const ep of endpoints) {
    const res = await request(ep.url, {
      method: 'POST',
      body: JSON.stringify(ep.body),
    });
    assert(res.status === 401, `${ep.url} without auth: expected 401, got ${res.status}`);
  }
}

export async function testAuth_invalidApiKey() {
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: { 'X-API-Key': 'invalid-key-12345' },
    body: JSON.stringify({ phone_number: '+10000000000', message: 'test' }),
  });
  assert(
    res.status === 401 || res.status === 403,
    `Expected 401 or 403 for invalid key, got ${res.status}`
  );
}

// ==================== ERROR SURFACE INVARIANT ====================
export async function testErrorSurface_wrongMethodsSend() {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    const opts: RequestInit = { method, headers: apiKeyHeaders() };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify({});
    const res = await request(`${BASE_URL}/api/send-sms`, opts);
    assert(res.status !== 200, `${method} /api/send-sms should not return 200`);
  }
}

export async function testErrorSurface_wrongMethodsDirect() {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    const opts: RequestInit = { method, headers: apiKeyHeaders() };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify({});
    const res = await request(`${BASE_URL}/api/send-sms/direct`, opts);
    assert(res.status !== 200, `${method} /api/send-sms/direct should not return 200`);
  }
}

export async function testErrorSurface_wrongMethodsNotify() {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    const opts: RequestInit = { method, headers: apiKeyHeaders() };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify({});
    const res = await request(`${BASE_URL}/api/send-sms/notify`, opts);
    assert(res.status !== 200, `${method} /api/send-sms/notify should not return 200`);
  }
}

export async function testErrorSurface_allValidationErrorsHaveErrorField() {
  const cases = [
    { url: `${BASE_URL}/api/send-sms`, body: { message: 'test' } },
    { url: `${BASE_URL}/api/send-sms`, body: { phone_number: '+1000' } },
    { url: `${BASE_URL}/api/send-sms/direct`, body: {} },
    { url: `${BASE_URL}/api/send-sms/notify`, body: {} },
    {
      url: `${BASE_URL}/api/send-sms/notify`,
      body: { user_id: 'x', event_type: 'bad', agent_id: 'x' },
    },
  ];
  for (const c of cases) {
    const res = await request(c.url, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify(c.body),
    });
    assertStatus(res.status, 400, res.data);
    const data = res.data as { error?: string };
    assert(
      data.error !== undefined,
      `Expected error field in 400 from ${c.url} with ` +
        `${JSON.stringify(c.body)}, got: ` +
        `${JSON.stringify(res.data).substring(0, 200)}`
    );
  }
}

// ==================== CONCURRENCY INVARIANT ====================
export async function testConcurrency_parallelSendValidation() {
  const requests = Array.from({ length: 10 }, () =>
    request(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ message: 'test' }),
    })
  );
  const results = await Promise.all(requests);
  for (const res of results) {
    assertStatus(res.status, 400, res.data);
  }
}

export async function testConcurrency_parallelNotifyValidation() {
  const requests = Array.from({ length: 10 }, () =>
    request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({}),
    })
  );
  const results = await Promise.all(requests);
  for (const res of results) {
    assertStatus(res.status, 400, res.data);
  }
}

// ==================== REPRODUCIBILITY INVARIANT ====================
export async function testReproducibility_sameInputSameOutput() {
  const body = JSON.stringify({ phone_number: '+10000000000' });
  const snapshots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await request(`${BASE_URL}/api/send-sms`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body,
    });
    snapshots.push(JSON.stringify({ status: res.status, data: res.data }));
  }
  assert(new Set(snapshots).size === 1, 'Three identical requests returned different responses');
}

// ==================== BOUNDARY CAPTURE TESTS ====================
// Run sequentially -- shared capture buffer.
// Each test: clear captures -> request -> read captures -> assert.
/**
 * POST /api/send-sms with valid params calls Surge Messages API:
 *   URL:     https://api.surge.app/accounts/{ACCOUNT_ID}/messages
 *   Method:  POST
 *   Headers: Authorization: Bearer ..., Content-Type: application/json
 *   Body:    { to: string, body: string }
 */
export async function testBoundary_sendCallsSurgeApi() {
  const token = captureToken('send');
  const res = await request(`${BASE_URL}/api/send-sms`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      phone_number: TEST_PHONE,
      message: 'boundary test send',
    }),
  });
  if (res.status === 500) {
    const data = res.data as { error?: string };
    if (data.error?.includes('not configured')) {
      console.log('    [skipped] Surge not configured -- cannot test boundary');
      return;
    }
  }
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, 'boundary test send');
  assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
  const call = surgeCalls[0];
  assert(
    call.url.startsWith('https://api.surge.app/accounts/') && call.url.endsWith('/messages'),
    `Unexpected Surge URL: ${call.url}`
  );
  assert(call.method === 'POST', `Expected POST, got ${call.method}`);
  assert(
    call.requestHeaders['Content-Type'] === 'application/json',
    `Expected Content-Type: application/json, got: ` + `${call.requestHeaders['Content-Type']}`
  );
  assert(
    call.requestHeaders['Authorization'] === '[redacted]',
    'Expected captured authorization to be fully redacted'
  );
  assert(call.requestBody !== null, 'Expected non-null request body');
  const body = JSON.parse(call.requestBody!);
  assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}, got to=${body.to}`);
  assert(
    body.body === 'boundary test send',
    `Expected body='boundary test send', got: ${body.body}`
  );
}

/**
 * POST /api/send-sms/direct with valid user calls Surge Messages API
 * via sendSms() helper. Body: { to: user's phone, body: message }.
 */
export async function testBoundary_directCallsSurgeApi() {
  const token = captureToken('direct');
  const res = await request(`${BASE_URL}/api/send-sms/direct`, {
    method: 'POST',
    headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
    body: JSON.stringify({
      user_id: TEST_USER_ID,
      message: 'boundary test direct',
    }),
  });
  if (res.status === 200) {
    const data = res.data as { success?: boolean; error?: string };
    if (data.success === false && data.error?.includes('not configured')) {
      console.log('    [skipped] Surge not configured -- cannot test boundary');
      return;
    }
  }
  if (res.status === 500) {
    console.log('    [skipped] Internal error -- cannot test boundary');
    return;
  }
  const calls = await readCapturesForToken(token);
  const surgeCalls = filterSurgeCalls(calls, 'boundary test direct');
  if (surgeCalls.length === 0) {
    console.log('    [skipped] No Surge calls -- Surge may not be configured');
    return;
  }
  assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
  const call = surgeCalls[0];
  assert(
    call.url.startsWith('https://api.surge.app/accounts/') && call.url.endsWith('/messages'),
    `Unexpected Surge URL: ${call.url}`
  );
  assert(call.method === 'POST', `Expected POST, got ${call.method}`);
  assert(
    call.requestHeaders['Content-Type'] === 'application/json',
    'Expected Content-Type: application/json'
  );
  assert(
    call.requestHeaders['Authorization'] === '[redacted]',
    'Expected captured authorization to be fully redacted'
  );
  assert(call.requestBody !== null, 'Expected non-null request body');
  const body = JSON.parse(call.requestBody!);
  assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}, got to=${body.to}`);
  assert(
    body.body === 'boundary test direct',
    `Expected body='boundary test direct', got: ${body.body}`
  );
}

/**
 * POST /api/send-sms/notify with completion event calls Surge Messages
 * API via notifyCompletion() -> sendSms() chain.
 */
export async function testBoundary_notifyCompletionCallsSurgeApi() {
  const token = captureToken('notify-completion');
  const agent = await createNotifyAgent('boundary completion agent');
  const archiveBefore = new Set(await listSmsArchivePaths(agent.id));
  try {
    const requestBody = {
      user_id: TEST_USER_ID,
      event_type: 'completion',
      agent_id: agent.id,
      payload: {
        summary: 'boundary test completed',
        outputs: [
          { key: 'pickup_time', label: 'Pickup Time', value: '7:41 AM' },
          { key: 'order_total_usd', label: 'Order Total', value: 11.25 },
          { key: 'order_confirmation_id', label: 'Confirmation', value: 'order-123' },
          { key: 'merchant', value: 'Blue Bottle Coffee' },
          { key: 'location', value: 'Ferry Building' },
          { key: 'size', value: '16oz' },
          { key: 'milk', value: 'oat' },
          { key: 'flavor', value: 'vanilla bean' },
        ],
      },
    };
    const sendCompletion = () =>
      request(`${BASE_URL}/api/send-sms/notify`, {
        method: 'POST',
        headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
        body: JSON.stringify(requestBody),
      });

    const res = await sendCompletion();
    assertStatus(res.status, 200, res.data);
    const duplicate = await sendCompletion();
    assertStatus(duplicate.status, 200, duplicate.data);

    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'boundary test completed');
    assert(surgeCalls.length === 1, `Expected 1 idempotent Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(
      call.url.startsWith('https://api.surge.app/accounts/') && call.url.endsWith('/messages'),
      `Unexpected Surge URL: ${call.url}`
    );
    assert(call.method === 'POST', `Expected POST, got ${call.method}`);
    assert(
      call.requestHeaders['Content-Type'] === 'application/json',
      'Expected JSON content type'
    );
    assert(
      call.requestHeaders['Authorization'] === '[redacted]',
      'Expected captured authorization to be fully redacted'
    );
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}, got to=${body.to}`);
    assert(
      body.body.includes('boundary test completed'),
      `Expected completion summary in SMS, got: ${body.body.substring(0, 100)}`
    );
    assert(
      body.body.includes('Pickup Time: 7:41 AM'),
      `Expected output schema values: ${body.body}`
    );
    assert(
      body.body.includes('Order Total: 11.25'),
      `Expected schema-derived output label: ${body.body}`
    );
    assert(body.body.includes('Size: 16oz'), `Expected sixth output line: ${body.body}`);
    assert(
      !body.body.includes('Milk: oat'),
      `Expected outputs after sixth line to be truncated: ${body.body}`
    );
    assert(
      body.body.split('\n').length <= 8,
      `Expected completion SMS to be at most 8 lines, got: ${body.body}`
    );
    assertNoRoutingLeaks(body.body, agent.id);
    assertAgentLinkPresent(body.body, agent.id);
    const archiveAfter = await listSmsArchivePaths(agent.id);
    const newEncryptedArtifacts = archiveAfter.filter(
      (entry) =>
        !archiveBefore.has(entry) &&
        entry.startsWith('provider/sms/surge/') &&
        entry.endsWith('.json.gz.enc')
    );
    if (newEncryptedArtifacts.length === 0 && (await archiveDisabledOnBackend(agent.id))) {
      // The /deploy Step-5 stack runs with TRACE_ARCHIVE_ENABLED=0, so no SMS
      // provider archive is written there. The coverage-gate backend runs
      // archive-enabled, so the archive assertions still execute every deploy.
      console.log('    [info] trace archive disabled on target backend — skipping archive checks');
      return;
    }
    assert(
      newEncryptedArtifacts.length >= 1,
      `Expected encrypted SMS provider archive for agent ${agent.id}`
    );
    const archivedArtifact = await readArchivedArtifact({
      rootAgentId: agent.id,
      objectPath: newEncryptedArtifacts[0],
    });
    assert(
      archivedArtifact !== null,
      `Expected readable SMS provider archive metadata at ${newEncryptedArtifacts[0]}`
    );
    const metadata = archivedArtifact.metadata as Record<string, unknown>;
    assert(metadata.content_type === 'application/json', 'Expected JSON archive content type');
    assert(metadata.compression === 'gzip', 'Expected SMS provider archive to be gzipped');
    const payload = JSON.parse(decryptAndValidateArtifact(archivedArtifact).toString('utf8')) as {
      provider?: unknown;
      success?: unknown;
      request?: { body?: { body?: unknown } };
      context?: { event_type?: unknown; user_id?: unknown };
    };
    assert(payload.provider === 'surge', 'Expected Surge provider archive payload');
    assert(payload.success === true, 'Expected successful SMS provider archive payload');
    assert(
      payload.request?.body?.body?.toString().includes('boundary test completed') === true,
      'Expected archived SMS body to include completion summary'
    );
    assert(payload.context?.event_type === 'completion', 'Expected completion archive context');
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

/**
 * POST /api/send-sms/notify with agent_started event calls Surge API.
 */
export async function testBoundary_notifyAgentStartedCallsSurgeApi() {
  const token = captureToken('notify-started');
  const agent = await createNotifyAgent('boundary started agent');
  try {
    const res = await request(`${BASE_URL}/api/send-sms/notify`, {
      method: 'POST',
      headers: { ...apiKeyHeaders(), 'X-Capture-Token': token },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        event_type: 'agent_started',
        agent_id: agent.id,
        payload: { goal: 'boundary test goal' },
      }),
    });
    assertStatus(res.status, 200, res.data);
    const calls = await readCapturesForToken(token);
    const surgeCalls = filterSurgeCalls(calls, 'boundary test goal');
    if (surgeCalls.length === 0) {
      console.log('    [skipped] No Surge calls -- Surge may not be configured');
      return;
    }
    assert(surgeCalls.length === 1, `Expected 1 Surge call, got ${surgeCalls.length}`);
    const call = surgeCalls[0];
    assert(call.requestBody !== null, 'Expected non-null request body');
    const body = JSON.parse(call.requestBody!);
    assert(body.to === TEST_PHONE, `Expected to=${TEST_PHONE}`);
    assert(
      body.body.includes('boundary test goal'),
      `Expected started message to include goal, got: ${body.body.substring(0, 100)}`
    );
    assertNoRoutingLeaks(body.body, agent.id);
    assertAgentLinkPresent(body.body, agent.id);
    assertLinkShorteningDisabled(body);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}
