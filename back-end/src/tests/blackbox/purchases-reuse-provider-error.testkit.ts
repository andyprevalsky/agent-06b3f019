/**
 * Owning regression for agent-payment-idempotent-abandonment (run 20261107-201518-443935): the
 * second browser task's reuse-only mint (`reusePurchaseId`) returned an untyped HTTP 500 from
 * POST /api/purchases/mint. The reuse path re-reads the held card through the real AgentCard
 * organization runtime; a provider failure there escaped as a raw runtime error, which the route
 * can only report as "Failed to mint purchase card". The caller must receive the provider's typed
 * status/code, and the held purchase must stay exactly as it was.
 */
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import * as purchasesService from '../../domains/purchases/service';
import { AgentCardOrgMcpProvider } from '../../providers/card-provider';
import { AgentCardOrgRuntime } from '../../providers/agentcard/org-runtime';
import { prisma } from '../../providers/database';
import { assert } from './purchases.testkit';

const MERCHANT = 'Rose Labs Test Payment';

/** The HTTP-200 text-only org MCP throttle body AgentCard returns under shared-window load. */
const TEXT_ONLY_THROTTLE = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'get_card_details failed: API key rate limit exceeded, please try again later',
    },
  ],
};

function receipt() {
  const items: Array<[string, number]> = [
    ['Aurora Notebook', 1200],
    ['Ceramic Mug', 900],
    ['Canvas Tote', 1500],
  ];
  return {
    currency: 'USD',
    lineItems: items.map(([name, cents]) => ({
      name,
      productUrl: `https://shop.test/p/${name.toLowerCase().replace(/ /g, '-')}`,
      unitPriceCents: cents,
      quantity: 1,
      lineTotalCents: cents,
    })),
    fees: [
      { label: 'Tax', amountCents: 297 },
      { label: 'Shipping', amountCents: 499 },
    ],
    subtotalCents: 3600,
    totalCents: 4396,
  };
}

export async function testReuseMintProviderFailureIsTyped(): Promise<void> {
  const userId = `reuse-provider-error-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const savedToken = process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN;
  const usesClientCredentials =
    Boolean(process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim()) &&
    Boolean(process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET?.trim());
  if (!usesClientCredentials) process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'fixture-org-token';
  try {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'reuse-only mint provider failure' },
      select: { id: true },
    });
    const cardId = `held-card-${randomUUID()}`;
    const held = await prisma.purchaseSpend.create({
      data: {
        userId,
        agentId: agent.id,
        fingerprint: `first-request-${randomUUID()}`,
        merchant: MERCHANT,
        lineItemsJson: receipt(),
        totalCents: 4396,
        status: PurchaseSpendStatus.HELD,
        cardId,
      },
    });
    const calls: string[] = [];
    const runtime = new AgentCardOrgRuntime(async (_token, toolName) => {
      calls.push(toolName);
      return TEXT_ONLY_THROTTLE;
    });
    const provider = new AgentCardOrgMcpProvider(
      'fixture-cardholder',
      (toolName, args, deadlineAtMs) => runtime.callTool(toolName, args, deadlineAtMs),
      { attempts: 1, delayMs: 0 }
    );

    const startedAt = Date.now();
    let failure: unknown;
    try {
      await purchasesService.mintPurchaseCard(
        {
          userId,
          agentId: agent.id,
          fingerprint: held.fingerprint,
          reusePurchaseId: held.id,
          merchant: MERCHANT,
          ...receipt(),
        },
        provider
      );
    } catch (error) {
      failure = error;
    }
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `REUSE_MINT_PROVIDER_FAILURE type=${(failure as Error | undefined)?.constructor?.name} ` +
        `status=${(failure as { statusCode?: unknown } | undefined)?.statusCode} ` +
        `code=${(failure as { code?: unknown } | undefined)?.code} ` +
        `providerCalls=${calls.length} elapsedMs=${elapsedMs}`
    );
    assert(
      failure instanceof purchasesService.PurchaseError,
      `reuse-only mint provider failure must reach the route as a typed PurchaseError, got ${String(
        failure
      )}`
    );
    const typed = failure as purchasesService.PurchaseError;
    assert(
      typed.statusCode === 429 && typed.code === 'agentcard_org_mcp_rate_limited',
      `expected 429 agentcard_org_mcp_rate_limited, got ${typed.statusCode} ${typed.code}`
    );
    assert(
      calls.length === 3 && calls.every((tool) => tool === 'get_card_details'),
      `the existing bounded throttle retry must own the read, got ${calls.join(',')}`
    );
    const row = await prisma.purchaseSpend.findUniqueOrThrow({ where: { id: held.id } });
    assert(
      row.status === PurchaseSpendStatus.HELD && row.cardId === cardId,
      'an unreadable card must leave the approved purchase HELD with its card'
    );
    assert(
      (await prisma.purchaseSpend.count({ where: { userId } })) === 1,
      'reuse-only mint must never open another purchase'
    );
  } finally {
    if (savedToken === undefined) delete process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN;
    else process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = savedToken;
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}
