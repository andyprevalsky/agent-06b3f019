#!/usr/bin/env tsx
/**
 * Black-box tests for the AgentCard "for companies" HTTP surface
 * (`/api/agentcard/*`).
 *
 * Exercises the no-network route branches end-to-end against the live backend:
 * OAuth/onboarding callback rendering, the authenticated status/tools/tools-call
 * seam (connected vs. connect-link), and the auth guards. A per-user token is
 * seeded directly in the shared database to cover the connected status path.
 */

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import {
  refreshOrgCardholderStatus,
  startOrgCardholderOnboarding,
} from '../../providers/agentcard/org-onboarding';
import { AgentCardOrgRuntime } from '../../providers/agentcard/org-runtime';
import {
  saveUserToken,
  getV2ConnectedUserId,
  saveV2ConnectedUserId,
  AgentCardV2BindingConflictError,
} from '../../providers/agentcard/store';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

const trackedUserIds = new Set<string>();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

async function request(
  path: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    redirect: 'manual',
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data, headers: response.headers };
}

function apiKeyHeaders(userId?: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, ...(userId ? { 'X-User-Id': userId } : {}) };
}

async function createUser(label: string): Promise<string> {
  const userId = `agentcard-bb-${RUN_ID}-${label}-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  trackedUserIds.add(userId);
  return userId;
}

const StatusResponse = z.object({
  connected: z.boolean(),
  expiresAt: z.string().optional(),
  expired: z.boolean().optional(),
  status: z.string().optional(),
  setupUrl: z.string().optional(),
  setupSessionId: z.string().optional(),
});

const NotConnectedTools = z.object({
  connected: z.literal(false),
  connectUrl: z.string(),
});

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    'v2 connect rejects unsigned and forged browser links without sending a code',
    async () => {
      for (const suffix of ['', '?user=victim&session=unknown&t=forged']) {
        const res = await request(`/api/agentcard/v2/connect${suffix}`);
        assertStatus(res.status, 400, res.data);
        assert(res.headers.get('cache-control') === 'no-store', 'setup pages must not be cached');
      }
      for (const step of ['start', 'verify']) {
        const res = await request(`/api/agentcard/v2/connect/${step}`, {
          method: 'POST',
          body: JSON.stringify({ user: 'victim', user_id: 'usr_attacker' }),
        });
        assertStatus(res.status, 400, res.data);
      }
    },
  ],
  [
    'v2 provider identity binding is exclusive under concurrent writes and never aliases legacy ids',
    async () => {
      const first = await createUser('v2-first');
      const second = await createUser('v2-second');
      const providerId = `usr_v2_${randomUUID()}`;
      const results = await Promise.allSettled([
        saveV2ConnectedUserId(first, providerId),
        saveV2ConnectedUserId(second, providerId),
      ]);
      assert(
        results.filter((result) => result.status === 'fulfilled').length === 1,
        'exactly one binder must win'
      );
      const rejected = results.find((result) => result.status === 'rejected');
      assert(
        rejected?.status === 'rejected' &&
          rejected.reason instanceof AgentCardV2BindingConflictError,
        'second binder must get a binding conflict'
      );
      const ids = await Promise.all([getV2ConnectedUserId(first), getV2ConnectedUserId(second)]);
      assert(ids.filter((id) => id === providerId).length === 1, 'only one persisted owner');
      const owner = ids[0] ? first : second;
      await saveV2ConnectedUserId(owner, providerId);
      let replacementRejected = false;
      try {
        await saveV2ConnectedUserId(owner, `usr_new_${randomUUID()}`);
      } catch (error) {
        replacementRejected = error instanceof AgentCardV2BindingConflictError;
      }
      assert(replacementRejected, 'existing owner identity must not be silently replaced');
      await prisma.integration.updateMany({
        where: { userId: owner, name: 'agentcard' },
        data: { config: { orgManaged: true, cardholderId: 'ch_legacy_only' } },
      });
      assert(
        (await getV2ConnectedUserId(owner)) === undefined,
        'legacy MCP cardholder is never a v2 user'
      );
    },
  ],
  [
    'organization onboarding preserves AgentCard configuration errors',
    async () => {
      const capturedResponse = {
        content: [
          {
            type: 'text',
            text: 'create_onboarding_session failed: return_url does not match any registered onboarding return URL',
          },
        ],
        structuredContent: {
          status: 'error',
          message:
            'create_onboarding_session failed: return_url does not match any registered onboarding return URL',
        },
      };
      let observed: unknown;
      try {
        await startOrgCardholderOnboarding('agentcard-bb-onboarding-error', {
          getOrgOnboardingConfig: async () => undefined,
          callOrgTool: async () => capturedResponse,
          saveOrgOnboardingConfig: async () => {
            throw new Error('an error response must never be persisted as onboarding state');
          },
        });
      } catch (error) {
        observed = error;
      }
      assert(observed instanceof Error, 'expected the captured AgentCard error to be thrown');
      assert(
        observed.message.includes('return_url does not match any registered onboarding return URL'),
        `expected the original configuration error, got: ${observed.message}`
      );
    },
  ],
  [
    'organization onboarding preserves failed business status',
    async () => {
      const result = await refreshOrgCardholderStatus('agentcard-bb-failed-status', {
        getOrgManagedCardholderId: async () => 'cardholder-failed',
        callOrgTool: async () => ({
          structuredContent: { status: 'failed' },
          content: [{ type: 'text', text: JSON.stringify({ status: 'failed' }) }],
        }),
      });
      assert(result.connected === false, 'failed KYC must not be reported as connected');
      assert(result.status === 'failed', 'failed KYC must remain observable as business state');
    },
  ],
  [
    'organization onboarding status recovers from a structured provider throttle',
    async () => {
      const names = [
        'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
        'AGENTCARD_ORG_OAUTH_CLIENT_ID',
        'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
      ] as const;
      const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      try {
        delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
        delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET;
        process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'blackbox-org-token';
        let calls = 0;
        const runtime = new AgentCardOrgRuntime(async (_token, toolName, args) => {
          assert(toolName === 'get_onboarding_session', `unexpected tool: ${toolName}`);
          assert(args.session_id === 'session-throttled', 'wrong onboarding session queried');
          calls += 1;
          if (calls === 1) {
            return {
              structuredContent: {
                status: 'error',
                message:
                  'get_onboarding_session failed: API key rate limit exceeded, please try again later',
              },
            };
          }
          return { structuredContent: { status: 'completed', cardholder_id: 'cardholder-ready' } };
        });
        const status = await refreshOrgCardholderStatus('agentcard-bb-structured-throttle', {
          getOrgManagedCardholderId: async () => undefined,
          getOrgOnboardingConfig: async () => ({
            sessionId: 'session-throttled',
            setupUrl: 'https://example.test/setup',
          }),
          callOrgTool: (toolName, args) => runtime.callTool(toolName, args),
          saveOrgCardholderId: async (_userId, cardholderId) => {
            assert(cardholderId === 'cardholder-ready', 'completed cardholder was not persisted');
          },
        });
        assert(calls === 2, `expected one retry, got ${calls} calls`);
        assert(status.connected === true, 'completed onboarding must report connected');
        assert(status.cardholderId === 'cardholder-ready', 'wrong cardholder returned');
      } finally {
        for (const name of names) {
          if (original[name] === undefined) delete process.env[name];
          else process.env[name] = original[name];
        }
      }
    },
  ],
  [
    'status rejects unauthenticated requests',
    async () => {
      const res = await request('/api/agentcard/status');
      assertStatus(res.status, 401, res.data);
    },
  ],
  [
    'status reports not-connected for a user without a token',
    async () => {
      const userId = await createUser('status-none');
      const res = await request('/api/agentcard/status', { headers: apiKeyHeaders(userId) });
      assertStatus(res.status, 200, res.data);
      const body = StatusResponse.parse(res.data);
      assert(body.connected === false, 'expected connected=false');
    },
  ],
  [
    'status reports connected once a token is stored',
    async () => {
      const userId = await createUser('status-connected');
      await saveUserToken(userId, {
        accessToken: `at_${randomUUID()}`,
        tokenType: 'bearer',
        expiresAt: Date.now() + 3600_000,
      });
      const res = await request('/api/agentcard/status', { headers: apiKeyHeaders(userId) });
      assertStatus(res.status, 200, res.data);
      const body = StatusResponse.parse(res.data);
      assert(body.connected === true, 'expected connected=true');
      assert(body.expired === false, 'a fresh token must not be expired');
      assert(typeof body.expiresAt === 'string', 'expiresAt should be surfaced');
    },
  ],
  [
    'tools rejects unauthenticated requests',
    async () => {
      const res = await request('/api/agentcard/tools');
      assertStatus(res.status, 401, res.data);
    },
  ],
  [
    'tools returns a connect link when the user has no token',
    async () => {
      const userId = await createUser('tools-none');
      const res = await request('/api/agentcard/tools', { headers: apiKeyHeaders(userId) });
      assertStatus(res.status, 200, res.data);
      const body = NotConnectedTools.parse(res.data);
      assert(body.connectUrl.includes(encodeURIComponent(userId)), 'connect link targets the user');
    },
  ],
  [
    'tools/call requires a tool name',
    async () => {
      const userId = await createUser('call-missing-name');
      const res = await request('/api/agentcard/tools/call', {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify({ arguments: {} }),
      });
      assertStatus(res.status, 400, res.data);
    },
  ],
  [
    'tools/call returns 409 with a connect link when not connected',
    async () => {
      const userId = await createUser('call-none');
      const res = await request('/api/agentcard/tools/call', {
        method: 'POST',
        headers: apiKeyHeaders(userId),
        body: JSON.stringify({ name: 'list_cards', arguments: {} }),
      });
      assertStatus(res.status, 409, res.data);
      const body = NotConnectedTools.parse(res.data);
      assert(body.connectUrl.length > 0, 'expected a connect link');
    },
  ],
  [
    'connect requires a user query param',
    async () => {
      const res = await request('/api/agentcard/connect');
      assertStatus(res.status, 400, res.data);
    },
  ],
  [
    'connect rejects a user id without a valid signature',
    async () => {
      // An attacker cannot initiate account linking for an arbitrary user by
      // passing a bare (unsigned) user id — the signed token is mandatory.
      const res = await request(`/api/agentcard/connect?user=victim-${randomUUID()}`);
      assertStatus(res.status, 400, res.data);
      assert(
        String(JSON.stringify(res.data)).includes('Invalid or expired connection link'),
        'unsigned connect attempt should be rejected'
      );
    },
  ],
  [
    'connect rejects a forged signature token',
    async () => {
      const res = await request(
        `/api/agentcard/connect?user=victim-${randomUUID()}&t=${encodeURIComponent(
          `${Date.now() + 60_000}.forged-signature`
        )}`
      );
      assertStatus(res.status, 400, res.data);
      assert(
        String(JSON.stringify(res.data)).includes('Invalid or expired connection link'),
        'forged connect token should be rejected'
      );
    },
  ],
  [
    'callback renders an error page when the provider reports an error',
    async () => {
      const res = await request('/api/agentcard/callback?error=access_denied');
      assertStatus(res.status, 400, res.data);
      assert(
        (res.headers.get('content-type') ?? '').includes('text/html'),
        'callback should render HTML'
      );
      assert(String(res.data).includes('access_denied'), 'error reason should be shown');
    },
  ],
  [
    'callback renders an error page when code/state are missing',
    async () => {
      const res = await request('/api/agentcard/callback?code=abc');
      assertStatus(res.status, 400, res.data);
      assert(
        String(res.data).includes('Missing authorization code or state'),
        'missing state page'
      );
    },
  ],
  [
    'callback renders an error page for an unknown OAuth state',
    async () => {
      const res = await request(`/api/agentcard/callback?code=abc&state=unknown-${randomUUID()}`);
      assertStatus(res.status, 400, res.data);
      assert(String(res.data).includes('Failed to connect AgentCard'), 'unknown-state error page');
    },
  ],
  [
    'onboarding callback renders an error page when params are missing',
    async () => {
      const res = await request('/api/agentcard/onboarding/callback');
      assertStatus(res.status, 400, res.data);
      assert(
        String(res.data).includes('Missing onboarding session or state'),
        'missing onboarding params page'
      );
    },
  ],
];

async function cleanup(): Promise<void> {
  for (const userId of trackedUserIds) {
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  console.log(`Running AgentCard black-box tests (${tests.length} tests)...`);
  const results: TestResult[] = [];
  try {
    for (const [name, fn] of tests) {
      results.push(await runTest(name, fn));
    }
  } finally {
    await cleanup();
  }

  const passed = results.filter((result) => result.passed).length;
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${result.duration}ms)`);
    if (!result.passed) console.log(`  ${result.error}`);
  }
  console.log(`\nAgentCard black-box tests: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  await cleanup();
  process.exit(1);
});
