import * as repo from './repo';
import { MIN_TOPUP_AMOUNT } from './config';
import { getUserUsage } from '../../providers/credits';
import { getOrCreateWalletUser, addCredits } from '../../providers/hybridAuth';
import { getX402Endpoints } from '../../providers/x402Endpoints';
import { createLogger } from '../../providers/logger';

const log = createLogger('X402');

export class TopupValidationError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'TopupValidationError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

/* c8 ignore start -- processTopup requires x402 payment middleware which needs real blockchain transactions */
/**
 * Process a topup payment: validate, create/find wallet user, add credits.
 */
export async function processTopup(payment: { amount?: string; payer?: string } | undefined) {
  if (!payment) {
    throw new TopupValidationError('Payment required', 402);
  }

  const paymentAmount = parseFloat(payment.amount ?? '0');
  const payerWallet = payment.payer;

  if (!Number.isFinite(paymentAmount) || paymentAmount < MIN_TOPUP_AMOUNT) {
    throw new TopupValidationError(`Minimum topup is $${MIN_TOPUP_AMOUNT}`, 400);
  }

  if (payerWallet === undefined || payerWallet === '') {
    throw new TopupValidationError('Payer wallet address required', 400);
  }

  // Get or create user for this wallet
  const user = await getOrCreateWalletUser(payerWallet);
  const userId = user.userId;

  // Add credits - agents will auto-unpause on next poll (within 30s)
  await addCredits(userId, paymentAmount);
  log.info('Added credits for wallet', { amount: paymentAmount, wallet: payerWallet });

  // Get updated balance
  const usage = await getUserUsage(userId);

  return {
    success: true,
    credits_added: paymentAmount,
    total_remaining: usage.remaining,
    wallet: payerWallet,
    available_endpoints: getX402Endpoints(),
  };
}
/* c8 ignore stop */

/**
 * Get agent status with recent messages and credit balance.
 */
export async function getAgentStatus(agentId: string) {
  const agent = await repo.findAgentById(agentId);
  if (!agent) {
    throw new AgentNotFoundError(agentId);
  }

  const [messages, usage] = await Promise.all([
    repo.findRecentMessages(agentId),
    getUserUsage(agent.userId),
  ]);

  return {
    agent_id: agent.id,
    goal: agent.goal,
    model: agent.model,
    status: agent.status,
    status_message: agent.statusMessage,
    progress: agent.progress,
    tokens_used: agent.tokenCount,
    credits_remaining: usage.remaining,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    recent_messages: messages.map((m) => ({
      role: m.role,
      timestamp: m.timestamp,
    })),
    available_endpoints: getX402Endpoints(agent.id),
  };
}
