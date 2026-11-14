import { agentCardV2Request, AgentCardV2Error, type AgentCardV2Request } from '../agentcard/api-v2';
import { AgentCardProviderError } from './errors';
import type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new AgentCardProviderError(`AgentCard v2 response missing ${name}`);
  return value;
}
function cents(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AgentCardProviderError(`AgentCard v2 response missing ${name}`);
  return value;
}

/** Company-funded server-side issuing. No MCP sessions or credential-text parsing. */
export class AgentCardV2Provider implements CardProvider {
  constructor(
    private readonly providerUserId?: string,
    private readonly request: AgentCardV2Request = agentCardV2Request
  ) {
    if (providerUserId !== undefined && !providerUserId.trim())
      throw new AgentCardProviderError('AgentCard connected user id is required');
  }
  private async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    key?: string,
    deadline?: number
  ) {
    try {
      return await this.request(method, path, body, key, deadline);
    } catch (error) {
      if (!(error instanceof AgentCardV2Error)) throw error;
      if (error.code === 'deposit_confirming' || error.code === 'funding_in_progress') {
        throw new AgentCardProviderError(
          'AgentCard company funding is in progress',
          409,
          undefined,
          'agentcard_company_funding_in_progress',
          {
            agentcardStatus: error.code,
            ...(typeof error.details.transfer_id === 'string'
              ? { transferId: error.details.transfer_id }
              : {}),
            ...(typeof error.details.retry_after_seconds === 'number'
              ? { retryAfterSeconds: error.details.retry_after_seconds }
              : {}),
          }
        );
      }
      if (error.code === 'kyc_required' && this.providerUserId !== undefined) {
        const kyc = await this.request(
          'GET',
          `/api/v2/kyc?user_id=${encodeURIComponent(this.providerUserId)}`
        );
        throw new AgentCardProviderError(
          'AgentCard identity verification is required',
          409,
          undefined,
          'agentcard_setup_required',
          {
            agentcardStatus: error.code,
            setupAction: 'complete_agentcard_kyc',
            ...(typeof kyc.iframe_url === 'string' ? { setupUrl: kyc.iframe_url } : {}),
          }
        );
      }
      throw new AgentCardProviderError(
        error.message,
        error.status,
        undefined,
        error.code.startsWith('agentcard_') ? error.code : `agentcard_${error.code}`,
        error.details
      );
    }
  }
  async mintCard(input: CardProviderMintRequest): Promise<CardProviderMintResult> {
    if (!this.providerUserId)
      throw new AgentCardProviderError(
        'AgentCard connected user id is required',
        409,
        undefined,
        'agentcard_setup_required'
      );
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 100)
      throw new AgentCardProviderError(
        'AgentCard card amount must be at least 100 cents',
        400,
        undefined,
        'agentcard_invalid_request'
      );
    if (!input.idempotencyKey?.trim())
      throw new AgentCardProviderError(
        'AgentCard card idempotency key is required',
        400,
        undefined,
        'agentcard_invalid_request'
      );
    if (typeof input.expectedLivemode !== 'boolean')
      throw new AgentCardProviderError(
        'AgentCard purchase billing mode is required',
        400,
        undefined,
        'agentcard_invalid_request'
      );
    if (input.fundsSource !== undefined && input.fundsSource !== 'company_flow')
      throw new AgentCardProviderError(
        'Rose purchases require company-funded AgentCard cards',
        400,
        undefined,
        'agentcard_invalid_request'
      );
    const deadline = Date.now() + 30_000;
    const wallet = await this.call('GET', '/api/v2/company_wallet', undefined, undefined, deadline);
    if (wallet.livemode !== input.expectedLivemode)
      throw new AgentCardProviderError(
        'AgentCard organization mode does not match purchase billing mode',
        409,
        undefined,
        'agentcard_setup_required',
        { setupAction: 'configure_agentcard_billing_mode' }
      );
    // Funding is an ORGANIZATION setting in v2; funds_source per card is rejected. Sandbox
    // user-funded creates ignore idempotency, so verify company funding before a keyed intent.
    if (wallet.default_funds_source !== 'company_flow')
      throw new AgentCardProviderError(
        'AgentCard company funding must be enabled in the organization dashboard',
        409,
        undefined,
        'agentcard_setup_required',
        { setupAction: 'configure_agentcard_company_funding' }
      );
    const card = await this.call(
      'POST',
      '/api/v2/cards',
      {
        user_id: this.providerUserId,
        amount_cents: input.amountCents,
        type: 'single_use',
      },
      input.idempotencyKey,
      deadline
    );
    if (card.status === 'funding_in_progress')
      throw new AgentCardProviderError(
        'AgentCard company funding is in progress',
        409,
        undefined,
        'agentcard_company_funding_in_progress',
        {
          agentcardStatus: 'funding_in_progress',
          ...(typeof card.transfer_id === 'string' ? { transferId: card.transfer_id } : {}),
          ...(typeof card.retry_after_seconds === 'number'
            ? { retryAfterSeconds: card.retry_after_seconds }
            : {}),
          agentcardResult: card,
        }
      );
    const cardId = text(card.id, 'card id');
    if (typeof card.transfer_id !== 'string' || !card.transfer_id.trim())
      throw new AgentCardProviderError(
        'AgentCard company funding transfer is not visible yet',
        409,
        undefined,
        'agentcard_company_funding_in_progress',
        { cardId, retryAfterSeconds: 5 }
      );
    // Cached create responses may describe a now-closed card on an exact-key replay.
    const base = {
      cardId,
      last4: text(card.last4, 'last4'),
      spendLimitCents: cents(card.spend_limit_cents, 'spend limit'),
      providerTransferId: card.transfer_id,
      metadata: {
        apiVersion: 2,
        card_id: cardId,
        transfer_id: card.transfer_id,
        user_id: this.providerUserId,
      },
    };
    let details: CardProviderDetailsResult;
    try {
      details = await this.details(cardId, deadline);
    } catch (error) {
      if (!(error instanceof AgentCardProviderError) || error.code !== 'card_closed') throw error;
      // Persist the exact card + transfer before the purchase layer compensates this replay.
      // Throwing before returning those ids would strand it in a funding-pending retry loop.
      return { ...base, status: 'CLOSED', balanceCents: 0, expiry: text(card.expiry, 'expiry') };
    }
    return {
      ...base,
      ...details,
    };
  }
  private async details(cardId: string, deadline?: number): Promise<CardProviderDetailsResult> {
    const path = `/api/v2/cards/${encodeURIComponent(text(cardId, 'card id'))}`;
    const card = await this.call('GET', path, undefined, undefined, deadline);
    if (card.id !== cardId)
      throw new AgentCardProviderError('AgentCard returned a different card identity');
    if (card.status === 'closed')
      throw new AgentCardProviderError('AgentCard card is closed', 409, undefined, 'card_closed', {
        closedReason: card.closed_reason,
      });
    const credentials = await this.call(
      'GET',
      `${path}/credentials`,
      undefined,
      undefined,
      deadline
    );
    if (credentials.id !== cardId)
      throw new AgentCardProviderError('AgentCard returned a different credential identity');
    return {
      pan: text(credentials.number, 'card number'),
      cvv: text(credentials.cvc, 'CVC'),
      expiry: `${text(credentials.exp_month, 'expiry month').padStart(2, '0')}/${text(credentials.exp_year, 'expiry year').slice(-2)}`,
      balanceCents: cents(card.balance_cents, 'card balance'),
      status: text(card.status, 'card status').toUpperCase(),
    };
  }
  getDetails(cardId: string): Promise<CardProviderDetailsResult> {
    return this.details(cardId);
  }
  async closeCard(cardId: string): Promise<void> {
    await this.call('POST', `/api/v2/cards/${encodeURIComponent(text(cardId, 'card id'))}/close`);
  }
}
