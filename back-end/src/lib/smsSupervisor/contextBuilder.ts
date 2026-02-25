/**
 * SMS Supervisor Context Builder
 *
 * Assembles the full LLM context for the SMS supervisor agent.
 * Includes: agent hierarchy, pending attention requests, recent visible
 * messages, user profile, and session history.
 *
 * Called on every inbound SMS to build a fresh snapshot of the user's state.
 */

import { prisma } from '../prisma';
import { CompletionMessage } from '../chat/supabaseCompletions';
import { getAgentUrl } from '../smsTemplates';

// Tool names whose messages are visible to users in the frontend
const VISIBLE_TOOL_NAMES = [
  'send_message_to_user',
  'send_message_to_user_execute_phase',
  'completion_summary',
  'request_user_approval',
  'enable_write_permissions',
  'set_plan',
];

// Max number of recent visible messages per agent
const MAX_MESSAGES_PER_AGENT = 3;
// Max total recent messages across all agents
const MAX_TOTAL_MESSAGES = 15;
// Only include messages from agents updated within this window
const RECENT_AGENT_WINDOW_HOURS = 2;
// Max attention requests to include
const MAX_ATTENTION_REQUESTS = 10;
// Max root agents to include in hierarchy
const MAX_ROOT_AGENTS = 50;

interface AgentNode {
  id: string;
  goal: string;
  status: string;
  progress: number;
  treeCostCents: number;
  priceLimitCents: number;
  depth: number;
  parentAgentId: string | null;
}

interface AttentionRequestContext {
  id: string;
  agentId: string;
  workflowId: string;
  question: string;
  imageUrl: string | null;
  metadata: any;
  createdAt: Date;
  shortcode?: string;
}

interface VisibleMessage {
  agentId: string;
  text: string;
  toolName: string;
  title: string;
  timestamp: Date;
}

export interface SmsContext {
  systemPrompt: string;
  sessionHistory: CompletionMessage[];
}

/**
 * Build the full SMS supervisor context for a user.
 */
export async function buildSmsContext(userId: string): Promise<SmsContext> {
  const startTime = Date.now();

  console.log('[SMS Context] Building context', { userId });

  // Fetch all data in parallel
  const [
    rootAgents,
    attentionRequests,
    user,
    session,
  ] = await Promise.all([
    fetchAgentHierarchy(userId),
    fetchPendingAttentionRequests(userId),
    fetchUserProfile(userId),
    fetchSmsSession(userId),
  ]);

  console.log('[SMS Context] Fetched data', {
    userId,
    rootAgentCount: rootAgents.length,
    attentionRequestCount: attentionRequests.length,
    hasSession: !!session,
    durationMs: Date.now() - startTime,
  });

  // Fetch visible messages from recently active agents
  const recentAgentIds = rootAgents
    .filter(a => {
      const isRecent = (Date.now() - new Date(a.updatedAt).getTime()) < RECENT_AGENT_WINDOW_HOURS * 60 * 60 * 1000;
      const isActive = ['ACTIVE', 'PAUSED', 'STARTING_UP', 'COST_LIMIT_REACHED'].includes(a.status);
      return isRecent || isActive;
    })
    .map(a => a.id);

  // Also include child agent IDs for recently active roots
  const allAgentIds = [...recentAgentIds];
  for (const root of rootAgents) {
    if (recentAgentIds.includes(root.id) && root.children) {
      allAgentIds.push(...root.children.map((c: any) => c.id));
    }
  }

  const visibleMessages = await fetchVisibleMessages(allAgentIds);

  console.log('[SMS Context] Fetched visible messages', {
    userId,
    recentAgentCount: recentAgentIds.length,
    visibleMessageCount: visibleMessages.length,
    durationMs: Date.now() - startTime,
  });

  // Fetch shortcodes for attention requests that need them
  const shortcodeMap = await fetchShortcodesForRequests(
    attentionRequests.map(r => r.id),
    userId
  );

  // Assemble system prompt sections
  const hierarchySection = formatAgentHierarchy(rootAgents);
  const attentionSection = formatAttentionRequests(attentionRequests, shortcodeMap);
  const messagesSection = formatVisibleMessages(visibleMessages, rootAgents);
  const userContextSection = formatUserContext(user);

  const systemPrompt = assembleSystemPrompt({
    hierarchySection,
    attentionSection,
    messagesSection,
    userContextSection,
    userName: user?.name || 'User',
    userPhone: user?.phone || '',
    customSystemPrompt: user?.customSystemPrompt || null,
  });

  // Load full session history (no limit — all messages are persisted)
  const sessionMessages: CompletionMessage[] = session?.messages
    ? (JSON.parse(typeof session.messages === 'string' ? session.messages : JSON.stringify(session.messages)) as any[])
        .map((m: any) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))
    : [];

  const totalDurationMs = Date.now() - startTime;
  console.log('[SMS Context] Built context', {
    userId,
    systemPromptLength: systemPrompt.length,
    sessionHistoryLength: sessionMessages.length,
    sections: {
      hierarchy: hierarchySection.length,
      attention: attentionSection.length,
      messages: messagesSection.length,
      userContext: userContextSection.length,
    },
    durationMs: totalDurationMs,
  });

  return { systemPrompt, sessionHistory: sessionMessages };
}

// ============================================
// Data Fetchers
// ============================================

async function fetchAgentHierarchy(userId: string) {
  const rootAgents = await prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: null,
      status: {
        in: ['ACTIVE', 'PAUSED', 'STARTING_UP', 'COST_LIMIT_REACHED'],
      },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROOT_AGENTS,
    include: {
      children: {
        where: { deletedAt: null },
        select: {
          id: true,
          goal: true,
          status: true,
          progress: true,
          depth: true,
          parentAgentId: true,
          treeCostCents: true,
          priceLimitCents: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return rootAgents;
}

async function fetchPendingAttentionRequests(userId: string): Promise<AttentionRequestContext[]> {
  const requests = await prisma.agentAttentionRequest.findMany({
    where: {
      userId,
      userResponse: null,
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_ATTENTION_REQUESTS,
  });

  return requests.map(r => ({
    id: r.id,
    agentId: r.agentId,
    workflowId: r.workflowId,
    question: r.question,
    imageUrl: r.imageUrl,
    metadata: r.metadata,
    createdAt: r.createdAt,
  }));
}

async function fetchUserProfile(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      name: true,
      phone: true,
      city: true,
      state: true,
      country: true,
      customSystemPrompt: true,
      systemName: true,
    },
  });
}

async function fetchSmsSession(userId: string) {
  return prisma.smsSession.findUnique({
    where: { userId },
  });
}

async function fetchVisibleMessages(agentIds: string[]): Promise<VisibleMessage[]> {
  if (agentIds.length === 0) return [];

  // Fetch recent TOOL messages from these agents
  const messages = await prisma.message.findMany({
    where: {
      agentId: { in: agentIds },
      role: 'TOOL',
    },
    orderBy: { timestamp: 'desc' },
    take: MAX_TOTAL_MESSAGES * 3, // Fetch extra, filter in code
    select: {
      agentId: true,
      text: true,
      metadata: true,
      timestamp: true,
    },
  });

  // Filter to visible tool names
  const visible: VisibleMessage[] = [];
  const countByAgent: Record<string, number> = {};

  for (const msg of messages) {
    if (visible.length >= MAX_TOTAL_MESSAGES) break;

    const metadata = msg.metadata as Record<string, any> | null;
    if (!metadata) continue;

    const toolName = metadata.toolName as string | undefined;
    const isFinalSummary = metadata.isFinalSummary as boolean | undefined;

    if (!toolName && !isFinalSummary) continue;
    if (toolName && !VISIBLE_TOOL_NAMES.includes(toolName) && !isFinalSummary) continue;

    // Respect per-agent limit
    countByAgent[msg.agentId] = (countByAgent[msg.agentId] || 0) + 1;
    if (countByAgent[msg.agentId] > MAX_MESSAGES_PER_AGENT) continue;

    const title = (metadata.title as string) || toolName || 'Message';
    const text = metadata.attentionMessage || metadata.completionSummary?.summary || msg.text || '';

    if (!text) continue;

    visible.push({
      agentId: msg.agentId,
      text: typeof text === 'string' ? text : JSON.stringify(text),
      toolName: toolName || 'completion_summary',
      title,
      timestamp: msg.timestamp,
    });
  }

  return visible;
}

async function fetchShortcodesForRequests(
  requestIds: string[],
  userId: string
): Promise<Map<string, string>> {
  if (requestIds.length === 0) return new Map();

  const shortcodes = await prisma.smsShortcode.findMany({
    where: {
      attentionRequestId: { in: requestIds },
      userId,
      expiresAt: { gt: new Date() },
    },
    select: {
      attentionRequestId: true,
      code: true,
    },
  });

  return new Map(shortcodes.map(s => [s.attentionRequestId, s.code]));
}

// ============================================
// Formatters
// ============================================

function formatAgentHierarchy(rootAgents: any[]): string {
  if (rootAgents.length === 0) {
    return '## Your Active Agents\n\nNo active agents.';
  }

  const lines = ['## Your Active Agents\n'];

  for (const root of rootAgents) {
    const prefix = root.id.substring(0, 6);
    const goalPreview = root.goal.length > 80 ? root.goal.substring(0, 77) + '...' : root.goal;
    const statusStr = formatStatus(root.status, root.progress);
    const costStr = `$${(root.treeCostCents / 100).toFixed(2)}/$${(root.priceLimitCents / 100).toFixed(2)}`;

    lines.push(`📁 ${goalPreview} [${prefix}] — ${statusStr} — ${costStr}`);

    // Children (indented)
    if (root.children && root.children.length > 0) {
      for (const child of root.children) {
        const childPrefix = child.id.substring(0, 6);
        const childGoal = child.goal.length > 60 ? child.goal.substring(0, 57) + '...' : child.goal;
        const childStatus = formatStatus(child.status, child.progress);
        lines.push(`  📁 ${childGoal} [${childPrefix}] — ${childStatus}`);
      }
    }
  }

  return lines.join('\n');
}

function formatStatus(status: string, progress: number): string {
  switch (status) {
    case 'ACTIVE':
      return `ACTIVE ${Math.round(progress * 100)}%`;
    case 'COMPLETED':
      return 'COMPLETED ✓';
    case 'FAILED':
      return 'FAILED ✗';
    case 'PAUSED':
      return 'PAUSED';
    case 'COST_LIMIT_REACHED':
      return 'BUDGET LIMIT';
    case 'STARTING_UP':
      return 'STARTING';
    default:
      return status;
  }
}

function formatAttentionRequests(
  requests: AttentionRequestContext[],
  shortcodeMap: Map<string, string>
): string {
  if (requests.length === 0) {
    return '## Pending Requests\n\nNo pending requests.';
  }

  const lines = ['## Pending Requests\n'];

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const agentPrefix = r.agentId.substring(0, 6);
    const shortcode = shortcodeMap.get(r.id);
    const questionPreview = r.question.length > 200 ? r.question.substring(0, 197) + '...' : r.question;

    // Determine type from metadata
    const metadata = r.metadata as Record<string, any> | null;
    const isApproval = metadata?.requestUserApproval || metadata?.writePermission;
    const type = isApproval ? 'APPROVAL' : 'QUESTION';

    let line = `${i + 1}. [${agentPrefix}] ${type}: "${questionPreview}" (attn_id: ${r.id})`;
    if (shortcode) {
      line += ` — Approve ${shortcode}`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

function formatVisibleMessages(messages: VisibleMessage[], rootAgents: any[]): string {
  if (messages.length === 0) {
    return '## Recent Agent Activity\n\nNo recent activity.';
  }

  // Build agentId -> goal map for labeling
  const agentGoals: Record<string, string> = {};
  for (const root of rootAgents) {
    agentGoals[root.id] = root.goal;
    if (root.children) {
      for (const child of root.children) {
        agentGoals[child.id] = child.goal;
      }
    }
  }

  const lines = ['## Recent Agent Activity\n'];

  for (const msg of messages) {
    const agentPrefix = msg.agentId.substring(0, 6);
    const textPreview = msg.text.length > 150 ? msg.text.substring(0, 147) + '...' : msg.text;
    const timeAgo = formatTimeAgo(msg.timestamp);

    lines.push(`[${agentPrefix}] ${msg.title} (${timeAgo}): ${textPreview}`);
  }

  return lines.join('\n');
}

function formatUserContext(user: any): string {
  if (!user) return '';

  const parts = ['## User Context\n'];

  if (user.name) parts.push(`Name: ${user.name}`);
  if (user.phone) parts.push(`Phone: ${user.phone}`);

  const locationParts = [user.city, user.state, user.country].filter(Boolean);
  if (locationParts.length > 0) {
    parts.push(`Location: ${locationParts.join(', ')}`);
  }

  if (user.systemName) parts.push(`Preferred system name: ${user.systemName}`);

  return parts.join('\n');
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ============================================
// System Prompt Assembly
// ============================================

function assembleSystemPrompt(params: {
  hierarchySection: string;
  attentionSection: string;
  messagesSection: string;
  userContextSection: string;
  userName: string;
  userPhone: string;
  customSystemPrompt: string | null;
}): string {
  const {
    hierarchySection,
    attentionSection,
    messagesSection,
    userContextSection,
    userName,
    userPhone,
    customSystemPrompt,
  } = params;

  // Import the base prompt template
  // Inline here to keep context builder self-contained
  let prompt = `You are Rose, the SMS interface for Rose Labs. You help ${userName} manage their AI agents via text message.

CURRENT DATE: ${new Date().toISOString()}
USER: ${userName} (${userPhone})

${hierarchySection}

${attentionSection}

${messagesSection}

${userContextSection}

## Your Capabilities

You can:
1. Answer questions about agent status, progress, and results
2. Resolve agent attention requests — approve or reject (resolve_attention_request)
3. Kill/stop agents (kill_agent)
4. Increase an agent's budget when it hits the cost limit (increase_budget)
5. Start new agents to accomplish tasks (start_new_agent)
6. Search the web for information (web_search)

## How to Respond

Think step by step. Use tools as needed to gather information or take actions. When you are done, you MUST call attempt_completion with the SMS text to send to the user. The ONLY way to send a message is via attempt_completion.

- Use the agent ID prefix [XXXXXX] when referring to specific agents
- For write lock approvals, remind the user they can reply "Approve XXXXX" with the shortcode
- Be conversational but concise — this is texting, not email
- If the user's message is ambiguous about which agent, ask for clarification
- When starting a new agent, confirm the goal before launching unless the user gave a clear task
- The trace URL for any agent is: https://roselabs.ai?agent-id={full_agent_id}

## Response Format

You MUST respond with valid JSON:
{
  "reasoning": "your internal thought process (not shown to user)",
  "tool_calls": [
    {"tool": "tool_name", "arguments": {...}}
  ]
}

tool_calls should contain the tools you want to execute this turn.
When you have your answer ready, include {"tool": "attempt_completion", "arguments": {"message": "your SMS text"}} in tool_calls.
You may call other tools and attempt_completion in the same turn.
Only call tools when the user's intent is clear. Don't guess.`;

  if (customSystemPrompt) {
    prompt += `\n\n## User's Custom Instructions\n\n${customSystemPrompt}`;
  }

  return prompt;
}
