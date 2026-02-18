import crypto from 'crypto';
import { prisma } from './prisma';

/**
 * Decrypt an RSA+AES-GCM encrypted envelope.
 * Mirrors the Python decrypt_password() in agents/tools/spawn_browser_agent_v3.py.
 *
 * @param encryptedEnvelope - Base64-encoded JSON envelope with encrypted_aes_key, iv, ciphertext
 * @param decryptionKeyB64 - Base64-encoded PEM RSA private key
 * @returns Decrypted plaintext string, or null on failure
 */
export function decryptCredentialEnvelope(encryptedEnvelope: string, decryptionKeyB64: string): string | null {
  try {
    const envelopeJson = Buffer.from(encryptedEnvelope, 'base64').toString('utf8');
    const envelope = JSON.parse(envelopeJson);

    if (envelope.version !== 1) {
      console.error('[ClaudeCredentials] Unknown envelope version:', envelope.version);
      return null;
    }

    if (!envelope.encrypted_aes_key || !envelope.iv || !envelope.ciphertext) {
      console.error('[ClaudeCredentials] Malformed envelope: missing encrypted_aes_key, iv, or ciphertext');
      return null;
    }

    // Load RSA private key from base64-encoded PEM
    const privateKeyPem = Buffer.from(decryptionKeyB64, 'base64').toString('utf8');

    // Decrypt AES key with RSA-OAEP
    const encryptedAesKey = Buffer.from(envelope.encrypted_aes_key, 'base64');
    const aesKey = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedAesKey
    );

    // Decrypt data with AES-256-GCM
    const iv = Buffer.from(envelope.iv, 'base64');
    const ciphertextWithTag = Buffer.from(envelope.ciphertext, 'base64');
    const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return plaintext.toString('utf8');
  } catch (error) {
    console.error('[ClaudeCredentials] Failed to decrypt credential envelope:', error);
    return null;
  }
}

/**
 * Fetch and decrypt Claude Code credentials for a user.
 * Returns the decrypted credentials JSON string, or null if unavailable.
 */
export async function fetchClaudeCodeCredentials(userId: string): Promise<string | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    console.log('[ClaudeCredentials] CLAUDE_CREDENTIAL_DECRYPTION_KEY not set, skipping credential lookup');
    return null;
  }

  try {
    const integration = await prisma.integration.findFirst({
      where: {
        userId,
        name: 'claude_code',
        status: 'CONNECTED',
      },
    });

    if (!integration) {
      console.log(`[ClaudeCredentials] No claude_code integration found for user ${userId}`);
      return null;
    }

    const config = integration.config as Record<string, unknown> | null;
    const encryptedCredentials = config?.encryptedCredentials as string | undefined;
    if (!encryptedCredentials) {
      console.log(`[ClaudeCredentials] claude_code integration has no encryptedCredentials for user ${userId}`);
      return null;
    }

    const decrypted = decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
    if (!decrypted) {
      console.error(`[ClaudeCredentials] Failed to decrypt Claude Code credentials for user ${userId}`);
      return null;
    }

    console.log(`[ClaudeCredentials] Successfully decrypted Claude Code credentials for user ${userId}`);
    return decrypted;
  } catch (error) {
    console.error(`[ClaudeCredentials] Error fetching Claude Code credentials for user ${userId}:`, error);
    return null;
  }
}

// Claude Code OAuth constants (from claude-code CLI source)
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';

// Buffer before expiry to trigger refresh (60 seconds)
const EXPIRY_BUFFER_MS = 60_000;

/**
 * Re-encrypt credentials using RSA+AES-GCM (derives public key from private key).
 */
function encryptCredentialEnvelope(data: string, decryptionKeyB64: string): string {
  const privateKeyPem = Buffer.from(decryptionKeyB64, 'base64').toString('utf8');
  const publicKey = crypto.createPublicKey(privateKeyPem);

  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  const encryptedAesKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey
  );

  const envelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Refresh an expired Claude Code OAuth token.
 * Returns the new access token and updates stored credentials.
 */
async function refreshClaudeCodeToken(
  userId: string,
  credentials: any,
  integrationId: string
): Promise<string | null> {
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.refreshToken) {
    console.error(`[ClaudeCredentials] No refresh token available for user ${userId}`);
    return null;
  }

  console.log(`[ClaudeCredentials] Refreshing expired OAuth token for user ${userId}...`);

  try {
    const resp = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        scope: CLAUDE_SCOPES,
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`[ClaudeCredentials] Token refresh failed: ${resp.status} - ${errorText}`);
      return null;
    }

    const data = await resp.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    // Update credentials with new tokens
    credentials.claudeAiOauth.accessToken = data.access_token;
    if (data.refresh_token) {
      credentials.claudeAiOauth.refreshToken = data.refresh_token;
    }
    credentials.claudeAiOauth.expiresAt = Date.now() + (data.expires_in * 1000);

    // Re-encrypt and store
    const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY!;
    const encrypted = encryptCredentialEnvelope(JSON.stringify(credentials), decryptionKey);

    // Merge encryptedCredentials into existing config to preserve other fields
    const existingIntegration = await prisma.integration.findUnique({ where: { id: integrationId } });
    const existingConfig = (existingIntegration?.config as Record<string, unknown>) || {};

    await prisma.integration.update({
      where: { id: integrationId },
      data: { config: { ...existingConfig, encryptedCredentials: encrypted } },
    });

    console.log(`[ClaudeCredentials] Token refreshed successfully for user ${userId}, expires in ${data.expires_in}s`);
    return data.access_token;
  } catch (error) {
    console.error(`[ClaudeCredentials] Token refresh error for user ${userId}:`, error);
    return null;
  }
}

/**
 * Fetch the Claude Code OAuth access token for a user.
 * Automatically refreshes expired tokens.
 * Returns just the access token string, or null if unavailable.
 */
export async function fetchClaudeCodeAccessToken(userId: string): Promise<string | null> {
  const decryptionKey = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!decryptionKey) {
    console.log('[ClaudeCredentials] CLAUDE_CREDENTIAL_DECRYPTION_KEY not set');
    return null;
  }

  try {
    const integration = await prisma.integration.findFirst({
      where: { userId, name: 'claude_code', status: 'CONNECTED' },
    });

    if (!integration) {
      console.log(`[ClaudeCredentials] No claude_code integration found for user ${userId}`);
      return null;
    }

    const config = integration.config as Record<string, unknown> | null;
    const encryptedCredentials = config?.encryptedCredentials as string | undefined;
    if (!encryptedCredentials) return null;

    const decrypted = decryptCredentialEnvelope(encryptedCredentials, decryptionKey);
    if (!decrypted) return null;

    const parsed = JSON.parse(decrypted);
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken) {
      console.error(`[ClaudeCredentials] Credentials missing accessToken for user ${userId}`);
      return null;
    }

    // Check if token is expired or about to expire
    if (oauth.expiresAt && oauth.expiresAt < Date.now() + EXPIRY_BUFFER_MS) {
      console.log(`[ClaudeCredentials] Token expired for user ${userId} (expired ${new Date(oauth.expiresAt).toISOString()})`);
      return await refreshClaudeCodeToken(userId, parsed, integration.id);
    }

    return oauth.accessToken;
  } catch (error) {
    console.error(`[ClaudeCredentials] Failed to fetch access token for user ${userId}:`, error);
    return null;
  }
}
