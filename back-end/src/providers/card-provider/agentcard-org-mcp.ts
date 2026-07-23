import { callOrgTool, type AgentCardOrgToolCaller } from '../agentcard/org-runtime';
import { createLogger } from '../logger';
import { AgentCardProviderError } from './errors';
import type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';

type McpResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  toolResult?: unknown;
};

const log = createLogger('AgentCardOrgMCP');
const TRANSFER_LOOKUP_ATTEMPTS = 20;
const TRANSFER_LOOKUP_DELAY_MS = 500;
const TRANSFER_ID_FIELD_NAMES = [
  'transfer_id',
  'transferId',
  'provider_transfer_id',
  'providerTransferId',
  'company_transfer_id',
  'companyTransferId',
  'org_transfer_id',
  'orgTransferId',
  'organization_transfer_id',
  'organizationTransferId',
  'wallet_transfer_id',
  'walletTransferId',
  'funding_transfer_id',
  'fundingTransferId',
];
const TRANSFER_CONTAINER_NAMES = [
  'transfer',
  'company_transfer',
  'companyTransfer',
  'org_transfer',
  'orgTransfer',
  'organization_transfer',
  'organizationTransfer',
  'wallet_transfer',
  'walletTransfer',
  'funding_transfer',
  'fundingTransfer',
  'provider_transfer',
  'providerTransfer',
];
const TRANSFER_LABELS = [
  'Transfer ID',
  'Provider Transfer ID',
  'Company Transfer ID',
  'Organization Transfer ID',
  'Org Transfer ID',
  'Wallet Transfer ID',
  'Funding Transfer ID',
];
const TRANSFER_ID_PATTERN =
  /\b(?:owt|tr|transfer|org_transfer|wallet_transfer|funding_transfer|provider_transfer)[_-][A-Za-z0-9_-]+\b/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultText(result: unknown): string {
  return ((result as McpResult).content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function resultRecord(result: unknown): Record<string, unknown> {
  const envelope = result as McpResult;
  const direct = asRecord(envelope.toolResult) ?? asRecord(envelope.structuredContent);
  if (direct !== undefined) return direct;
  const text = resultText(result);
  if (text !== '') {
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed !== undefined) return parsed;
    } catch {
      return { message: text };
    }
  }
  throw new AgentCardProviderError('AgentCard Organization MCP returned no structured result');
}

function field(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function optionalString(record: Record<string, unknown>, names: string[]): string | undefined {
  const value = field(record, names);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, names: string[]): number | undefined {
  const value = field(record, names);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalTransferId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function transferIdFromText(text: string): string | undefined {
  for (const label of TRANSFER_LABELS) {
    const value = labeledValue(text, label);
    if (value !== undefined) return value.replace(/[.,;:]$/g, '');
  }
  return text.match(TRANSFER_ID_PATTERN)?.[0];
}

function transferIdFromContainer(
  value: unknown,
  depth = 0,
  allowBareId = false
): string | undefined {
  if (depth > 5) return undefined;
  const direct = optionalTransferId(value);
  if (direct !== undefined) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = transferIdFromContainer(item, depth + 1, allowBareId);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const explicit =
    optionalString(record, TRANSFER_ID_FIELD_NAMES) ??
    (allowBareId ? optionalString(record, ['id']) : undefined);
  if (explicit !== undefined) return explicit;
  for (const containerName of TRANSFER_CONTAINER_NAMES) {
    const nested = transferIdFromContainer(record[containerName], depth + 1, true);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function companyTransferId(record: Record<string, unknown>, text = ''): string | undefined {
  const direct = optionalString(record, TRANSFER_ID_FIELD_NAMES);
  if (direct !== undefined) return direct;
  for (const containerName of TRANSFER_CONTAINER_NAMES) {
    const nested = transferIdFromContainer(record[containerName], 0, true);
    if (nested !== undefined) return nested;
  }
  for (const [key, value] of Object.entries(record)) {
    if (/transfer|funding/i.test(key)) {
      const nested = transferIdFromContainer(value, 0, /transfer/i.test(key));
      if (nested !== undefined) return nested;
    }
    const nestedRecord = asRecord(value);
    if (nestedRecord !== undefined) {
      const nested = companyTransferId(nestedRecord);
      if (nested !== undefined) return nested;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const itemRecord = asRecord(item);
        if (itemRecord !== undefined) {
          const nested = companyTransferId(itemRecord);
          if (nested !== undefined) return nested;
        }
      }
    }
  }
  return text === '' ? undefined : transferIdFromText(text);
}

function recordShape(value: unknown, depth = 0): unknown {
  if (depth > 3) return 'object';
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, sample: recordShape(value[0], depth + 1) };
  }
  const record = asRecord(value);
  if (record === undefined) return typeof value;
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [key, recordShape(nested, depth + 1)])
  );
}

function recordArray(record: Record<string, unknown>, names: string[]): Record<string, unknown>[] {
  const value = field(record, names);
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentCardProviderError(`AgentCard Organization MCP response missing ${name}`);
  }
  return value;
}

function labeledValue(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*${label}\\s*:\\s*([^\\n]+)`, 'im'));
  return match?.[1]?.trim() || undefined;
}

function dollarsToCents(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[$,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
}

function findUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findUrl(item);
      if (url !== undefined) return url;
    }
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const url = findUrl(item);
      if (url !== undefined) return url;
    }
  }
  return undefined;
}

function errorCode(record: Record<string, unknown>, text: string): string | undefined {
  const explicitCode = optionalString(record, ['code', 'error'])?.toLowerCase();
  const message = optionalString(record, ['message']);
  const normalized = [explicitCode, message, text].filter(Boolean).join('\n').toLowerCase();
  const knownCode = [
    'funding_in_progress',
    'kyc_required',
    'org_onboarding_required',
    'org_wallet_funding_required',
    'wallet_funding_required',
    'payment_method_required',
  ].find((code) => normalized.includes(code));
  if (knownCode !== undefined) return knownCode;
  if (explicitCode !== undefined) return explicitCode;
  return optionalString(record, ['status'])?.toLowerCase();
}

function throwForGate(record: Record<string, unknown>, result: unknown): void {
  const text = resultText(result);
  const code = errorCode(record, text);
  if (code === 'funding_in_progress') {
    const transferId = companyTransferId(record, text);
    if (transferId === undefined) {
      log.warn('AgentCard funding_in_progress response omitted a recognized transfer id', {
        top_level_keys: Object.keys(record),
        result_shape: recordShape(record),
      });
      throw new AgentCardProviderError(
        'AgentCard company funding is in progress without a transfer id'
      );
    }
    throw new AgentCardProviderError(
      'AgentCard company funding is in progress',
      409,
      undefined,
      'agentcard_company_funding_in_progress',
      {
        agentcardStatus: code,
        transferId,
        retryAfterSeconds: optionalNumber(record, ['retry_after_seconds', 'retryAfterSeconds']),
        agentcardResult: record,
      }
    );
  }
  if (
    code === 'kyc_required' ||
    code === 'org_wallet_funding_required' ||
    code === 'wallet_funding_required' ||
    code === 'payment_method_required'
  ) {
    throw new AgentCardProviderError(
      `AgentCard organization setup required: ${code}`,
      409,
      undefined,
      `agentcard_${code}`,
      { agentcardStatus: code, agentcardResult: record }
    );
  }
  if (code === 'org_onboarding_required') {
    throw new AgentCardProviderError(
      optionalString(record, ['message', 'error']) ??
        (text || 'AgentCard organization onboarding is required'),
      409,
      undefined,
      'agentcard_setup_required',
      {
        agentcardStatus: code,
        setupAction: 'complete_agentcard_cardholder_onboarding',
        agentcardResult: record,
      }
    );
  }
  const status = optionalString(record, ['status'])?.toLowerCase();
  const hasExplicitError = (result as McpResult).isError === true || status === 'error';
  if (hasExplicitError) {
    throw new AgentCardProviderError(
      optionalString(record, ['message', 'error']) ?? (text || 'AgentCard Organization MCP failed')
    );
  }
}

export class AgentCardOrgMcpProvider implements CardProvider {
  constructor(
    private readonly cardholderId: string,
    private readonly toolCaller: AgentCardOrgToolCaller = callOrgTool
  ) {
    if (cardholderId.trim() === '') {
      throw new AgentCardProviderError('AgentCard organization cardholder id is required');
    }
  }

  async mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
      throw new AgentCardProviderError('amountCents must be a positive integer');
    }
    const fundsSource = request.fundsSource ?? 'company_flow';
    if (fundsSource === 'company_flow' && !request.idempotencyKey) {
      throw new AgentCardProviderError('idempotencyKey is required for AgentCard company_flow');
    }
    const args = {
      cardholder_id: this.cardholderId,
      amount_cents: request.amountCents,
      funds_source: fundsSource,
      ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
    };
    log.info('Creating card through AgentCard Organization MCP', {
      cardholder_id: maskId(this.cardholderId),
      amount_cents: request.amountCents,
      funds_source: args.funds_source,
      idempotency_key: request.idempotencyKey,
    });
    let result = await this.toolCaller('create_card', args);
    let record = resultRecord(result);
    if (errorCode(record, resultText(result)) === 'kyc_required') {
      const setupResult = await this.toolCaller('start_cardholder_kyc', {
        cardholder_id: this.cardholderId,
      });
      const setupRecord = resultRecord(setupResult);
      const setupStatus = optionalString(setupRecord, ['status', 'kyc_status', 'kycStatus']);
      if (setupStatus === 'verified' || setupStatus === 'approved') {
        result = await this.toolCaller('create_card', args);
        record = resultRecord(result);
      } else {
        const setupUrl = findUrl(setupRecord);
        throw new AgentCardProviderError(
          'AgentCard cardholder identity verification is required',
          409,
          undefined,
          'agentcard_setup_required',
          {
            agentcardStatus: 'kyc_required',
            setupAction: 'complete_agentcard_kyc',
            setupTool: 'start_cardholder_kyc',
            setupStatus,
            ...(setupUrl !== undefined ? { setupUrl } : {}),
          }
        );
      }
    }
    throwForGate(record, result);
    const cardId = requiredString(field(record, ['card_id', 'cardId', 'id']), 'card_id');
    const details = await this.getDetails(cardId);
    let transferId = companyTransferId(record, resultText(result));
    if (fundsSource === 'company_flow' && transferId === undefined) {
      transferId = await this.findCompanyTransferId(cardId);
      if (transferId === undefined) {
        await this.closeCard(cardId);
        throw new AgentCardProviderError(
          'AgentCard company-flow card was issued without an observable organization transfer'
        );
      }
    }
    return {
      cardId,
      last4: optionalString(record, ['last4', 'last_four', 'lastFour']) ?? details.pan.slice(-4),
      expiry: optionalString(record, ['expiry', 'expiration', 'expires']) ?? details.expiry,
      spendLimitCents:
        optionalNumber(record, ['amount_cents', 'amountCents', 'balance_cents', 'balanceCents']) ??
        request.amountCents,
      status: optionalString(record, ['cardStatus', 'status']) ?? details.status,
      ...(transferId !== undefined ? { providerTransferId: transferId, metadata: record } : {}),
    };
  }

  private async findCompanyTransferId(cardId: string): Promise<string | undefined> {
    for (let attempt = 1; attempt <= TRANSFER_LOOKUP_ATTEMPTS; attempt += 1) {
      let observedTransferCount = 0;
      for (const args of [{ status: 'consumed', limit: 100 }, { limit: 100 }]) {
        const result = await this.toolCaller('list_transfers', args);
        const record = resultRecord(result);
        throwForGate(record, result);
        const transfers = recordArray(record, ['transfers']);
        observedTransferCount = Math.max(observedTransferCount, transfers.length);
        const transfer = transfers.find(
          (candidate) => optionalString(candidate, ['card_id', 'cardId']) === cardId
        );
        const transferId =
          transfer === undefined ? undefined : transferIdFromContainer(transfer, 0, true);
        if (transferId !== undefined) {
          if (attempt > 1) {
            log.info('Observed delayed AgentCard organization transfer', {
              card_id: maskId(cardId),
              transfer_id: maskId(transferId),
              attempt,
            });
          }
          return transferId;
        }
      }
      if (attempt < TRANSFER_LOOKUP_ATTEMPTS) {
        if (attempt === 1) {
          log.info('Waiting for AgentCard organization transfer visibility', {
            card_id: maskId(cardId),
            observed_transfer_count: observedTransferCount,
          });
        }
        await delay(TRANSFER_LOOKUP_DELAY_MS);
      }
    }
    return undefined;
  }

  async getDetails(cardId: string): Promise<CardProviderDetailsResult> {
    if (cardId.trim() === '') throw new AgentCardProviderError('cardId is required');
    const result = await this.toolCaller('get_card_details', { card_id: cardId });
    const record = resultRecord(result);
    throwForGate(record, result);
    const text = resultText(result) || optionalString(record, ['message']) || '';
    const pan =
      optionalString(record, ['pan', 'card_number', 'cardNumber', 'number']) ??
      labeledValue(text, 'PAN')?.replace(/\s+/g, '');
    const cvv =
      optionalString(record, ['cvv', 'cvc', 'security_code']) ?? labeledValue(text, 'CVV');
    const expiry =
      optionalString(record, ['expiry', 'expiration', 'expires']) ?? labeledValue(text, 'Expiry');
    const balanceCents =
      optionalNumber(record, ['balance_cents', 'balanceCents']) ??
      dollarsToCents(labeledValue(text, 'Balance'));
    const status = optionalString(record, ['cardStatus', 'status']) ?? labeledValue(text, 'Status');
    if (balanceCents === undefined) {
      throw new AgentCardProviderError('AgentCard Organization MCP response missing balance_cents');
    }
    return {
      pan: requiredString(pan, 'pan'),
      cvv: requiredString(cvv, 'cvv'),
      expiry: requiredString(expiry, 'expiry'),
      balanceCents,
      status: requiredString(status, 'status'),
    };
  }

  async closeCard(cardId: string): Promise<void> {
    if (cardId.trim() === '') throw new AgentCardProviderError('cardId is required');
    const result = await this.toolCaller('close_card', { card_id: cardId });
    const record = resultRecord(result);
    throwForGate(record, result);
    log.info('Closed card through AgentCard Organization MCP', {
      card_id: maskId(cardId),
      status: optionalString(record, ['cardStatus', 'status']),
    });
  }
}
