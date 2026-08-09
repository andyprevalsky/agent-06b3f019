import { AgentCardNotConnectedError, callUserTool } from '../agentcard/runtime';
import { connectUrlForUser } from '../agentcard/config';
import { createLogger } from '../logger';
import { AgentCardProviderError } from './errors';
import type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';

type AgentCardToolCaller = (
  userId: string,
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

type McpResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  toolResult?: unknown;
};

const log = createLogger('AgentCardUserMCP');

function maskId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function resultText(result: unknown): string {
  const candidate = result as McpResult;
  if (candidate.toolResult !== undefined) return JSON.stringify(candidate.toolResult);
  return (candidate.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
}

function preconditionCodeFromText(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (normalized.includes('kyc')) return 'kyc_required';
  if (
    normalized.includes('wallet') &&
    (normalized.includes('fund_wallet') ||
      normalized.includes('fund it') ||
      normalized.includes('needs $') ||
      normalized.includes('needs usdc'))
  ) {
    return 'wallet_funding_required';
  }
  if (normalized.includes('payment method')) return 'payment_method_required';
  return undefined;
}

function firstRecord(result: unknown): Record<string, unknown> {
  const candidate = result as McpResult;
  if (
    candidate.toolResult !== undefined &&
    typeof candidate.toolResult === 'object' &&
    candidate.toolResult !== null
  ) {
    return candidate.toolResult as Record<string, unknown>;
  }
  if (
    candidate.structuredContent !== undefined &&
    typeof candidate.structuredContent === 'object' &&
    candidate.structuredContent !== null
  ) {
    return candidate.structuredContent as Record<string, unknown>;
  }

  const text = resultText(result);
  if (text !== '') {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // Human-readable tool text is included in the error below.
    }
  }

  const preconditionCode = preconditionCodeFromText(text);
  if (preconditionCode !== undefined) {
    return { code: preconditionCode, message: text };
  }

  throw new AgentCardProviderError(
    `AgentCard MCP response did not include structured data: ${text}`
  );
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

function labeledTextValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*:\\s*([^\\n]+)`, 'im'));
  return match?.[1]?.trim() || undefined;
}

function centsFromDollarText(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/[$,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  return Math.round(Number(normalized) * 100);
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentCardProviderError(`AgentCard MCP response missing ${fieldName}`);
  }
  return value;
}

function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentCardProviderError(`AgentCard MCP response missing ${fieldName}`);
  }
  return value;
}

function approvalId(record: Record<string, unknown>): string | undefined {
  if (record.approval_required !== true) return undefined;
  return assertString(field(record, ['approval_id', 'approvalId']), 'approval_id');
}

function failureMessage(result: unknown): string {
  try {
    const record = firstRecord(result);
    const value = record.message ?? record.error ?? record.status ?? resultText(result);
    return typeof value === 'string' && value.trim() !== ''
      ? value
      : 'AgentCard MCP tool returned an error';
  } catch {
    const text = resultText(result);
    return text !== '' ? text : 'AgentCard MCP tool returned an error';
  }
}

function setupActionForCode(code: string): string {
  switch (code) {
    case 'kyc_required':
      return 'complete_agentcard_kyc';
    case 'wallet_funding_required':
    case 'wallet_balance_unavailable':
      return 'fund_agentcard_wallet';
    case 'org_wallet_funding_required':
      return 'fund_agentcard_company_wallet';
    case 'payment_method_required':
      return 'add_agentcard_payment_method';
    default:
      return 'connect_agentcard';
  }
}

function setupToolForCode(code: string): string | undefined {
  switch (code) {
    case 'kyc_required':
      return 'start_kyc';
    case 'wallet_funding_required':
      return 'fund_wallet';
    default:
      return undefined;
  }
}

function preconditionCode(record: Record<string, unknown>): string | undefined {
  const raw = record.code ?? record.status ?? record.error;
  return typeof raw === 'string' &&
    [
      'kyc_required',
      'wallet_funding_required',
      'org_wallet_funding_required',
      'wallet_balance_unavailable',
      'payment_method_required',
      'connect_required',
    ].includes(raw)
    ? raw
    : undefined;
}

function transferId(record: Record<string, unknown>): string | undefined {
  return optionalString(record, ['transfer_id', 'transferId', 'provider_transfer_id']);
}

function retryAfterSeconds(record: Record<string, unknown>): number | undefined {
  return optionalNumber(record, ['retry_after_seconds', 'retryAfterSeconds']);
}

function throwIfCompanyFundingInProgress(record: Record<string, unknown>): void {
  const raw = record.status ?? record.code ?? record.error;
  if (raw !== 'funding_in_progress') return;
  const id = transferId(record);
  if (id === undefined) {
    throw new AgentCardProviderError(
      'AgentCard company funding is in progress but no transfer id was returned',
      502,
      undefined,
      'agentcard_company_funding_in_progress',
      { agentcardStatus: 'funding_in_progress' }
    );
  }
  throw new AgentCardProviderError(
    'AgentCard company funding is in progress',
    409,
    undefined,
    'agentcard_company_funding_in_progress',
    {
      agentcardStatus: 'funding_in_progress',
      transferId: id,
      retryAfterSeconds: retryAfterSeconds(record),
      agentcardResult: record,
    }
  );
}

function nestedRecord(
  record: Record<string, unknown>,
  fieldName: string
): Record<string, unknown> | undefined {
  const value = record[fieldName];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function findUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrl(item);
      if (found !== undefined) return found;
    }
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findUrl(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function maybeStartSetup(
  userId: string,
  toolCaller: AgentCardToolCaller,
  agentcardStatus: string,
  amountCents: number
): Promise<Record<string, unknown>> {
  const setupTool = setupToolForCode(agentcardStatus);
  if (setupTool === undefined) return {};

  if (setupTool === 'fund_wallet') {
    await toolCaller(userId, 'get_wallet', {});
  }

  const setupArgs =
    setupTool === 'fund_wallet' ? { amount_cents: amountCents, payment_method: 'apple_pay' } : {};
  const setupResult = await toolCaller(userId, setupTool, setupArgs);
  let setupRecord: Record<string, unknown>;
  try {
    setupRecord = firstRecord(setupResult);
  } catch {
    const text = resultText(setupResult);
    setupRecord = text === '' ? {} : { message: text };
  }
  const payment = nestedRecord(setupRecord, 'payment');
  const session = nestedRecord(setupRecord, 'session');
  const setupUrl = findUrl(setupRecord);
  return {
    setupTool,
    ...(setupUrl !== undefined ? { setupUrl } : {}),
    ...(typeof setupRecord.status === 'string' ? { setupStatus: setupRecord.status } : {}),
    ...(typeof setupRecord.message === 'string' ? { setupMessage: setupRecord.message } : {}),
    ...(typeof setupRecord.reason === 'string' ? { setupReason: setupRecord.reason } : {}),
    ...(typeof session?.id === 'string' ? { setupSessionId: session.id } : {}),
    ...(typeof payment?.checkoutUrl === 'string' ? { checkoutUrl: payment.checkoutUrl } : {}),
  };
}

async function throwIfSetupRequired(
  userId: string,
  toolCaller: AgentCardToolCaller,
  record: Record<string, unknown>,
  amountCents: number
): Promise<void> {
  const agentcardStatus = preconditionCode(record);
  if (agentcardStatus === undefined) return;
  const connectUrl = connectUrlForUser(userId);
  const setupDetails = await maybeStartSetup(userId, toolCaller, agentcardStatus, amountCents);
  throw new AgentCardProviderError(
    `AgentCard setup required: ${agentcardStatus}`,
    409,
    undefined,
    'agentcard_setup_required',
    {
      agentcardStatus,
      setupAction: setupActionForCode(agentcardStatus),
      connectUrl,
      ...setupDetails,
    }
  );
}

function providerErrorFromUnknown(
  userId: string,
  tool: string,
  error: unknown
): AgentCardProviderError {
  if (error instanceof AgentCardProviderError) return error;
  if (error instanceof AgentCardNotConnectedError) {
    const connectUrl = connectUrlForUser(userId);
    return new AgentCardProviderError(
      'User has not connected AgentCard',
      409,
      undefined,
      'agentcard_setup_required',
      {
        agentcardStatus: 'connect_required',
        setupAction: 'connect_agentcard',
        connectUrl,
      }
    );
  }
  return new AgentCardProviderError(
    `AgentCard MCP ${tool} failed: ${error instanceof Error ? error.message : String(error)}`
  );
}

export class AgentCardUserMcpProvider implements CardProvider {
  constructor(
    private readonly userId: string,
    private readonly toolCaller: AgentCardToolCaller = callUserTool
  ) {
    if (userId.trim() === '') {
      throw new AgentCardProviderError('userId is required for AgentCard MCP provider', 401);
    }
  }

  async mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    if (!Number.isInteger(request.amountCents) || request.amountCents <= 0) {
      throw new AgentCardProviderError('amountCents must be a positive integer');
    }
    const createArgs = {
      amount_cents: request.amountCents,
      ...(request.fundsSource !== undefined ? { funds_source: request.fundsSource } : {}),
    };

    log.info('Creating AgentCard card through per-user MCP', {
      user_id: maskId(this.userId),
      amount_cents: request.amountCents,
      funds_source: request.fundsSource,
      idempotency_key: request.idempotencyKey,
    });

    const result = await this.callTool('create_card', createArgs);
    let record = firstRecord(result);
    throwIfCompanyFundingInProgress(record);
    await throwIfSetupRequired(this.userId, this.toolCaller, record, request.amountCents);
    const createApprovalId = approvalId(record);
    if (createApprovalId !== undefined) {
      await this.callTool('approve_request', { approval_id: createApprovalId });
      record = firstRecord(await this.callTool('create_card', createArgs));
      throwIfCompanyFundingInProgress(record);
      await throwIfSetupRequired(this.userId, this.toolCaller, record, request.amountCents);
    }

    const cardId = assertString(field(record, ['card_id', 'cardId', 'id']), 'card_id');
    const details =
      optionalString(record, ['last4', 'last_four', 'lastFour']) !== undefined &&
      optionalString(record, ['expiry', 'expiration', 'expires']) !== undefined &&
      optionalNumber(record, [
        'spend_limit_cents',
        'spendLimitCents',
        'amount_cents',
        'amountCents',
        'balance_cents',
        'balanceCents',
      ]) !== undefined &&
      optionalString(record, ['cardStatus', 'status']) !== undefined
        ? undefined
        : await this.getDetails(cardId);

    const last4 =
      optionalString(record, ['last4', 'last_four', 'lastFour']) ??
      assertString(details?.pan.slice(-4), 'last4');
    const expiry =
      optionalString(record, ['expiry', 'expiration', 'expires']) ??
      assertString(details?.expiry, 'expiry');
    const spendLimitCents =
      optionalNumber(record, [
        'spend_limit_cents',
        'spendLimitCents',
        'amount_cents',
        'amountCents',
        'balance_cents',
        'balanceCents',
      ]) ?? request.amountCents;
    const status =
      optionalString(record, ['cardStatus', 'status']) ?? assertString(details?.status, 'status');

    log.info('Created AgentCard MCP card', {
      user_id: maskId(this.userId),
      card_id: maskId(cardId),
      last4,
      expiry,
      spend_limit_cents: spendLimitCents,
      status,
    });

    const providerTransferId = transferId(record);
    return {
      cardId,
      last4,
      expiry,
      spendLimitCents,
      // get_card_details is current truth on replay; create_card can still say "active"
      // after a prior attempt closed the returned card.
      status: details?.status ?? status,
      ...(details !== undefined
        ? { pan: details.pan, cvv: details.cvv, balanceCents: details.balanceCents }
        : {}),
      ...(providerTransferId !== undefined ? { providerTransferId, metadata: record } : {}),
    };
  }

  async getDetails(cardId: string): Promise<CardProviderDetailsResult> {
    if (cardId.trim() === '') {
      throw new AgentCardProviderError('cardId is required');
    }

    log.info('Fetching AgentCard details through per-user MCP', {
      user_id: maskId(this.userId),
      card_id: maskId(cardId),
    });
    let result = await this.callTool('get_card_details', { card_id: cardId });
    let record = firstRecord(result);
    await throwIfSetupRequired(this.userId, this.toolCaller, record, 0);
    const detailsApprovalId = approvalId(record);
    if (detailsApprovalId !== undefined) {
      await this.callTool('approve_request', { approval_id: detailsApprovalId });
      result = await this.callTool('get_card_details', { card_id: cardId });
      record = firstRecord(result);
      await throwIfSetupRequired(this.userId, this.toolCaller, record, 0);
    }
    const detailsText =
      resultText(result) || optionalString(record, ['message', 'text', 'description']) || '';
    const pan =
      optionalString(record, ['pan', 'card_number', 'cardNumber', 'number']) ??
      labeledTextValue(detailsText, 'PAN')?.replace(/\s+/g, '');
    const cvv =
      optionalString(record, ['cvv', 'cvc', 'security_code']) ??
      labeledTextValue(detailsText, 'CVV');
    const expiry =
      optionalString(record, ['expiry', 'expiration', 'expires']) ??
      labeledTextValue(detailsText, 'Expiry');
    const balanceCents =
      optionalNumber(record, [
        'balance_cents',
        'balanceCents',
        'remaining_cents',
        'remainingCents',
      ]) ?? centsFromDollarText(labeledTextValue(detailsText, 'Balance'));
    const status =
      optionalString(record, ['cardStatus', 'status']) ?? labeledTextValue(detailsText, 'Status');

    return {
      pan: assertString(pan, 'pan'),
      cvv: assertString(cvv, 'cvv'),
      expiry: assertString(expiry, 'expiry'),
      balanceCents: assertNumber(balanceCents, 'balance_cents'),
      status: assertString(status, 'status'),
    };
  }

  async closeCard(cardId: string): Promise<void> {
    if (cardId.trim() === '') {
      throw new AgentCardProviderError('cardId is required');
    }

    log.info('Closing AgentCard card through per-user MCP', {
      user_id: maskId(this.userId),
      card_id: maskId(cardId),
    });
    await this.callTool('close_card', { card_id: cardId });
    log.info('Closed AgentCard MCP card', {
      user_id: maskId(this.userId),
      card_id: maskId(cardId),
    });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await this.toolCaller(this.userId, name, args);
      if (typeof result === 'object' && result !== null && (result as McpResult).isError === true) {
        const record = firstRecord(result);
        await throwIfSetupRequired(this.userId, this.toolCaller, record, 0);
        throw new AgentCardProviderError(`AgentCard MCP ${name} failed: ${failureMessage(result)}`);
      }
      return result;
    } catch (error) {
      throw providerErrorFromUnknown(this.userId, name, error);
    }
  }
}
