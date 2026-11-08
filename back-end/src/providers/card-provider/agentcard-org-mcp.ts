import { orgPollWaitsMs } from '../agentcard/org-poll-schedule';
import {
  callOrgTool,
  orgRetryDeadlineAtMs,
  type AgentCardOrgToolCaller,
} from '../agentcard/org-runtime';
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
const CREATE_CARD_TIMEOUT_MAX_ATTEMPTS = 2;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCardholderNotFoundMessage(message: string): boolean {
  return /\bcardholder not found\b/i.test(message);
}

function isCardCreationFailedMessage(message: string): boolean {
  return /\bcard_creation_failed\b/i.test(message);
}

function throwIfCardholderNotFound(message: string): void {
  if (!isCardholderNotFoundMessage(message)) return;
  // Deterministic pre-commit rejection: keep the typed safe code so
  // classifyFundingResumeFailure does not rewrite providerCallStarted + untyped
  // errors as ambiguous funding and loop forever on "Cardholder not found".
  throw new AgentCardProviderError(message, 409, undefined, 'agentcard_cardholder_not_found', {
    agentcardStatus: 'cardholder_not_found',
  });
}

function throwIfCardCreationFailed(message: string): void {
  if (!isCardCreationFailedMessage(message)) return;
  // AgentCard stores this under the create_card idempotency key: every replay of
  // the same purchase:{id} key returns the same terminal failure. Keep a typed
  // safe code so classifyFundingResumeFailure fail-closes instead of rewriting
  // into a silent funding-in-progress retry loop.
  throw new AgentCardProviderError(message, 409, undefined, 'agentcard_card_creation_failed', {
    agentcardStatus: 'card_creation_failed',
  });
}

function providerErrorFromUnknown(error: unknown): AgentCardProviderError {
  if (error instanceof AgentCardProviderError) return error;
  const message = errorMessage(error);
  throwIfCardholderNotFound(message);
  throwIfCardCreationFailed(message);
  return new AgentCardProviderError(message);
}

function isTimeoutError(error: unknown): boolean {
  const message = errorMessage(error);
  const name = error instanceof Error ? error.name : '';
  return /\b(?:request timed out|timed out|timeout|etimedout)\b/i.test(`${name} ${message}`);
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

const EXPLICIT_GATE_CODES = new Set([
  'funding_in_progress',
  'kyc_required',
  'org_onboarding_required',
  'org_wallet_funding_required',
  'org_funding_required',
  'insufficient_balance',
  'deposit_confirming',
  'wallet_funding_required',
  'payment_method_required',
]);

function normalizedExplicitCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^agentcard_/, '');
  return EXPLICIT_GATE_CODES.has(normalized) ? normalized : value.trim().toLowerCase();
}

/**
 * Provider gates that are safe to compensate immediately must come from a structured code/status
 * field. Never promote free-form error prose into a safe KYC/setup outcome: a 500 response can
 * mention KYC after create_card already committed.
 *
 * A text-only funding_in_progress signal is deliberately the sole exception. Treating that signal
 * as ambiguous and retryable preserves the Stripe hold and exact AgentCard idempotency key, so a
 * false positive cannot discard an externally-created card or transfer.
 */
function errorCode(record: Record<string, unknown>, text: string): string | undefined {
  const explicitCode = optionalString(record, ['code', 'error', 'status']);
  if (explicitCode !== undefined) return normalizedExplicitCode(explicitCode);
  return /\bfunding_in_progress\b/i.test(text) ? 'funding_in_progress' : undefined;
}

function throwForGate(
  record: Record<string, unknown>,
  result: unknown,
  companyFlowMint = false
): void {
  const text = resultText(result);
  const code = errorCode(record, text);
  if (code === 'funding_in_progress' || (companyFlowMint && code === 'deposit_confirming')) {
    const transferId = companyTransferId(record, text);
    const retryAfterSeconds = optionalNumber(record, ['retry_after_seconds', 'retryAfterSeconds']);
    if (transferId === undefined) {
      log.warn('AgentCard funding_in_progress response omitted a recognized transfer id', {
        top_level_keys: Object.keys(record),
        result_shape: recordShape(record),
      });
    }
    throw new AgentCardProviderError(
      'AgentCard company funding is in progress',
      409,
      undefined,
      'agentcard_company_funding_in_progress',
      {
        agentcardStatus: code,
        ...(transferId !== undefined ? { transferId } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        agentcardResult: record,
      }
    );
  }
  if (
    code === 'kyc_required' ||
    code === 'org_funding_required' ||
    code === 'insufficient_balance' ||
    code === 'deposit_confirming' ||
    code === 'org_wallet_funding_required' ||
    code === 'wallet_funding_required' ||
    code === 'payment_method_required'
  ) {
    throw new AgentCardProviderError(
      `AgentCard organization setup required: ${code}`,
      409,
      undefined,
      code === 'org_funding_required' || code === 'insufficient_balance'
        ? 'agentcard_org_wallet_funding_required'
        : `agentcard_${code}`,
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
    const failureMessage =
      optionalString(record, ['message', 'error']) ?? (text || 'AgentCard Organization MCP failed');
    throwIfCardholderNotFound(failureMessage);
    throwIfCardCreationFailed(failureMessage);
    throw new AgentCardProviderError(failureMessage);
  }
}

export class AgentCardOrgMcpProvider implements CardProvider {
  constructor(
    private readonly cardholderId: string,
    private readonly toolCaller: AgentCardOrgToolCaller = callOrgTool,
    private readonly transferLookup: {
      attempts: number;
      delayMs: number;
    } = {
      attempts: TRANSFER_LOOKUP_ATTEMPTS,
      delayMs: TRANSFER_LOOKUP_DELAY_MS,
    }
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
    let result = await this.createCard(args, request);
    let record = resultRecord(result);
    if (errorCode(record, resultText(result)) === 'kyc_required') {
      const setupResult = await this.toolCaller('start_cardholder_kyc', {
        cardholder_id: this.cardholderId,
      });
      const setupRecord = resultRecord(setupResult);
      const setupStatus = optionalString(setupRecord, ['status', 'kyc_status', 'kycStatus']);
      if (setupStatus === 'verified' || setupStatus === 'approved') {
        result = await this.createCard(args, request);
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
    throwForGate(record, result, fundsSource === 'company_flow');
    const cardId = requiredString(field(record, ['card_id', 'cardId', 'id']), 'card_id');
    // ONE retry deadline for every read after create_card, so the details read, its status
    // fallback and the transfer-visibility poll cannot each arm a fresh rate-limit/auth-flap budget
    // and push a created card's mint past the caller's HTTP timeout.
    const postCreateDeadlineAtMs = orgRetryDeadlineAtMs();
    const details = await this.getDetails(cardId, postCreateDeadlineAtMs);
    let transferId = companyTransferId(record, resultText(result));
    if (fundsSource === 'company_flow' && transferId === undefined) {
      transferId = await this.findCompanyTransferId(cardId, postCreateDeadlineAtMs);
      if (transferId === undefined) {
        throw new AgentCardProviderError(
          'AgentCard company funding is in progress',
          409,
          undefined,
          'agentcard_company_funding_in_progress',
          {
            agentcardStatus: 'funding_in_progress',
            cardId,
            retryAfterSeconds: 5,
            agentcardResult: record,
          }
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
      // get_card_details is the current source of truth on an idempotency replay. create_card may
      // still say "created" even if a prior attempt closed the returned card.
      status: details.status,
      // Thread secrets so mintCaptureAndIssue does not re-call get_card_details (a second call has
      // hung the HTTP mint for 15+ minutes while CHARGING blocked same-fingerprint retries).
      pan: details.pan,
      cvv: details.cvv,
      balanceCents: details.balanceCents,
      ...(transferId !== undefined ? { providerTransferId: transferId, metadata: record } : {}),
    };
  }

  private async createCard(
    args: Record<string, unknown>,
    request: CardProviderMintRequest
  ): Promise<unknown> {
    const maxAttempts = request.idempotencyKey === undefined ? 1 : CREATE_CARD_TIMEOUT_MAX_ATTEMPTS;
    // One shared rate-limit retry budget across the timeout retries, so two attempts cannot each
    // arm their own and double the delay this mint can absorb.
    const retryDeadlineAtMs = orgRetryDeadlineAtMs();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.toolCaller('create_card', args, retryDeadlineAtMs);
      } catch (error) {
        const canRetry = isTimeoutError(error) && attempt < maxAttempts;
        if (!canRetry) {
          if (isTimeoutError(error)) {
            throw new AgentCardProviderError(
              `create_card failed: ${errorMessage(error)}`,
              502,
              undefined,
              'agentcard_org_mcp_timeout',
              { attempts: attempt }
            );
          }
          throw providerErrorFromUnknown(error);
        }
        log.warn('AgentCard Organization MCP create_card timed out; retrying', {
          cardholder_id: maskId(this.cardholderId),
          amount_cents: request.amountCents,
          funds_source: request.fundsSource ?? 'company_flow',
          attempt,
          max_attempts: maxAttempts,
          error: errorMessage(error),
        });
      }
    }
    throw new AgentCardProviderError(
      'create_card failed: AgentCard Organization MCP timed out',
      502,
      undefined,
      'agentcard_org_mcp_timeout',
      { attempts: maxAttempts }
    );
  }

  private async findCompanyTransferId(
    cardId: string,
    retryDeadlineAtMs: number
  ): Promise<string | undefined> {
    // Each attempt costs TWO organization-MCP reads, so the old fixed 500ms cadence spent 40
    // requests of the org-wide 120-per-minute window on a single mint. Exponential backoff waits
    // for exactly as long overall while issuing 12.
    const waits = orgPollWaitsMs(this.transferLookup.attempts, this.transferLookup.delayMs);
    const observations = waits.length + 1;
    // ONE rate-limit retry budget for the WHOLE visibility poll. The org runtime's budget bounds a
    // single `callTool`, so re-arming it per read would let these 12 reads accumulate 12 budgets
    // (12 x 30s = 360s) and turn a ~10s poll into a multi-minute mint. The mint passes the budget
    // it already shares with its details read.
    for (let attempt = 1; attempt <= observations; attempt += 1) {
      let observedTransferCount = 0;
      for (const args of [{ status: 'consumed', limit: 100 }, { limit: 100 }]) {
        const result = await this.toolCaller('list_transfers', args, retryDeadlineAtMs);
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
      if (attempt < observations) {
        if (attempt === 1) {
          log.info('Waiting for AgentCard organization transfer visibility', {
            card_id: maskId(cardId),
            observed_transfer_count: observedTransferCount,
          });
        }
        await delay(waits[attempt - 1]);
      }
    }
    return undefined;
  }

  async getDetails(cardId: string, deadlineAtMs?: number): Promise<CardProviderDetailsResult> {
    if (cardId.trim() === '') throw new AgentCardProviderError('cardId is required');
    const result = await this.toolCaller('get_card_details', { card_id: cardId }, deadlineAtMs);
    const record = resultRecord(result);
    throwForGate(record, result);
    // The org MCP now redacts credentials from structuredContent.message and
    // returns PAN/CVV only in text content. Older responses put them in the
    // structured message, so read both without logging either value.
    const text = [resultText(result), optionalString(record, ['message']) ?? ''].join('\n');
    const pan =
      optionalString(record, ['pan', 'card_number', 'cardNumber', 'number']) ??
      (labeledValue(text, 'PAN') ?? labeledValue(text, 'Card Number'))?.replace(/\s+/g, '');
    const cvv =
      optionalString(record, ['cvv', 'cvc', 'security_code']) ??
      labeledValue(text, 'CVV') ??
      labeledValue(text, 'CVC');
    const expiry =
      optionalString(record, ['expiry', 'expiration', 'expires']) ?? labeledValue(text, 'Expiry');
    const balanceCents =
      optionalNumber(record, ['balance_cents', 'balanceCents']) ??
      dollarsToCents(labeledValue(text, 'Balance'));
    const knownCardStatuses = new Set(['OPEN', 'CLOSED', 'FROZEN', 'LOCKED', 'PAUSED']);
    let status = [
      optionalString(record, ['cardStatus']),
      optionalString(record, ['status']),
      labeledValue(text, 'Status'),
    ]
      .map((candidate) => candidate?.toUpperCase())
      .find((candidate) => candidate !== undefined && knownCardStatuses.has(candidate));
    if (status === undefined) {
      const cardResult = await this.toolCaller('get_card', { card_id: cardId }, deadlineAtMs);
      const cardRecord = resultRecord(cardResult);
      throwForGate(cardRecord, cardResult);
      status = optionalString(asRecord(cardRecord.card) ?? cardRecord, ['status']);
    }
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
