import { createLogger } from '../logger';
import type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';

const log = createLogger('AgentCard');

export interface AgentCardProviderConfig {
  apiKey: string;
  cardholderId: string;
  baseUrl: string;
}

interface AgentCardCreateCardResponse {
  id: unknown;
  last4: unknown;
  expiry: unknown;
  spendLimitCents?: unknown;
  amountCents?: unknown;
  status: unknown;
}

interface AgentCardDetailsResponse {
  pan: unknown;
  cvv: unknown;
  expiry: unknown;
  balanceCents?: unknown;
  status: unknown;
}

export class AgentCardProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
  }
}

function requiredConfigValue(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new AgentCardProviderError(`Missing ${name} environment variable`);
  }
  return value.trim();
}

function defaultConfig(): AgentCardProviderConfig {
  return {
    apiKey: requiredConfigValue('AGENTCARD_API_KEY', process.env.AGENTCARD_API_KEY),
    cardholderId: requiredConfigValue(
      'AGENTCARD_CARDHOLDER_ID',
      process.env.AGENTCARD_CARDHOLDER_ID
    ),
    baseUrl: (process.env.AGENTCARD_BASE_URL ?? 'https://api.agentcard.sh').replace(/\/+$/, ''),
  };
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentCardProviderError(`AgentCard response missing ${field}`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentCardProviderError(`AgentCard response missing ${field}`);
  }
  return value;
}

function maskId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export class AgentCardProvider implements CardProvider {
  private readonly config: AgentCardProviderConfig;

  constructor(config: AgentCardProviderConfig = defaultConfig()) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
    };
  }

  async mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
      throw new AgentCardProviderError('amountCents must be a positive integer');
    }

    log.info('Creating AgentCard card', {
      amount_cents: request.amountCents,
      cardholder_id: maskId(this.config.cardholderId),
      idempotency_key: request.idempotencyKey,
    });

    const data = await this.request<AgentCardCreateCardResponse>('/api/v1/cards', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.idempotencyKey !== undefined
          ? { 'Idempotency-Key': request.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        amountCents: request.amountCents,
        cardholderId: this.config.cardholderId,
      }),
    });

    const cardId = assertString(data.id, 'id');
    const last4 = assertString(data.last4, 'last4');
    const expiry = assertString(data.expiry, 'expiry');
    const status = assertString(data.status, 'status');
    const spendLimitCents = assertNumber(
      data.spendLimitCents ?? data.amountCents,
      'spendLimitCents'
    );

    log.info('Created AgentCard card', {
      card_id: maskId(cardId),
      last4,
      expiry,
      spend_limit_cents: spendLimitCents,
      status,
    });

    return { cardId, last4, expiry, spendLimitCents, status };
  }

  async getDetails(cardId: string): Promise<CardProviderDetailsResult> {
    if (cardId.trim() === '') {
      throw new AgentCardProviderError('cardId is required');
    }

    log.info('Fetching AgentCard details', { card_id: maskId(cardId) });

    const data = await this.request<AgentCardDetailsResponse>(
      `/api/v1/cards/${encodeURIComponent(cardId)}/details`
    );

    return {
      pan: assertString(data.pan, 'pan'),
      cvv: assertString(data.cvv, 'cvv'),
      expiry: assertString(data.expiry, 'expiry'),
      balanceCents: assertNumber(data.balanceCents, 'balanceCents'),
      status: assertString(data.status, 'status'),
    };
  }

  async closeCard(cardId: string): Promise<void> {
    if (cardId.trim() === '') {
      throw new AgentCardProviderError('cardId is required');
    }

    log.info('Closing AgentCard card', { card_id: maskId(cardId) });
    await this.request(`/api/v1/cards/${encodeURIComponent(cardId)}`, { method: 'DELETE' });
    log.info('Closed AgentCard card', { card_id: maskId(cardId) });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      const safeBody = body.slice(0, 500);
      log.warn('AgentCard API request failed', {
        path,
        status: response.status,
        body: safeBody,
      });
      throw new AgentCardProviderError(
        `AgentCard request failed with ${response.status}`,
        response.status,
        safeBody
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}
