import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

/**
 * Save tool usage
 * POST /api/tool-usage
 * Auth: API Key (internal service-to-service)
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { agent_id, user_id, tool_name, total_cost_cents, usage_items } = req.body;

    // Validate required fields
    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }
    
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!tool_name) {
      return res.status(400).json({ error: 'tool_name is required' });
    }

    if (typeof total_cost_cents !== 'number') {
      return res.status(400).json({ error: 'total_cost_cents must be a number' });
    }

    if (!Array.isArray(usage_items)) {
      return res.status(400).json({ error: 'usage_items must be an array' });
    }

    // Verify agent exists and belongs to user
    const agent = await prisma.agent.findUnique({
      where: { id: agent_id },
      select: { id: true, userId: true }
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (agent.userId !== user_id) {
      return res.status(403).json({ error: 'Agent does not belong to user' });
    }

    // Save tool usage
    const toolUsage = await prisma.toolUsage.create({
      data: {
        userId: user_id,      // Direct user tracking
        agentId: agent_id,    // Agent-specific tracking
        toolName: tool_name,
        totalCostCents: total_cost_cents,
        usageItems: usage_items
      }
    });

    console.log(`✅ Saved tool usage: ${tool_name} for agent ${agent_id} - $${(total_cost_cents / 100).toFixed(2)}`);

    res.status(201).json({
      id: toolUsage.id,
      agent_id: toolUsage.agentId,
      tool_name: toolUsage.toolName,
      total_cost_cents: toolUsage.totalCostCents,
      created_at: toolUsage.createdAt
    });

  } catch (error) {
    console.error(`Error saving tool usage (agent=${req.body?.agent_id}):`, error);
    res.status(500).json({ error: 'Failed to save tool usage' });
  }
});

/**
 * Get tool usage for an agent
 * GET /api/tool-usage/:agentId
 * Auth: API Key or JWT (must own agent)
 */
router.get('/:agentId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { agentId } = req.params;

    // Verify agent exists and user has access
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, userId: true }
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // For JWT auth, verify ownership; for API key auth, allow access
    if (!req.isInternal) {
      const userId = (req as any).user?.id;
      if (agent.userId !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Get all tool usage for this agent
    const toolUsages = await prisma.toolUsage.findMany({
      where: { agentId },
      orderBy: { createdAt: 'asc' }
    });

    // Calculate totals
    const totalCostCents = toolUsages.reduce((sum, usage) => sum + usage.totalCostCents, 0);
    
    // Aggregate token counts (only from LLM-type usage items)
    let totalTokens = 0;
    for (const usage of toolUsages) {
      const items = usage.usageItems as any[];
      for (const item of items) {
        if (item.type === 'llm' && item.number_of_tokens) {
          totalTokens += item.number_of_tokens;
        }
      }
    }

    res.json({
      agent_id: agentId,
      tool_usage_count: toolUsages.length,
      total_cost_cents: totalCostCents,
      total_cost_dollars: totalCostCents / 100,
      total_tokens_from_tools: totalTokens,
      usages: toolUsages.map(usage => ({
        id: usage.id,
        tool_name: usage.toolName,
        total_cost_cents: usage.totalCostCents,
        usage_items: usage.usageItems,
        created_at: usage.createdAt
      }))
    });

  } catch (error) {
    console.error(`Error fetching tool usage (agent=${req.params.agentId}):`, error);
    res.status(500).json({ error: 'Failed to fetch tool usage' });
  }
});

export default router;

