import {
  request,
  BASE_URL,
  assertStatus,
  assertSchema,
  snapshotAnthropicApiKeyCooldown,
  apiKeyHeaders,
  assert,
  restoreAnthropicApiKeyCooldown,
  waitForServerFundedKeyCooldown,
  API_KEY,
  cooldownIsLive,
  ANTHROPIC_COOLDOWN_USER_ID,
  GPT_API_KEY_COOLDOWN_NAME,
  prisma,
  retryWithBackoff,
} from './integrations.context';
import { ErrorResponse } from './integrations.schemas';

// ==================== AUTH BOUNDARY TESTS (401) ====================

export async function testList_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations`);
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'list no auth');
}

export async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    body: JSON.stringify({ name: 'test', type: 'DATA_SOURCE' }),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testPatch_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/test`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'CONNECTED' }),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testDelete_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/test`, { method: 'DELETE' });
  assertStatus(res.status, 401, res.data);
}

export async function testImessageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testWhatsappUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testWhatsappConnect_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/connect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testTelegramConnect_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/connect`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testTelegramUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testCookiesUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/cookies/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testLocalStorageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/localStorage/upload`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

export async function testIndexedDBUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/indexedDB/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testFingerprintUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/fingerprint/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testPermissionsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/permissions/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testCacheStorageUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/cacheStorage/upload`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

export async function testPasswordsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testApplePasswordsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/apple/upload`, {
    method: 'POST',
  });
  assertStatus(res.status, 401, res.data);
}

export async function testPasswordsRequest_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testEmailStart_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/gmail/start`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testEmailMessages_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/messages`);
  assertStatus(res.status, 401, res.data);
}

export async function testEmailGmailAccountDelete_noAuth() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('noauth@gmail.com')}`,
    { method: 'DELETE' }
  );
  assertStatus(res.status, 401, res.data);
}

export async function testEmailGmailAccountResync_noAuth() {
  const res = await request(
    `${BASE_URL}/api/integrations/email/gmail/accounts/${encodeURIComponent('noauth@gmail.com')}/resync`,
    { method: 'POST' }
  );
  assertStatus(res.status, 401, res.data);
}

export async function testEmailSend_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/send`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testLinkedinUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/linkedin/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testContactsUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/contacts/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testEmailUpload_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/email/upload`, { method: 'POST' });
  assertStatus(res.status, 401, res.data);
}

export async function testClaudeCodeCredentials_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testClaudeCodeToken_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/credentials/token`);
  assertStatus(res.status, 401, res.data);
}

export async function testClaudeCodeRateLimited_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/token/rate-limited`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}

export async function testAnthropicApiKeyCooldown_markThenOnCooldown() {
  const previous = await snapshotAnthropicApiKeyCooldown();
  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ type: 'anthropic', source: 'pool', failureReason: 'out_of_credits' }),
    });
    assertStatus(mark.status, 200, mark.data);

    const status = await request(
      `${BASE_URL}/api/integrations/compute-code/anthropic-key/cooldown`,
      {
        headers: apiKeyHeaders(),
      }
    );
    assertStatus(status.status, 200, status.data);
    assert(
      typeof (status.data as { configured?: unknown }).configured === 'boolean',
      'anthropic availability should report whether the running backend configured the key'
    );
    assert(
      (status.data as { onCooldown?: boolean }).onCooldown === true,
      'anthropic key should report on-cooldown after being marked rate-limited'
    );
  } finally {
    await restoreAnthropicApiKeyCooldown(previous);
    await waitForServerFundedKeyCooldown({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      key: 'anthropic',
      onCooldown: cooldownIsLive(previous),
    });
  }
}

export async function testGptApiKeyCooldown_markThenOnCooldown() {
  const { __clearGptApiKeyCooldownCache } = await import('../../providers/computeCredentials');
  const key = {
    userId: ANTHROPIC_COOLDOWN_USER_ID,
    name: GPT_API_KEY_COOLDOWN_NAME,
    accountId: '',
  };
  const previous = await prisma.integration.findUnique({
    where: { userId_name_accountId: key },
    select: { id: true, rateLimitedUntil: true, failureReason: true, updatedAt: true },
  });
  try {
    const mark = await request(`${BASE_URL}/api/integrations/compute-code/token/rate-limited`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        type: 'gpt_api_key',
        source: 'pool',
        failureReason: 'RosePaymentRequiredError',
      }),
    });
    assertStatus(mark.status, 200, mark.data);
    const status = await request(`${BASE_URL}/api/integrations/compute-code/gpt-key/cooldown`, {
      headers: apiKeyHeaders(),
    });
    assertStatus(status.status, 200, status.data);
    assert(
      typeof (status.data as { configured?: unknown }).configured === 'boolean',
      'GPT key status should report configuration without revealing the key'
    );
    assert(
      (status.data as { onCooldown?: boolean }).onCooldown === true,
      'GPT key should be cooled across clients after a credit failure'
    );
    const row = await prisma.integration.findUnique({ where: { userId_name_accountId: key } });
    assert(
      row?.rateLimitedUntil && row.rateLimitedUntil > new Date(),
      'cooldown is persisted in DB'
    );
  } finally {
    if (previous === null) {
      await prisma.integration.deleteMany({ where: key });
    } else {
      await prisma.integration.update({
        where: { id: previous.id },
        data: {
          rateLimitedUntil: previous.rateLimitedUntil,
          failureReason: previous.failureReason,
          updatedAt: previous.updatedAt,
        },
      });
    }
    // Resets only this process's cache; the backend under test keeps the funded GPT key cooled for
    // the full window, so real-credential smokes on a shared backend must run before this case.
    __clearGptApiKeyCooldownCache();
    await waitForServerFundedKeyCooldown({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      key: 'gpt',
      onCooldown: cooldownIsLive(previous),
    });
  }
  if (previous === null) {
    // The API runs in a different process. Removing the fixture row must make
    // that process observe the restored funded-key availability too.
    const status = await retryWithBackoff(
      async () => {
        const status = await request(`${BASE_URL}/api/integrations/compute-code/gpt-key/cooldown`, {
          headers: apiKeyHeaders(),
        });
        assertStatus(status.status, 200, status.data);
        return status;
      },
      {
        maxRetries: 73,
        fixedDelays: Array(72).fill(250),
        shouldRetryResult: (result) =>
          (result.data as { onCooldown?: boolean }).onCooldown === true,
        component: 'funded GPT key cooldown cleanup',
      }
    );
    assert(
      (status.data as { onCooldown?: boolean }).onCooldown !== true,
      'backend retained the fixture funded-key cooldown after DB cleanup'
    );
  }
}

export async function testClaudeCodePoolRateLimited_noAuth() {
  const res = await request(`${BASE_URL}/api/integrations/claude-code/pool-token/rate-limited`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 401, res.data);
}
