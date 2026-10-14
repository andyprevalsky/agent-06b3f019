import {
  request,
  BASE_URL,
  authHeaders,
  ctx,
  assertStatus,
  assertSchema,
  createAnonSession,
  assert,
} from './integrations.context';
import {
  ErrorResponse,
  MessagingUploadResponse,
  TelegramConnectResponse,
  IntegrationSchema,
} from './integrations.schemas';

// ==================== MESSAGING UPLOADS ====================

export async function testImessageUpload_emptyContacts() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ contacts: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'imessage empty contacts');
}

export async function testImessageUpload_missingContacts() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({}),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'imessage missing contacts');
}

export async function testImessageUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/imessage/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      contacts: [
        {
          name: 'Test Contact',
          phoneNumber: '+10000000001',
          messages: [
            {
              text: 'Hello test',
              date: new Date().toISOString(),
              is_from_me: false,
              handle_id: '+10000000001',
            },
          ],
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MessagingUploadResponse, res.data, 'imessage happy');
}

export async function testWhatsappUpload_emptyContacts() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ contacts: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'whatsapp empty contacts');
}

export async function testWhatsappUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      contacts: [
        {
          name: 'WhatsApp Contact',
          phoneNumber: '+10000000002',
          messages: [{ text: 'Hey!', timestamp: new Date().toISOString(), fromMe: false }],
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MessagingUploadResponse, res.data, 'whatsapp happy');
}

export async function testWhatsappConnect_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/whatsapp/connect`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(TelegramConnectResponse, res.data, 'whatsapp connect');
}

/**
 * Re-connecting an existing WhatsApp integration must merge config, not clobber
 * it — re-pairing is routine and must not drop stored integration settings.
 */
export async function testWhatsappConnect_preservesExistingConfig() {
  const { accessToken } = await createAnonSession();

  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      name: 'whatsapp',
      type: 'DATA_SOURCE',
      config: { existingPolicy: 'preserve-me', nested: { value: 1 } },
    }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  const connectRes = await request(`${BASE_URL}/api/integrations/whatsapp/connect`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  });
  assertStatus(connectRes.status, 200, connectRes.data);
  const body = assertSchema(TelegramConnectResponse, connectRes.data, 'whatsapp connect preserve');
  const integration = IntegrationSchema.passthrough().parse(body.integration);
  const config = integration.config as Record<string, unknown>;
  assert(
    config.existingPolicy === 'preserve-me',
    `Expected existing config to survive, got ${JSON.stringify(config)}`
  );
  assert(
    typeof config.lastConnectedAt === 'string',
    `Expected lastConnectedAt string, got ${JSON.stringify(config)}`
  );
}

export async function testTelegramConnect_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/connect`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(TelegramConnectResponse, res.data, 'telegram connect');
}

export async function testTelegramUpload_emptyContacts() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ contacts: [] }),
  });
  assertStatus(res.status, 400, res.data);
  assertSchema(ErrorResponse, res.data, 'telegram empty contacts');
}

export async function testTelegramUpload_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/telegram/upload`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({
      contacts: [
        {
          name: 'Telegram Contact',
          username: 'testuser',
          messages: [{ text: 'Telegram msg', date: new Date().toISOString(), fromMe: false }],
        },
      ],
    }),
  });
  assertStatus(res.status, 200, res.data);
  assertSchema(MessagingUploadResponse, res.data, 'telegram happy');
}
