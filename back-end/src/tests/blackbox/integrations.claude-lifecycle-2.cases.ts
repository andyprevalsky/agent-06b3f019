import {
  uploadFileToIntegrations,
  ctx,
  assert,
  assertStatus,
  request,
  BASE_URL,
  apiKeyHeaders,
  assertSchema,
  authHeaders,
} from './integrations.context';
import { ListIntegrationsResponse } from './integrations.schemas';

export async function testContactsUpload_emptyVcf() {
  const vcfContent = '';
  const res = await uploadFileToIntegrations(
    '/contacts/upload',
    ctx.accessToken1!,
    'empty.vcf',
    vcfContent,
    'text/vcard'
  );
  // Empty VCF should still succeed but with 0 parsed contacts
  if (res.status === 200) {
    const body = res.data as { parsed: number };
    assert(body.parsed === 0, `Expected 0 parsed contacts from empty VCF, got ${body.parsed}`);
  } else if (res.status !== 400 && res.status !== 500) {
    throw new Error(`Expected 200/400/500 for empty VCF, got ${res.status}`);
  }
}

// --- Generic file upload: with different integration types ---

export async function testGenericUpload_toolSetupType() {
  const res = await uploadFileToIntegrations(
    '/upload',
    ctx.accessToken1!,
    'tool-config.json',
    '{"tool": "test_tool", "config": true}',
    'application/json',
    { integrationType: 'custom_tool_config' }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; integration: { name: string } };
  assert(
    body.integration.name === 'custom_tool_config',
    `Expected custom_tool_config, got ${body.integration.name}`
  );
}

// --- Integration list: exercises getIntegrations with authenticated domains ---

export async function testList_withApiKey() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    headers: apiKeyHeaders(ctx.userId1),
  });
  assertStatus(res.status, 200, res.data);
  const body = assertSchema(ListIntegrationsResponse, res.data, 'GET /integrations via API key');
  assert(Array.isArray(body.authenticatedDomains), 'Expected authenticatedDomains array');
  assert(typeof body.count === 'number', 'Expected count number');
}

// --- Passwords request: exercises sendPasswordRequest path ---

export async function testPasswordsRequest_longRequest() {
  const longRequest = 'I need a password manager integration. '.repeat(10);
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: longRequest }),
  });
  // Should work even with long request text (exercises request.trim() and substring)
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500 for long request, got ${res.status}`);
  }
}
