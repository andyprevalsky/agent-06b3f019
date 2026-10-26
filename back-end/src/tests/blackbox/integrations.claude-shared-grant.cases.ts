/**
 * A Claude Code sandbox must never spend a refresh token it shares with
 * another holder of the same Claude OAuth grant.
 *
 * Anthropic refresh tokens are single-use and a refresh revokes every earlier
 * access token of that grant (measured; `compute-token-semantics.blackbox.ts`).
 * A user's `claude_code` Integration is a copy of the grant their own Claude Code
 * (Mac Keychain, devbox) still holds. When the sandbox CLI received the full
 * envelope and refreshed it, every other holder was signed out ("Not logged in ·
 * Please run /login"), and concurrent sandboxes revoked each other (2026-10-26).
 *
 * The sandbox CLI is modelled on Claude Code's own rules
 * (claude-code-src/src/utils/auth.ts getClaudeAIOAuthTokens /
 * checkAndRefreshOAuthTokenIfNeeded, services/oauth/client.ts isOAuthTokenExpired):
 * CLAUDE_CODE_OAUTH_TOKEN is inference-only and never refreshed; a credentials
 * file with a refresh token is refreshed once it is within 5 minutes of expiry,
 * and force-refreshed after a 401.
 */
import { FakeIdp } from './compute-token-semantics.blackbox';
import { resolveClaudeCodeAuthEnvs } from '../../providers/claudeCodeSandboxAuth';
import {
  assert,
  cleanupIntegrations,
  crypto,
  encryptClaudeEnvelope,
  fetchClaudeCodeCredentialsWithMeta,
  prisma,
} from './integrations.context';

const TOKEN_PREFIX = 'sk-ant-oat01-';
const CLAUDE_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** What Claude Code inside the sandbox does with the auth env it was given. */
function runSandboxClaudeCli(
  idp: FakeIdp,
  envs: Record<string, string>
): 'env-token' | 'refreshed' | 'file-token' | 'none' {
  if (envs.CLAUDE_CODE_OAUTH_TOKEN) {
    // Inference-only: refreshToken null, never refreshed. A 401 just fails.
    return 'env-token';
  }
  if (!envs.CLAUDE_CODE_CREDENTIALS) return 'none';
  const oauth = (
    JSON.parse(envs.CLAUDE_CODE_CREDENTIALS) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number | null };
    }
  ).claudeAiOauth;
  const refreshToken = oauth?.refreshToken ?? '';
  if (refreshToken === '') return 'file-token';
  const expiresAt = oauth?.expiresAt ?? null;
  const expired = expiresAt !== null && Date.now() + CLAUDE_EXPIRY_BUFFER_MS >= expiresAt;
  const accessToken = (oauth?.accessToken ?? '').slice(TOKEN_PREFIX.length);
  const rejected = !idp.accessTokenLiveSync(accessToken);
  if (expired || rejected) {
    try {
      idp.refreshSync(refreshToken);
    } catch {
      // invalid_grant: the CLI reports "Not logged in" inside the sandbox.
    }
    return 'refreshed';
  }
  return 'file-token';
}

async function seedSharedGrantRow(
  userId: string,
  grant: { accessToken: string; refreshToken: string },
  row: { expiresAt: number; status: 'CONNECTED' | 'EXPIRED' }
): Promise<string> {
  const integration = await prisma.integration.create({
    data: {
      userId,
      accountId: '',
      name: 'claude_code',
      type: 'TOOL_SETUP',
      status: row.status,
      isActive: row.status === 'CONNECTED',
      failureReason: row.status === 'EXPIRED' ? 'auth_error' : null,
      poolingEnabled: false,
      config: {
        encryptedCredentials: encryptClaudeEnvelope(
          JSON.stringify({
            claudeAiOauth: {
              accessToken: `${TOKEN_PREFIX}${grant.accessToken}`,
              refreshToken: grant.refreshToken,
              expiresAt: row.expiresAt,
              scopes: ['user:inference', 'user:profile'],
            },
          })
        ),
      },
    },
  });
  return integration.id;
}

const SCENARIOS: Array<{ label: string; expiresInMs: number; status: 'CONNECTED' | 'EXPIRED' }> = [
  { label: 'healthy CONNECTED envelope', expiresInMs: 6 * 60 * 60 * 1000, status: 'CONNECTED' },
  { label: 'near-expiry CONNECTED envelope', expiresInMs: 30_000, status: 'CONNECTED' },
  {
    label: 'direct auth_error EXPIRED envelope',
    expiresInMs: 6 * 60 * 60 * 1000,
    status: 'EXPIRED',
  },
];

export async function testClaudeCodeSandbox_neverSpendsSharedRefreshGrant() {
  const failures: string[] = [];
  for (const scenario of SCENARIOS) {
    const idp = new FakeIdp('claude');
    // The grant the user's own Claude Code (Mac Keychain / devbox) still holds.
    const device = idp.mintGrant();
    const owner = { userId: crypto.randomUUID() };
    const rowId = await seedSharedGrantRow(owner.userId, device, {
      expiresAt: Date.now() + scenario.expiresInMs,
      status: scenario.status,
    });
    try {
      const credential = await fetchClaudeCodeCredentialsWithMeta(owner.userId);
      const envs =
        credential && credential.source === 'user'
          ? resolveClaudeCodeAuthEnvs(credential, undefined, false)
          : {};
      if (JSON.stringify(envs).includes(device.refreshToken)) {
        failures.push(`${scenario.label}: sandbox env carries the shared refresh token`);
      }
      const outcome = runSandboxClaudeCli(idp, envs);
      if (!idp.accessTokenLiveSync(device.accessToken)) {
        failures.push(
          `${scenario.label}: sandbox CLI (${outcome}) revoked the device's access token`
        );
      }
      try {
        idp.refreshSync(device.refreshToken);
      } catch {
        failures.push(`${scenario.label}: the device's refresh token was already spent`);
      }
    } finally {
      await cleanupIntegrations([rowId]);
    }
  }
  assert(
    failures.length === 0,
    `Shared Claude grant rotated by a sandbox:\n  ${failures.join('\n  ')}`
  );
}

/**
 * Concurrent sandboxes of one user share one access token and never refresh it,
 * so N sandboxes cost zero refreshes and cannot revoke each other.
 */
export async function testClaudeCodeSandbox_concurrentSessionsShareOneAccessToken() {
  const idp = new FakeIdp('claude');
  const device = idp.mintGrant();
  const owner = { userId: crypto.randomUUID() };
  const rowId = await seedSharedGrantRow(owner.userId, device, {
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    status: 'CONNECTED',
  });
  try {
    const sessions = await Promise.all(
      Array.from({ length: 8 }, () => fetchClaudeCodeCredentialsWithMeta(owner.userId))
    );
    for (const credential of sessions) {
      assert(credential?.source === 'user', 'each sandbox must use the owner credential');
      const envs = resolveClaudeCodeAuthEnvs(credential, undefined, false);
      assert(
        envs.CLAUDE_CODE_OAUTH_TOKEN === `${TOKEN_PREFIX}${device.accessToken}`,
        'each sandbox must receive the access token as CLAUDE_CODE_OAUTH_TOKEN'
      );
      assert(runSandboxClaudeCli(idp, envs) === 'env-token', 'sandbox must not refresh');
    }
    assert(idp.accessTokenLiveSync(device.accessToken), 'device access token must stay live');
  } finally {
    await cleanupIntegrations([rowId]);
  }
}
