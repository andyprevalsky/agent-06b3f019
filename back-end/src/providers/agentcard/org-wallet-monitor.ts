import { prisma } from '../database';
import { createLogger } from '../logger';
import { sendSms as sendSmsProvider } from '../smsQueue';
import { callOrgTool as callOrgToolProvider, type AgentCardOrgToolCaller } from './org-runtime';

const log = createLogger('AgentCardOrgWalletMonitor');
const ALERT_OPERATION_KEY = 'agentcard-org-wallet-low-balance';
const ALERT_OPERATION_TYPE = 'AGENTCARD_ORG_WALLET_LOW_BALANCE';
const DEFAULT_THRESHOLD_CENTS = 10_000;
const STALE_ALERT_CLAIM_MS = 24 * 60 * 60 * 1000;

type SmsSender = (
  phone: string,
  message: string
) => Promise<{ success: boolean; messageSid?: string; error?: string }>;

export interface AgentCardOrgWallet {
  livemode: boolean;
  balanceCents: number;
  committedCents: number;
  availableCents: number;
  depositAddress?: string;
  chain?: string;
  stablecoin?: string;
}

export interface AgentCardOrgWalletAlertStore {
  claim(wallet: AgentCardOrgWallet): Promise<boolean>;
  markSent(messageId?: string): Promise<void>;
  release(): Promise<void>;
  rearm(): Promise<void>;
}

interface MonitorDependencies {
  thresholdCents: number;
  alertPhone: string;
  reloadUrl: string;
  fallbackDepositAddress?: string;
  callOrgTool: AgentCardOrgToolCaller;
  sendSms: SmsSender;
  store: AgentCardOrgWalletAlertStore;
}

type MonitorResult =
  | { status: 'healthy'; wallet: AgentCardOrgWallet }
  | { status: 'alerted'; wallet: AgentCardOrgWallet }
  | { status: 'already_alerted'; wallet: AgentCardOrgWallet }
  | { status: 'sandbox_ignored'; wallet: AgentCardOrgWallet }
  | { status: 'disabled' };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`AgentCard company wallet response is missing ${key}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function extractAgentCardOrgWallet(result: unknown): AgentCardOrgWallet {
  const outer = asRecord(result);
  const structured = asRecord(outer?.structuredContent);
  const wallet = asRecord(structured?.wallet);
  if (wallet === undefined) {
    throw new Error('AgentCard get_company_wallet returned no structured wallet');
  }

  return {
    livemode: wallet.livemode === true,
    balanceCents: requiredNumber(wallet, 'balance_cents'),
    committedCents: requiredNumber(wallet, 'committed_cents'),
    availableCents: requiredNumber(wallet, 'available_cents'),
    depositAddress: optionalString(wallet, 'deposit_address'),
    chain: optionalString(wallet, 'chain'),
    stablecoin: optionalString(wallet, 'stablecoin'),
  };
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function lowBalanceMessage(params: {
  wallet: AgentCardOrgWallet;
  thresholdCents: number;
  reloadUrl: string;
  fallbackDepositAddress?: string;
}): string {
  const depositAddress = params.wallet.depositAddress ?? params.fallbackDepositAddress;
  const depositLine = depositAddress
    ? `\nDeposit USDC on Base: ${depositAddress}`
    : '';
  return (
    `Rose AgentCard org wallet is low: ${formatUsd(params.wallet.availableCents)} available ` +
    `(<${formatUsd(params.thresholdCents)}). Re-up: ${params.reloadUrl}${depositLine}`
  );
}

export async function monitorAgentCardOrgWallet(
  dependencies: MonitorDependencies
): Promise<MonitorResult> {
  const rawWallet = await dependencies.callOrgTool('get_company_wallet', {});
  const wallet = extractAgentCardOrgWallet(rawWallet);

  if (!wallet.livemode) return { status: 'sandbox_ignored', wallet };

  if (wallet.availableCents >= dependencies.thresholdCents) {
    await dependencies.store.rearm();
    return { status: 'healthy', wallet };
  }

  const claimed = await dependencies.store.claim(wallet);
  if (!claimed) return { status: 'already_alerted', wallet };

  const message = lowBalanceMessage({
    wallet,
    thresholdCents: dependencies.thresholdCents,
    reloadUrl: dependencies.reloadUrl,
    fallbackDepositAddress: dependencies.fallbackDepositAddress,
  });
  const sent = await dependencies.sendSms(dependencies.alertPhone, message);
  if (!sent.success) {
    await dependencies.store.release();
    throw new Error(sent.error ?? 'Failed to send AgentCard low-balance SMS');
  }
  await dependencies.store.markSent(sent.messageSid);
  return { status: 'alerted', wallet };
}

export function createAgentCardOrgWalletAlertStore(): AgentCardOrgWalletAlertStore {
  return {
    async claim(wallet) {
      await prisma.toolSideEffect.deleteMany({
        where: {
          operationKey: ALERT_OPERATION_KEY,
          status: 'STARTED',
          updatedAt: { lt: new Date(Date.now() - STALE_ALERT_CLAIM_MS) },
        },
      });
      try {
        await prisma.toolSideEffect.create({
          data: {
            operationKey: ALERT_OPERATION_KEY,
            operationType: ALERT_OPERATION_TYPE,
            status: 'STARTED',
            request: {
              availableCents: wallet.availableCents,
              balanceCents: wallet.balanceCents,
              committedCents: wallet.committedCents,
            },
          },
        });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') return false;
        throw error;
      }
    },
    async markSent(messageId) {
      await prisma.toolSideEffect.updateMany({
        where: { operationKey: ALERT_OPERATION_KEY, status: 'STARTED' },
        data: {
          status: 'SUCCEEDED',
          externalId: messageId,
          response: { sent: true },
        },
      });
    },
    async release() {
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: ALERT_OPERATION_KEY, status: 'STARTED' },
      });
    },
    async rearm() {
      await prisma.toolSideEffect.deleteMany({
        where: { operationKey: ALERT_OPERATION_KEY },
      });
    },
  };
}

function thresholdFromEnvironment(): number {
  const raw = process.env.AGENTCARD_ORG_LOW_BALANCE_THRESHOLD_CENTS?.trim();
  if (!raw) return DEFAULT_THRESHOLD_CENTS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('AGENTCARD_ORG_LOW_BALANCE_THRESHOLD_CENTS must be a positive integer');
  }
  return value;
}

export async function runAgentCardOrgWalletMonitor(): Promise<MonitorResult> {
  const alertPhone = process.env.AGENTCARD_ORG_LOW_BALANCE_ALERT_PHONE?.trim();
  const reloadUrl = process.env.AGENTCARD_ORG_WALLET_RELOAD_URL?.trim();
  if (!alertPhone || !reloadUrl) {
    log.warn('AgentCard org-wallet low-balance SMS is disabled', {
      missing_phone: !alertPhone,
      missing_reload_url: !reloadUrl,
    });
    return { status: 'disabled' };
  }

  const result = await monitorAgentCardOrgWallet({
    thresholdCents: thresholdFromEnvironment(),
    alertPhone,
    reloadUrl,
    fallbackDepositAddress: process.env.AGENTCARD_ORG_WALLET_DEPOSIT_ADDRESS?.trim(),
    callOrgTool: callOrgToolProvider,
    sendSms: sendSmsProvider,
    store: createAgentCardOrgWalletAlertStore(),
  });
  log.info('AgentCard org-wallet balance checked', {
    status: result.status,
    available_cents: 'wallet' in result ? result.wallet.availableCents : undefined,
  });
  return result;
}
