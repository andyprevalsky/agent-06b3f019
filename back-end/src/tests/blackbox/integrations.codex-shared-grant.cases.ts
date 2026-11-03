/**
 * A Codex sandbox must never spend a refresh token it shares with another
 * holder of the same ChatGPT/Codex OAuth grant.
 *
 * A user's `gpt_code` Integration is a copy of the `~/.codex/auth.json` grant
 * their own Codex CLI (Mac, devbox) still holds. OpenAI rotates the refresh
 * token on every refresh; the holder that did not refresh later fails with
 * `refresh_token_reused` / `refresh_token_invalidated` and is signed out
 * (2026-10-19: a prod rotation revoked the devbox `~/.codex`). When the sandbox
 * received the complete auth.json, its Codex CLI refreshed the shared grant
 * whenever the stored access token was stale.
 *
 * The sandbox CLI is modelled on Codex's own rules
 * (codex/codex-rs/login/src/auth/manager.rs should_refresh_proactively,
 * UnauthorizedRecovery): refresh when the access-token JWT expires within
 * 5 minutes, or, without a parseable `exp`, when `last_refresh` is older than
 * 8 days. A refresh with an empty refresh token fails and the CLI keeps the
 * access token it has.
 */
import { FakeIdp } from './compute-token-semantics.blackbox';
import { resolveCodexCodeAuthEnvs } from '../../providers/claudeCodeSandboxAuth';
import { fetchGptCodeCredentialsWithMeta } from '../../providers/gptCredentials';
import {
  assert,
  cleanupIntegrations,
  crypto,
  encryptClaudeEnvelope,
  prisma,
} from './integrations.context';

const CODEX_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const CODEX_LAST_REFRESH_MAX_MS = 8 * 24 * 60 * 60 * 1000;

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** An unsigned ChatGPT-style access-token JWT carrying `exp` (seconds). */
function accessTokenJwt(expMs: number): string {
  return [
    base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64Url(JSON.stringify({ exp: Math.floor(expMs / 1000), jti: crypto.randomUUID() })),
    'sig',
  ].join('.');
}

function jwtExpMs(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** What the Codex CLI inside the sandbox does with the auth env it was given. */
function runSandboxCodexCli(
  idp: FakeIdp,
  envs: Record<string, string>
): 'access-token' | 'refreshed' | 'refresh-failed' | 'api-key' | 'none' {
  if (!envs.CODEX_AUTH_JSON) return envs.OPENAI_API_KEY ? 'api-key' : 'none';
  const auth = JSON.parse(envs.CODEX_AUTH_JSON) as {
    tokens?: { access_token?: string; refresh_token?: string };
    last_refresh?: string;
  };
  const accessToken = auth.tokens?.access_token ?? '';
  const expMs = jwtExpMs(accessToken);
  const lastRefreshMs = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
  const stale =
    expMs !== null
      ? expMs <= Date.now() + CODEX_REFRESH_WINDOW_MS
      : Number.isFinite(lastRefreshMs) && lastRefreshMs < Date.now() - CODEX_LAST_REFRESH_MAX_MS;
  if (!stale) return 'access-token';
  try {
    idp.refreshSync(auth.tokens?.refresh_token ?? '');
    return 'refreshed';
  } catch {
    return 'refresh-failed';
  }
}

async function seedSharedCodexRow(
  userId: string,
  tokens: { accessToken: string; refreshToken: string },
  lastRefresh: Date
): Promise<string> {
  const integration = await prisma.integration.create({
    data: {
      userId,
      accountId: '',
      name: 'gpt_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: false,
      config: {
        encryptedCredentials: encryptClaudeEnvelope(
          JSON.stringify({
            OPENAI_API_KEY: null,
            auth_mode: 'chatgpt',
            tokens: {
              id_token: 'id-token',
              access_token: tokens.accessToken,
              refresh_token: tokens.refreshToken,
              account_id: `acct-${crypto.randomUUID()}`,
            },
            last_refresh: lastRefresh.toISOString(),
          })
        ),
      },
    },
  });
  return integration.id;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SCENARIOS: Array<{
  label: string;
  accessToken: () => string;
  lastRefreshAgoMs: number;
  served: boolean;
}> = [
  {
    label: 'healthy auth.json',
    accessToken: () => accessTokenJwt(Date.now() + 9 * DAY_MS),
    lastRefreshAgoMs: DAY_MS,
    served: true,
  },
  {
    label: 'near-expiry access token',
    accessToken: () => accessTokenJwt(Date.now() + 60_000),
    lastRefreshAgoMs: 10 * DAY_MS,
    served: false,
  },
  {
    label: 'opaque access token with stale last_refresh',
    accessToken: () => `opaque-${crypto.randomUUID()}`,
    lastRefreshAgoMs: 9 * DAY_MS,
    served: true,
  },
];

export async function testCodexSandbox_neverSpendsSharedRefreshGrant() {
  const failures: string[] = [];
  for (const scenario of SCENARIOS) {
    const idp = new FakeIdp('codex');
    // The grant the user's own Codex CLI (`~/.codex/auth.json`) still holds.
    const device = idp.mintGrant();
    const owner = { userId: crypto.randomUUID() };
    const accessToken = scenario.accessToken();
    const rowId = await seedSharedCodexRow(
      owner.userId,
      { accessToken, refreshToken: device.refreshToken },
      new Date(Date.now() - scenario.lastRefreshAgoMs)
    );
    try {
      const credential = await fetchGptCodeCredentialsWithMeta(owner.userId);
      const servedOwner = credential?.source === 'user' && credential.userId === owner.userId;
      if (servedOwner !== scenario.served) {
        failures.push(`${scenario.label}: expected served=${scenario.served}, got ${servedOwner}`);
      }
      const envs = servedOwner ? resolveCodexCodeAuthEnvs(credential, undefined) : {};
      if (JSON.stringify(envs).includes(device.refreshToken)) {
        failures.push(`${scenario.label}: sandbox env carries the shared refresh token`);
      }
      if (servedOwner) {
        const auth = JSON.parse(envs.CODEX_AUTH_JSON ?? '{}') as {
          auth_mode?: string;
          tokens?: { access_token?: string; id_token?: string; account_id?: string };
        };
        if (
          auth.auth_mode !== 'chatgpt' ||
          auth.tokens?.access_token !== accessToken ||
          !auth.tokens?.id_token ||
          !auth.tokens?.account_id
        ) {
          failures.push(`${scenario.label}: sandbox auth.json lost its ChatGPT login fields`);
        }
      }
      const outcome = runSandboxCodexCli(idp, envs);
      if (servedOwner && outcome !== 'access-token') {
        // A doomed refresh surfaces as oauth_refresh_invalid and disables the row.
        failures.push(`${scenario.label}: sandbox CLI attempted a refresh (${outcome})`);
      }
      if (idp.refreshTokenSpentSync(device.refreshToken)) {
        failures.push(
          `${scenario.label}: sandbox CLI (${outcome}) spent the device's refresh token`
        );
      }
    } finally {
      await cleanupIntegrations([rowId]);
    }
  }
  assert(
    failures.length === 0,
    `Shared Codex grant rotated by a sandbox:\n  ${failures.join('\n  ')}`
  );
}

/**
 * Concurrent sandboxes of one user share one access token and never refresh it,
 * so N sandboxes cost zero refreshes and cannot rotate each other's grant.
 */
export async function testCodexSandbox_concurrentSessionsShareOneAccessToken() {
  const idp = new FakeIdp('codex');
  const device = idp.mintGrant();
  const owner = { userId: crypto.randomUUID() };
  const accessToken = accessTokenJwt(Date.now() + 9 * DAY_MS);
  const rowId = await seedSharedCodexRow(
    owner.userId,
    { accessToken, refreshToken: device.refreshToken },
    new Date()
  );
  try {
    const sessions = await Promise.all(
      Array.from({ length: 8 }, () => fetchGptCodeCredentialsWithMeta(owner.userId))
    );
    for (const credential of sessions) {
      assert(credential?.source === 'user', 'each sandbox must use the owner credential');
      const envs = resolveCodexCodeAuthEnvs(credential, undefined);
      const auth = JSON.parse(envs.CODEX_AUTH_JSON) as {
        tokens: { access_token: string; refresh_token: string };
      };
      assert(auth.tokens.access_token === accessToken, 'each sandbox gets the access token');
      assert(auth.tokens.refresh_token === '', 'no sandbox gets a refresh token');
      assert(runSandboxCodexCli(idp, envs) === 'access-token', 'sandbox must not refresh');
    }
    assert(
      !idp.refreshTokenSpentSync(device.refreshToken),
      'device refresh token must stay unspent'
    );
  } finally {
    await cleanupIntegrations([rowId]);
  }
}
