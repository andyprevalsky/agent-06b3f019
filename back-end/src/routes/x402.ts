/**
 * x402 Payment Routes for Rose Agent Bazaar
 *
 * Endpoints:
 * - POST /api/x402/topup - Add credits (x402 protected, min $0.05)
 * - GET /api/x402/agents/:id/status - Check agent status (public)
 *
 * Note: Agent creation is now unified at POST /api/agents with hybrid auth
 * (supports JWT, API key, or x402 payment)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../providers/database';
import { getUserUsage } from '../providers/credits';
import { getOrCreateWalletUser, addCredits } from '../providers/hybridAuth';
import { getX402Endpoints } from '../providers/x402Endpoints';

const router = Router();

/**
 * POST /api/x402/topup
 * Add credits to wallet account (x402 protected)
 *
 * Note: Agents automatically unpause when they poll and see credits are restored.
 * No need to manually update agent status here.
 */
router.post('/topup', async (req: Request, res: Response) => {
  try {
    // Extract payment info from x402 middleware
    const payment = (req as any).payment;
    if (!payment) {
      return res.status(402).json({ error: 'Payment required' });
    }

    const paymentAmount = parseFloat(payment.amount || '0');
    const payerWallet = payment.payer as string;

    if (paymentAmount < 0.05) {
      return res.status(400).json({ error: 'Minimum topup is $0.05' });
    }

    if (!payerWallet) {
      return res.status(400).json({ error: 'Payer wallet address required' });
    }

    // Get or create user for this wallet
    const user = await getOrCreateWalletUser(payerWallet);
    const userId = user.userId;

    // Add credits - agents will auto-unpause on next poll (within 30s)
    await addCredits(userId, paymentAmount);
    console.log(`💰 Added $${paymentAmount} credits for wallet ${payerWallet}`);

    // Get updated balance
    const usage = await getUserUsage(userId);

    res.json({
      success: true,
      credits_added: paymentAmount,
      total_remaining: usage.remaining,
      wallet: payerWallet,
      available_endpoints: getX402Endpoints(),
    });
  } catch (error) {
    console.error('x402 topup error:', error);
    res.status(500).json({ error: 'Failed to process topup' });
  }
});

/**
 * GET /api/x402/agents/:id/status
 * Get agent status (public - no auth required)
 */
router.get('/agents/:id/status', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.id;

    const agent = await prisma.agent.findFirst({
      where: {
        id: agentId,
        deletedAt: null,
      },
      select: {
        id: true,
        goal: true,
        model: true,
        status: true,
        statusMessage: true,
        progress: true,
        tokenCount: true,
        tokensIn: true,
        tokensOut: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
      },
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get recent messages (last 10)
    const messages = await prisma.message.findMany({
      where: { agentId },
      orderBy: { timestamp: 'desc' },
      take: 10,
      select: {
        role: true,
        text: true,
        timestamp: true,
      },
    });

    // Get remaining credits for this user (wallet)
    const usage = await getUserUsage(agent.userId);

    res.json({
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
      recent_messages: messages.reverse(), // Chronological order
      available_endpoints: getX402Endpoints(agent.id),
    });
  } catch (error) {
    console.error('x402 agent status error:', error);
    res.status(500).json({ error: 'Failed to get agent status' });
  }
});

export default router;
