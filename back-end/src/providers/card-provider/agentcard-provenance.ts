import { getOrgManagedCardholderId, getV2ConnectedUserId } from '../agentcard/store';
import { prisma } from '../database';
import type { CardProviderMintRequest } from './types';

export type AgentCardRail = 'v2' | 'legacy' | 'unknown';

function metadataRail(value: unknown): AgentCardRail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const metadata = value as Record<string, unknown>;
  if (
    (metadata.apiVersion !== undefined && metadata.apiVersion !== 1 && metadata.apiVersion !== 2) ||
    (metadata.api_version !== undefined &&
      metadata.api_version !== 'v1' &&
      metadata.api_version !== 'v2') ||
    (metadata.cardProviderRail !== undefined &&
      metadata.cardProviderRail !== 'legacy' &&
      metadata.cardProviderRail !== 'v2')
  )
    return 'unknown';
  const v2 =
    metadata.apiVersion === 2 ||
    metadata.api_version === 'v2' ||
    metadata.cardProviderRail === 'v2';
  const legacy =
    metadata.apiVersion === 1 ||
    metadata.api_version === 'v1' ||
    metadata.cardProviderRail === 'legacy' ||
    metadata.funding_model === 'company_flow' ||
    (typeof metadata.cardholder_id === 'string' && metadata.cardholder_id.trim() !== '');
  return v2 === legacy ? 'unknown' : v2 ? 'v2' : 'legacy';
}

async function ownerMatches(userId: string, value: unknown, rail: AgentCardRail): Promise<boolean> {
  const metadata = value as Record<string, unknown> | null;
  if (rail === 'v2' && metadata?.user_id !== undefined)
    return (
      typeof metadata.user_id === 'string' &&
      metadata.user_id.trim() !== '' &&
      metadata.user_id === (await getV2ConnectedUserId(userId))
    );
  if (rail === 'legacy') {
    const cardholderId = await getOrgManagedCardholderId(userId);
    if (!cardholderId?.trim()) return false;
    if (metadata?.cardholder_id !== undefined)
      return typeof metadata.cardholder_id === 'string' && metadata.cardholder_id === cardholderId;
  }
  return true;
}

export async function resolveAgentCardMintRail(
  userId: string,
  request: CardProviderMintRequest
): Promise<AgentCardRail> {
  const key = request.idempotencyKey;
  if (!key?.startsWith('purchase:') || key.length === 'purchase:'.length) return 'unknown';
  const purchaseId = key.slice('purchase:'.length);
  const purchase = await prisma.purchaseSpend.findUnique({
    where: { id: purchaseId },
    include: { walletFunding: true },
  });
  const funding = purchase?.walletFunding;
  if (
    !purchase ||
    purchase.userId !== userId ||
    purchase.totalCents !== request.amountCents ||
    purchase.stripeLivemode !== request.expectedLivemode ||
    !funding ||
    funding.purchaseId !== purchaseId ||
    funding.userId !== userId ||
    funding.amountCents !== request.amountCents ||
    funding.currency.toLowerCase() !== 'usd'
  )
    return 'unknown';
  const rail = metadataRail(funding.metadata);
  return (await ownerMatches(userId, funding.metadata, rail)) ? rail : 'unknown';
}

export async function resolveAgentCardCardRail(
  userId: string,
  cardId: string
): Promise<AgentCardRail> {
  const purchase = await prisma.purchaseSpend.findFirst({
    where: { userId, cardId },
    include: { walletFunding: true },
  });
  if (purchase && (purchase.userId !== userId || purchase.cardId !== cardId)) return 'unknown';
  const funding = purchase?.walletFunding;
  if (purchase && funding) {
    if (
      funding.purchaseId !== purchase.id ||
      funding.userId !== userId ||
      funding.amountCents !== purchase.totalCents ||
      funding.currency.toLowerCase() !== 'usd'
    )
      return 'unknown';
    const metadata = funding.metadata as Record<string, unknown> | null;
    if (metadata?.card_id !== undefined && metadata.card_id !== cardId) return 'unknown';
    const rail = metadataRail(funding.metadata);
    if (rail !== 'unknown')
      return (await ownerMatches(userId, funding.metadata, rail)) ? rail : 'unknown';
    if (funding.metadata && Object.keys(funding.metadata).length > 0) return 'unknown';
  }
  // Legacy-only installations can still read/close exact owned MCP cards. Known v2 evidence above never falls back.
  return !process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID?.trim() &&
    process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN?.trim()
    ? 'legacy'
    : 'unknown';
}
