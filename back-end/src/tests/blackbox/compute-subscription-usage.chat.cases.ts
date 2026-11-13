/**
 * Chat-path cases of the compute-subscription-usage domain: the backend's own
 * Rose completions record the subscription's usage on the leased row.
 *
 *   fetchChatComputeAuth ── real fetchComputeTokenForUser (seeded, encrypted login)
 *     └─ callWithChatComputeRotation ── createStreamingCompletion(claude_token | gpt_token)
 *          └─ scripted provider response (200 / 429 with usage headers)
 *               └─ observeSubscriptionUsage → background write → GET /api/compute-accounts
 *
 * The background write is awaited through the sink the test wraps, never by
 * polling; the completion itself never waits for it (the stalled-sink case).
 */

import type { IntegrationType } from '@prisma/client';
import {
  callWithChatComputeRotation,
  fetchChatComputeAuth,
} from '../../providers/chat/computeRotation';
import { prisma } from '../../providers/database';
import { createStreamingCompletion } from '../../providers/rose';
import { subscriptionUsageSink } from '../../providers/rose/subscriptionUsage';
import { ANTHROPIC_API_URL, CODEX_API_URL } from '../../providers/rose/transport';
import { encryptClaudeEnvelope } from './integrations.context';

interface ChatAccountDto {
  provider: string;
  accountId: string;
  usage: {
    fiveHour: { usedPct: number; resetsAt: string | null } | null;
    sevenDay: { usedPct: number; resetsAt: string | null } | null;
    source: string;
    status: string | null;
  } | null;
  cooldown: { until: string; reason: string; authoritative: boolean } | null;
  nextResetAt: string | null;
}

export interface ChatPathContext {
  test: (name: string, fn: () => Promise<void>) => void;
  listAccounts: (userId: string, provider?: string) => Promise<ChatAccountDto[]>;
  run: string;
  baseUrl: string;
  chatUsers: string[];
  integrationType: IntegrationType;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function registerChatPathCases(ctx: ChatPathContext): void {
  /** The account's bar data after every background usage write of the turn settled. */
  async function settledAccount(
    userId: string,
    provider: string,
    accountId: string,
    writes: Array<Promise<boolean>>
  ) {
    assert(writes.length > 0, 'the turn must write the usage it observed');
    await Promise.all(writes);
    return (await ctx.listAccounts(userId, provider)).find((a) => a.accountId === accountId);
  }

  type ChatProvider = 'claude' | 'codex';
  type ScriptedResponse = (init: RequestInit | undefined) => Response;

  const originalFetch = global.fetch;
  const DAY_MS = 86_400_000;
  const epochSeconds = (offsetMs: number) => Math.floor((Date.now() + offsetMs) / 1000);
  const isoFromEpoch = (epoch: number) => new Date(epoch * 1000).toISOString();

  const ANTHROPIC_OK_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: [DONE]',
    '',
  ].join('\n');

  /**
   * A user with one connected subscription login whose stored token is `token`.
   * The chat path leases it through the real fetchComputeTokenForUser.
   */
  async function seedChatLogin(provider: ChatProvider, token: string) {
    const userId = `usage-chat-${provider}-${ctx.run}-${ctx.chatUsers.length}`;
    ctx.chatUsers.push(userId);
    const accountId = `${userId}-acct`;
    const credentials =
      provider === 'claude'
        ? JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + DAY_MS } })
        : JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: { access_token: token, account_id: accountId },
          });
    await prisma.computeAccountConnection.create({
      data: { userId, provider, accountId, accountEmail: `${accountId}@example.com` },
    });
    await prisma.integration.create({
      data: {
        userId,
        type: ctx.integrationType,
        name: provider === 'claude' ? 'claude_code' : 'gpt_code',
        status: 'CONNECTED',
        isActive: true,
        accountId,
        config: { encryptedCredentials: encryptClaudeEnvelope(credentials) },
      },
    });
    return { userId, accountId };
  }

  /**
   * Run one chat turn the way the chat router does, with the provider answering
   * from `script` for the leased subscription token and refusing everything else.
   */
  async function runChatTurn(userId: string, token: string, script: ScriptedResponse) {
    const scriptedUrls = [ANTHROPIC_API_URL, CODEX_API_URL];
    global.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL | Request).toString();
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (scriptedUrls.includes(url) && auth === `Bearer ${token}`) return script(init);
      if (url.startsWith(ctx.baseUrl))
        return originalFetch(input as Parameters<typeof fetch>[0], init);
      return new Response('{"error":"not scripted"}', { status: 500 });
    }) as typeof fetch;
    // Only the leased subscription may answer: funded legs (API keys, Foundry)
    // would serve the turn and hide the subscription's own response.
    const fundedKeys = Object.keys(process.env).filter(
      (key) =>
        key.startsWith('AZURE_FOUNDRY') ||
        ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GPT_API_KEY', 'CEREBRAS_API_KEY'].includes(key)
    );
    const saved = Object.fromEntries(fundedKeys.map((key) => [key, process.env[key]]));
    for (const key of fundedKeys) delete process.env[key];
    const writes: Array<Promise<boolean>> = [];
    const write = subscriptionUsageSink.write;
    subscriptionUsageSink.write = (name, report) => {
      const pending = write(name, report);
      writes.push(pending);
      return pending;
    };
    const started = Date.now();
    try {
      const initialAuth = await fetchChatComputeAuth(userId);
      assert(
        initialAuth.claudeToken === token || initialAuth.gptToken === token,
        'the chat path must lease the seeded subscription'
      );
      const attempt = await callWithChatComputeRotation({
        userId,
        agentId: `usage-chat-agent-${ctx.run}`,
        phase: 'chat',
        initialAuth,
        invoke: async (auth, { disableWaterfall }) => {
          if (auth.claudeToken === null && auth.gptToken === null) return 'waterfall';
          const stream = await createStreamingCompletion({
            model: 'rose-labs/rose-1-ultra',
            messages: [{ role: 'user', content: 'hi' }],
            ...(auth.claudeToken ? { claude_token: auth.claudeToken } : {}),
            ...(auth.gptToken
              ? { gpt_token: auth.gptToken, gpt_account_id: auth.gptAccountId }
              : {}),
            disable_waterfall: disableWaterfall,
          });
          let text = '';
          for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
          return text;
        },
        maxRotations: 1,
      });
      return { result: attempt.result, elapsedMs: Date.now() - started, writes };
    } finally {
      subscriptionUsageSink.write = write;
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  ctx.test(
    'a chat-path Claude completion records its account usage in the background',
    async () => {
      const token = `chat-claude-ok-${ctx.run}`;
      const { userId, accountId } = await seedChatLogin('claude', token);
      const fiveHourReset = epochSeconds(2 * 3_600_000);
      const sevenDayReset = epochSeconds(4 * DAY_MS);
      const turn = await runChatTurn(
        userId,
        token,
        () =>
          new Response(ANTHROPIC_OK_SSE, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'anthropic-ratelimit-unified-status': 'allowed',
              'anthropic-ratelimit-unified-5h-utilization': '0.42',
              'anthropic-ratelimit-unified-5h-reset': String(fiveHourReset),
              'anthropic-ratelimit-unified-7d-utilization': '0.13',
              'anthropic-ratelimit-unified-7d-reset': String(sevenDayReset),
            },
          })
      );
      assert(turn.result === 'ok', `the completion must be served: ${JSON.stringify(turn.result)}`);
      const account = await settledAccount(userId, 'claude', accountId, turn.writes);
      assert(account?.usage, `chat usage must reach the bar: ${JSON.stringify(account)}`);
      assert(account.usage.fiveHour?.usedPct === 42, JSON.stringify(account.usage));
      assert(account.usage.fiveHour.resetsAt === isoFromEpoch(fiveHourReset), '5h reset');
      assert(account.usage.sevenDay?.usedPct === 13, JSON.stringify(account.usage));
      assert(account.usage.sevenDay.resetsAt === isoFromEpoch(sevenDayReset), '7d reset');
      assert(
        account.usage.source === 'response' && account.usage.status === 'allowed',
        JSON.stringify(account.usage)
      );
      assert(account.cooldown === null && account.nextResetAt === null, JSON.stringify(account));
    }
  );

  ctx.test(
    'a chat-path Claude 429 records the spent window and its reset as the next reset',
    async () => {
      const token = `chat-claude-429-${ctx.run}`;
      const { userId, accountId } = await seedChatLogin('claude', token);
      const fiveHourReset = epochSeconds(90 * 60_000);
      const sevenDayReset = epochSeconds(3 * DAY_MS);
      const turn = await runChatTurn(
        userId,
        token,
        () =>
          new Response(
            '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'anthropic-ratelimit-unified-status': 'rejected',
                'anthropic-ratelimit-unified-representative-claim': 'seven_day',
                'anthropic-ratelimit-unified-reset': String(sevenDayReset),
                'anthropic-ratelimit-unified-5h-utilization': '0.31',
                'anthropic-ratelimit-unified-5h-reset': String(fiveHourReset),
                'anthropic-ratelimit-unified-7d-utilization': '1.0',
                'anthropic-ratelimit-unified-7d-reset': String(sevenDayReset),
              },
            }
          )
      );
      assert(
        turn.result === 'waterfall',
        `the turn must rotate off the limited login: ${turn.result}`
      );
      const account = await settledAccount(userId, 'claude', accountId, turn.writes);
      assert(account?.usage, `the 429's usage must reach the bar: ${JSON.stringify(account)}`);
      assert(account.usage.sevenDay?.usedPct === 100, JSON.stringify(account.usage));
      assert(account.usage.fiveHour?.usedPct === 31, JSON.stringify(account.usage));
      assert(
        account.usage.source === 'rate_limit' && account.usage.status === 'rejected',
        JSON.stringify(account.usage)
      );
      assert(
        account.cooldown?.authoritative === true && account.cooldown.reason === 'usage_window_7d',
        `the provider's reset is an authoritative 7d cooldown: ${JSON.stringify(account.cooldown)}`
      );
      assert(
        account.nextResetAt === isoFromEpoch(sevenDayReset),
        `the next reset is the spent window's: ${account.nextResetAt}`
      );
    }
  );

  ctx.test('a chat-path Codex usage-limit 429 records the spent window and its reset', async () => {
    const token = `chat-codex-429-${ctx.run}`;
    const { userId, accountId } = await seedChatLogin('codex', token);
    const fiveHourReset = epochSeconds(75 * 60_000);
    const turn = await runChatTurn(
      userId,
      token,
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              message: 'The usage limit has been reached',
              resets_at: fiveHourReset,
            },
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'x-codex-primary-used-percent': '100',
              'x-codex-primary-window-minutes': '300',
              'x-codex-primary-reset-at': String(fiveHourReset),
              'x-codex-secondary-used-percent': '57',
              'x-codex-secondary-window-minutes': '10080',
              'x-codex-secondary-reset-after-seconds': String(5 * 86_400),
            },
          }
        )
    );
    assert(
      turn.result === 'waterfall',
      `the turn must rotate off the limited login: ${turn.result}`
    );
    const account = await settledAccount(userId, 'codex', accountId, turn.writes);
    assert(account?.usage, `the 429's usage must reach the bar: ${JSON.stringify(account)}`);
    assert(account.usage.fiveHour?.usedPct === 100, JSON.stringify(account.usage));
    assert(account.usage.fiveHour.resetsAt === isoFromEpoch(fiveHourReset), '5h reset');
    assert(account.usage.sevenDay?.usedPct === 57, JSON.stringify(account.usage));
    assert(account.usage.status === 'rejected', JSON.stringify(account.usage));
    assert(
      account.cooldown?.authoritative === true && account.cooldown.reason === 'usage_window_5h',
      `the provider's reset is an authoritative 5h cooldown: ${JSON.stringify(account.cooldown)}`
    );
    assert(
      account.nextResetAt === isoFromEpoch(fiveHourReset),
      `next reset: ${account.nextResetAt}`
    );
  });

  ctx.test('a stalled usage write never delays a chat-path completion', async () => {
    const token = `chat-claude-stall-${ctx.run}`;
    const { userId } = await seedChatLogin('claude', token);
    let writes = 0;
    const write = subscriptionUsageSink.write;
    subscriptionUsageSink.write = () => {
      writes += 1;
      return new Promise<boolean>(() => undefined);
    };
    try {
      const turn = await runChatTurn(
        userId,
        token,
        () =>
          new Response(ANTHROPIC_OK_SSE, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'anthropic-ratelimit-unified-status': 'allowed',
              'anthropic-ratelimit-unified-5h-utilization': '0.2',
              'anthropic-ratelimit-unified-5h-reset': String(epochSeconds(3_600_000)),
            },
          })
      );
      assert(turn.result === 'ok', `the completion must be served: ${JSON.stringify(turn.result)}`);
      assert(writes === 1, `the usage write must be attempted once, got ${writes}`);
      assert(
        turn.elapsedMs < 5_000,
        `a stalled write must not hold the turn: ${turn.elapsedMs} ms`
      );
    } finally {
      subscriptionUsageSink.write = write;
    }
  });
}
