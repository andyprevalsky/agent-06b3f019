import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
  createAnonSession,
  assert,
  uniqueName,
} from './integrations.context';
import {
  ListIntegrationsResponse,
  ErrorResponse,
  CreateIntegrationResponse,
  PatchIntegrationResponse,
  DeleteIntegrationResponse,
} from './integrations.schemas';

// ==================== GET / (LIST INTEGRATIONS) ====================

export async function testList_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations');
}

export async function testList_emptyForNewUser() {
  const { accessToken } = await createAnonSession();
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(accessToken),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations empty');
  assert(body.count === 0, `Expected 0 integrations for new user, got ${body.count}`);
  assert(
    body.integrations.length === 0,
    `Expected empty integrations array, got ${body.integrations.length}`
  );
}

// ==================== POST / (CREATE INTEGRATION) ====================

export async function testCreate_missingName() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ type: 'DATA_SOURCE' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'create missing name');
}

export async function testCreate_missingType() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name: 'test' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'create missing type');
}

export async function testCreate_invalidType() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name: 'test', type: 'INVALID_TYPE' }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'create invalid type');
}

export async function testCreate_happyPath() {
  const name = uniqueName('test_integration');
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { test: true } }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CreateIntegrationResponse, res.data, 'create happy');
  assert(body.integration.name === name, `Expected name ${name}, got ${body.integration.name}`);
  assert(
    body.integration.type === 'DATA_SOURCE',
    `Expected type DATA_SOURCE, got ${body.integration.type}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

export async function testCreate_toolSetupType() {
  const name = uniqueName('tool_integration');
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'TOOL_SETUP' }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(CreateIntegrationResponse, res.data, 'create TOOL_SETUP');
  assert(
    body.integration.type === 'TOOL_SETUP',
    `Expected type TOOL_SETUP, got ${body.integration.type}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== IDEMPOTENCY (UPSERT) ====================

export async function testCreate_upsertIdempotent() {
  const name = uniqueName('upsert_test');

  // First create → status should be NOT_CONNECTED
  const res1 = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { version: 1 } }),
  });
  assertStatus(res1.status, 200, res1.data);
  const body1 = assertSchema(CreateIntegrationResponse, res1.data, 'upsert first');
  assert(
    body1.integration.status === 'NOT_CONNECTED',
    `Expected NOT_CONNECTED, got ${body1.integration.status}`
  );

  // Second create (upsert) → status should still be NOT_CONNECTED (upsert resets status)
  // The key idempotency invariant is that the same integration ID is returned, not that
  // the status changes. POST upsert always writes NOT_CONNECTED.
  const res2 = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE', config: { version: 2 } }),
  });
  assertStatus(res2.status, 200, res2.data);
  const body2 = assertSchema(CreateIntegrationResponse, res2.data, 'upsert second');
  assert(
    body2.integration.id === body1.integration.id,
    'Expected same integration ID after upsert'
  );
  assert(
    body2.integration.status === 'NOT_CONNECTED',
    `Expected NOT_CONNECTED after upsert, got ${body2.integration.status}`
  );

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== READ-AFTER-WRITE ====================

export async function testReadAfterWrite_createThenList() {
  const name = uniqueName('raw_test');
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  const listRes = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(listRes.status, 200, listRes.data);
  const body = assertSchema(ListIntegrationsResponse, listRes.data, 'list after create');
  const found = body.integrations.find((i: { name: string }) => i.name === name);
  assert(found !== undefined, `Expected to find integration ${name} in list`);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== PATCH /:name ====================

export async function testPatch_happyPath() {
  const name = uniqueName('patch_test');

  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Patch
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED', isActive: true }),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(PatchIntegrationResponse, res.data, 'patch happy');
  assert(
    body.integration.status === 'CONNECTED',
    `Expected CONNECTED, got ${body.integration.status}`
  );
  assert(body.integration.isActive === true, 'Expected isActive=true');

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

export async function testPatch_notFound() {
  const res = await request(`${BASE_URL}/api/integrations/nonexistent_${Date.now()}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'patch not found');
}

// ==================== DELETE /:name ====================

export async function testDelete_happyPath() {
  const name = uniqueName('delete_test');

  // Create first
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Delete
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(DeleteIntegrationResponse, res.data, 'delete happy');
}

export async function testDelete_notFound() {
  const res = await request(`${BASE_URL}/api/integrations/nonexistent_${Date.now()}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'delete not found');
}

export async function testDelete_verifyGone() {
  const name = uniqueName('verify_delete');

  // Create
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // Delete
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });

  // Verify gone from list
  const listRes = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken1!),
  });
  const body = assertSchema(ListIntegrationsResponse, listRes.data, 'list after delete');
  const found = body.integrations.find((i: { name: string }) => i.name === name);
  assert(found === undefined, `Integration ${name} should not exist after delete`);
}

// ==================== TENANT ISOLATION ====================

export async function testTenantIsolation_separateUsers() {
  const name = uniqueName('isolation_test');

  // User 1 creates integration
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // User 2 should not see it
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'isolation list');
  const found = body.integrations.find((i: { name: string }) => i.name === name);
  assert(found === undefined, `User 2 should not see User 1's integration ${name}`);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

export async function testTenantIsolation_patchOtherUserIntegration() {
  const name = uniqueName('cross_patch');

  // User 1 creates integration
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // User 2 tries to patch → 404 (can't find it)
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken2!),
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 404, res.data);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

export async function testTenantIsolation_deleteOtherUserIntegration() {
  const name = uniqueName('cross_delete');

  // User 1 creates integration
  await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });

  // User 2 tries to delete → 404
  const res = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken2!),
  });
  assertStatus(res.status, 404, res.data);

  // Cleanup
  await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'DELETE',
    headers: authHeaders(ctx.accessToken1!),
  });
}

// ==================== ERROR SURFACE INVARIANT ====================

export async function testErrorSurface_401sHaveErrorField() {
  const endpoints = [
    { url: `${BASE_URL}/api/integrations`, method: 'GET' as const },
    { url: `${BASE_URL}/api/integrations`, method: 'POST' as const },
    { url: `${BASE_URL}/api/integrations/test`, method: 'PATCH' as const },
    { url: `${BASE_URL}/api/integrations/test`, method: 'DELETE' as const },
    { url: `${BASE_URL}/api/integrations/email/messages`, method: 'GET' as const },
    { url: `${BASE_URL}/api/integrations/email/send`, method: 'POST' as const },
    { url: `${BASE_URL}/api/integrations/email/gmail/start`, method: 'POST' as const },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const res = await request(ep.url, { method: ep.method });
      return { ep, res };
    })
  );

  for (const { ep, res } of results) {
    assertStatus(res.status, 401, res.data);
    assertSchema(ErrorResponse, res.data, `error surface ${ep.method} ${ep.url}`);
  }
}

export async function testErrorSurface_400sHaveErrorField() {
  const cases = [
    {
      url: `${BASE_URL}/api/integrations`,
      method: 'POST' as const,
      body: JSON.stringify({ name: 'x' }),
    },
    {
      url: `${BASE_URL}/api/integrations`,
      method: 'POST' as const,
      body: JSON.stringify({ type: 'DATA_SOURCE' }),
    },
    {
      url: `${BASE_URL}/api/integrations`,
      method: 'POST' as const,
      body: JSON.stringify({ name: 'x', type: 'BOGUS' }),
    },
  ];

  const results = await Promise.all(
    cases.map(async (c) => {
      const res = await request(c.url, {
        method: c.method,
        body: c.body,
        headers: authHeaders(ctx.accessToken1!),
      });
      return { c, res };
    })
  );

  for (const { res } of results) {
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, 'error surface 400');
  }
}
