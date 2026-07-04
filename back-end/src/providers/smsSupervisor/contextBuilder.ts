/**
 * SMS Supervisor Context Builder
 *
 * Assembles the full LLM context for the SMS supervisor agent.
 * Includes: agent hierarchy, pending attention requests, recent visible
 * messages, user profile, and session history.
 *
 * Called on every inbound SMS to build a fresh snapshot of the user's state.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { CompletionMessage, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../rose';
import { createLogger } from '../logger';

const log = createLogger('SmsContext');

// Cache boundary handling: the call site (supervisorHandler.ts) wraps the
// returned `systemPrompt` in `markCacheable()` (see providers/rose/cache.ts),
// which makes the entire prompt the cache-stable static prefix on the
// Anthropic claudeAuth path. We do NOT embed the boundary sentinel here —
// keeping the cache boundary explicit at the call site makes the contract
// visible. Per-SMS dynamic state lives in `contextUserMessage` (a separate
// trailing user-role message) so it never invalidates the cached prefix.

// Tool names whose messages are visible to users in the frontend
const VISIBLE_TOOL_NAMES = [
  'send_message_to_user',
  'send_message_to_user_execute_phase',
  'completion_summary',
  'request_user_approval',
  'set_plan',
];

// Max number of recent visible messages per agent
const MAX_MESSAGES_PER_AGENT = 3;
// Max total recent messages across all agents
const MAX_TOTAL_MESSAGES = 15;
// Only include messages from agents updated within this window
const RECENT_AGENT_WINDOW_HOURS = 2;
// Keep recently completed root agents visible so the SMS supervisor can
// reconcile follow-up texts with completion SMSes the user already saw.
const COMPLETED_ROOT_RETENTION_DAYS = 7;
// Max attention requests to include
const MAX_ATTENTION_REQUESTS = 10;
// Max root agents to include in hierarchy
const MAX_ROOT_AGENTS = 50;

interface ChildAgentNode {
  id: string;
  goal: string;
  status: string;
  progress: number;
  depth: number;
  parentAgentId: string | null;
  treeCostCents: number;
  priceLimitCents: number;
  updatedAt: Date;
}

interface RootAgentNode {
  id: string;
  goal: string;
  status: string;
  progress: number;
  treeCostCents: number;
  priceLimitCents: number;
  updatedAt: Date;
  children: ChildAgentNode[];
}

interface AttentionRequestContext {
  id: string;
  agentId: string;
  workflowId: string;
  question: string;
  imageUrl: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

interface VisibleMessage {
  agentId: string;
  text: string;
  toolName: string;
  title: string;
  timestamp: Date;
}

interface UserProfileContext {
  userId: string;
  name: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  systemName: string | null;
}

export interface SmsContext {
  systemPrompt: string;
  /**
   * Volatile per-SMS state (agent hierarchy, pending attention requests, recent
   * visible messages, current datetime). Injected as a `user`-role message
   * BEFORE the inbound user message so the static system prompt stays
   * cache-stable across SMSes within a 5-min Anthropic ephemeral window.
   */
  contextUserMessage: string;
  sessionHistory: CompletionMessage[];
}

/**
 * Build the full SMS supervisor context for a user.
 */
export async function buildSmsContext(userId: string): Promise<SmsContext> {
  const startTime = Date.now();

  log.info('[SmsContext] Building context', { userId });

  // Fetch all data in parallel
  const [rootAgents, attentionRequests, user, session] = await Promise.all([
    fetchAgentHierarchy(userId),
    fetchPendingAttentionRequests(userId),
    fetchUserProfile(userId),
    fetchSmsSession(userId),
  ]);

  log.info('[SmsContext] Fetched data', {
    userId,
    rootAgentCount: rootAgents.length,
    attentionRequestCount: attentionRequests.length,
    hasSession: !!session,
    durationMs: Date.now() - startTime,
  });

  // Fetch visible messages from recently active agents
  const recentAgentIds = rootAgents
    .filter((a) => {
      const ageMs = Date.now() - new Date(a.updatedAt).getTime();
      const isRecent = ageMs < RECENT_AGENT_WINDOW_HOURS * 60 * 60 * 1000;
      const isActive = ['ACTIVE', 'PAUSED', 'STARTING_UP', 'COST_LIMIT_REACHED'].includes(a.status);
      const isRetainedCompletion =
        a.status === 'COMPLETED' && ageMs < COMPLETED_ROOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      return isRecent || isActive || isRetainedCompletion;
    })
    .map((a) => a.id);

  // Also include child agent IDs for recently active roots
  const allAgentIds = [...recentAgentIds];
  for (const root of rootAgents) {
    if (recentAgentIds.includes(root.id) && root.children) {
      allAgentIds.push(...root.children.map((c) => c.id));
    }
  }

  const visibleMessages = await fetchVisibleMessages(allAgentIds);

  log.info('[SmsContext] Fetched visible messages', {
    userId,
    recentAgentCount: recentAgentIds.length,
    visibleMessageCount: visibleMessages.length,
    durationMs: Date.now() - startTime,
  });

  // STATIC: identity, user profile (rarely changes), tool guidance, response
  // format, and custom system prompt — cacheable up to the boundary marker.
  const userContextSection = formatUserContext(user);
  const systemPrompt = assembleSystemPrompt({
    userContextSection,
    userName: user?.name || 'User',
    assistantName: user?.systemName || 'Rose',
  });

  // DYNAMIC: hierarchy, attention requests, recent activity, current datetime —
  // these change on every SMS and live in a trailing user message so they
  // don't invalidate the cached system prefix.
  const hierarchySection = formatAgentHierarchy(rootAgents);
  const attentionSection = formatAttentionRequests(attentionRequests);
  const messagesSection = formatVisibleMessages(visibleMessages, rootAgents);
  const contextUserMessage = assembleContextUserMessage({
    hierarchySection,
    attentionSection,
    messagesSection,
  });

  // Load full session history (no limit — all messages are persisted).
  // Defensive parse: a malformed row must not break the supervisor path for
  // every inbound SMS. We drop anything that isn't a well-formed message.
  let parsedSessionMessages: unknown = [];
  const rawMessages = session?.messages;
  if (rawMessages !== undefined && rawMessages !== null) {
    try {
      parsedSessionMessages =
        typeof rawMessages === 'string' ? JSON.parse(rawMessages) : rawMessages;
    } catch (err) {
      log.warn('[SmsContext] Failed to parse session.messages, dropping history', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      parsedSessionMessages = [];
    }
  }
  const sessionMessages: CompletionMessage[] = Array.isArray(parsedSessionMessages)
    ? parsedSessionMessages
        .filter(
          (m): m is { role: 'user' | 'assistant'; content: string } =>
            typeof m === 'object' &&
            m !== null &&
            ((m as Record<string, unknown>).role === 'user' ||
              (m as Record<string, unknown>).role === 'assistant') &&
            typeof (m as Record<string, unknown>).content === 'string'
        )
        .map((entry) => ({ role: entry.role, content: entry.content }))
    : [];

  const totalDurationMs = Date.now() - startTime;
  log.info('[SmsContext] Built context', {
    userId,
    systemPromptLength: systemPrompt.length,
    contextUserMessageLength: contextUserMessage.length,
    sessionHistoryLength: sessionMessages.length,
    sections: {
      hierarchy: hierarchySection.length,
      attention: attentionSection.length,
      messages: messagesSection.length,
      userContext: userContextSection.length,
    },
    durationMs: totalDurationMs,
  });

  return { systemPrompt, contextUserMessage, sessionHistory: sessionMessages };
}

// ============================================
// Data Fetchers
// ============================================

async function fetchAgentHierarchy(userId: string) {
  const completedSince = new Date(Date.now() - COMPLETED_ROOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rootAgents = await prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: null,
      OR: [
        {
          status: {
            in: ['ACTIVE', 'PAUSED', 'STARTING_UP', 'COST_LIMIT_REACHED'],
          },
        },
        {
          status: 'COMPLETED',
          updatedAt: { gte: completedSince },
        },
      ],
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

  return requests.map((r) => ({
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
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
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

    const metadata = msg.metadata as Record<string, unknown> | null;
    if (!metadata) continue;

    const toolName = metadata.toolName as string | undefined;
    const isFinalSummary = metadata.isFinalSummary as boolean | undefined;

    if (!toolName && !isFinalSummary) continue;
    if (toolName && !VISIBLE_TOOL_NAMES.includes(toolName) && !isFinalSummary) continue;

    // Respect per-agent limit
    countByAgent[msg.agentId] = (countByAgent[msg.agentId] || 0) + 1;
    if (countByAgent[msg.agentId] > MAX_MESSAGES_PER_AGENT) continue;

    const title = (metadata.title as string) || toolName || 'Message';
    const completionSummary = metadata.completionSummary as { summary?: string } | undefined;
    const text =
      (metadata.attentionMessage as string | undefined) ||
      completionSummary?.summary ||
      msg.text ||
      '';

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

// ============================================
// Formatters
// ============================================

function formatAgentHierarchy(rootAgents: RootAgentNode[]): string {
  if (rootAgents.length === 0) {
    return '# Agent Hierarchy\n\nNo active or recently completed agents.';
  }

  const lines = ['# Agent Hierarchy\n'];

  for (const root of rootAgents) {
    const prefix = root.id.substring(0, 6);
    const goalPreview = root.goal.length > 80 ? root.goal.substring(0, 77) + '...' : root.goal;
    const statusStr = formatStatus(root.status, root.progress);
    const costStr = `$${(root.treeCostCents / 100).toFixed(2)}/$${(root.priceLimitCents / 100).toFixed(2)}`;

    lines.push(`📁 ${goalPreview} [${prefix}], ${statusStr}, ${costStr}`);

    // Children (indented)
    if (root.children && root.children.length > 0) {
      for (const child of root.children) {
        const childPrefix = child.id.substring(0, 6);
        const childGoal = child.goal.length > 60 ? child.goal.substring(0, 57) + '...' : child.goal;
        const childStatus = formatStatus(child.status, child.progress);
        lines.push(`  📁 ${childGoal} [${childPrefix}], ${childStatus}`);
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

function formatAttentionRequests(requests: AttentionRequestContext[]): string {
  if (requests.length === 0) {
    return '# Pending Requests\n\nNo pending requests.';
  }

  const lines = ['# Pending Requests\n'];

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const agentPrefix = r.agentId.substring(0, 6);
    const questionPreview =
      r.question.length > 200 ? r.question.substring(0, 197) + '...' : r.question;

    // Determine type from metadata
    const metadata = r.metadata as Record<string, unknown> | null;
    const isApproval = metadata?.requestUserApproval || metadata?.writePermission;
    const type = isApproval ? 'APPROVAL' : 'QUESTION';

    lines.push(`${i + 1}. [${agentPrefix}] ${type}: "${questionPreview}" (attn_id: ${r.id})`);
  }

  return lines.join('\n');
}

function formatVisibleMessages(messages: VisibleMessage[], rootAgents: RootAgentNode[]): string {
  if (messages.length === 0) {
    return '# Recent Agent Activity\n\nNo recent activity.';
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

  const lines = ['# Recent Agent Activity\n'];

  for (const msg of messages) {
    const agentPrefix = msg.agentId.substring(0, 6);
    const textPreview = msg.text.length > 150 ? msg.text.substring(0, 147) + '...' : msg.text;
    const timeAgo = formatTimeAgo(msg.timestamp);

    lines.push(`[${agentPrefix}] ${msg.title} (${timeAgo}): ${textPreview}`);
  }

  return lines.join('\n');
}

function formatUserContext(user: UserProfileContext | null): string {
  if (!user) return '';

  const parts = ['# User Context\n'];

  if (user.name) parts.push(`Name: ${user.name}`);
  if (user.phone) parts.push(`Phone: ${user.phone}`);

  // Shipping address
  const addressParts = [user.addressLine1, user.addressLine2].filter(Boolean);
  const cityStateZip = [user.city, user.state, user.postalCode].filter(Boolean).join(', ');
  if (addressParts.length > 0 || cityStateZip) {
    const fullAddress = [...addressParts, cityStateZip, user.country].filter(Boolean).join(', ');
    parts.push(`Shipping address: ${fullAddress}`);
  } else {
    const locationParts = [user.city, user.state, user.country].filter(Boolean);
    if (locationParts.length > 0) {
      parts.push(`Location: ${locationParts.join(', ')}`);
    }
  }

  // Note: user.systemName is interpolated into the universal-static prompt as
  // `{USER_ASSIGNED_ASSISTANT_NAME}` at render time on the per-user-stable
  // template path; re-stating it here would duplicate the value and drift.

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

/**
 * STATIC system prompt — identity, user profile, tool guidance, response
 * format. Anything that would change per-SMS (datetime, hierarchy, attention
 * requests, recent activity) lives in `assembleContextUserMessage` instead.
 *
 * The call site wraps this prompt in `markCacheable()` so the entire prefix
 * is tagged with cache_control: ephemeral on the Anthropic claudeAuth path,
 * letting prompt caching reuse it across SMSes within the 5-min window.
 * See providers/rose/cache.ts.
 */
/**
 * Block 1 template — assistant identity, input format docs, response rules.
 * Per-user-stable: interpolates `{USER_ASSIGNED_ASSISTANT_NAME}` (the user's
 * preferred system name, defaults to "Rose") and `{USER_NAME}`. Cached as a
 * single `ephemeral.global` block on the claudeAuth path; across messages from
 * the same user this is byte-identical, so the Anthropic prefix cache reuses it.
 *
 * No per-SMS data (datetime, hierarchy, recent activity) goes here — that lives
 * in the trailing user-role context message so it never invalidates the prefix.
 */
const STATIC_SUPERVISOR_PROMPT_TEMPLATE = `You are {USER_ASSIGNED_ASSISTANT_NAME}, a nurturer of metaphysical seeds. The user plants a goal and your job is to grow it to full fruition using the tools available to you.

In this surface, you receive SMS messages from {USER_NAME} and orchestrate massive agent networks to accomplish user goals.

Operate with the lowest energy expenditure possible. Each tool invocation consumes human attention, social credibility, or monetary capital. Behave like a world-class COO: make reasonable assumptions, don't get blocked, move forward, MAJOR bias towards action. You specialize in real-world, long-horizon task execution. The task is not complete unless the goal is entirely accomplished with no further actions required from the user.

Irreversible, external, destructive, and privacy-sensitive actions 100% ARE allowed, that is because you are in a harness that automatically detects those behaviors and escalates them for human approval. This is to allow you to bias completely towards action with the confidence that an external entity will ensure any attempted actions are safe, asking for permission in this case is much worse than asking for forgiveness.

Context is available to you primarily through grep, this tool's purpose is to acquire factual information from the user's own data (contacts/network, message history, transactions, documents). MANDATORY: All load-bearing information must be grounded by being retrieved from grep, web_search, the current state block, or because it came from a user.

# Your Inputs

For every user message, you will receive a timestamp and a state of the agent network you are managing at that time. Treat the state block as ground truth for "right now"; older session turns may reflect stale state.

An example of the format of that state is as follows.

Current state (as of 2026-05-06T12:00:00.000Z):

# Agent Hierarchy
[a1b2c3] Book boxing class - running
  [d4e5f6] Check class availability - waiting for approval

# Pending Requests
- attn_123 from [d4e5f6]: Approve payment for monthly membership

# Recent Activity
- [a1b2c3] Sent message to user (2m ago): "Found a 6pm Tuesday class, want me to book it?"
- [d4e5f6] Completion summary (just now): "Booked Tuesday 6pm class, confirmation #4421."

Agent Hierarchy
- 6-character agent IDs along with their task description.
- Indentation dictates the hierarchy of tasks — indented agents are spawned from their parent agent at the previous indentation level.

Pending Requests
- Open requests from agents — write-lock approvals or clarifying questions. Use attn_id values internally for reply_to_agent calls; never show them to the user.

Recent Activity
- Messages your agents have sent to the user and their completion summaries.

# How to Respond

Think step by step. Use tools as needed to gather information or take actions. When you are done, call attempt_completion with the SMS text to send to the user.

Parallelize as many tool calls per turn as reasonable so you respond quickly with grounded, accurate answers.

- Never expose agent IDs, agent prefixes, attention request IDs, or shortcodes to the user. Use internal IDs only for tool calls.
- Resolve natural approval language against pending requests. If more than one pending request could match, ask a natural clarification.
- Be conversational but concise, this is texting, not email
- Calling attempt_completion both sends your SMS and commits every write-tool call you made this turn. There is no separate commit step and no retraction after you call it.`;

/**
 * Cache layout produced here, on the Anthropic claudeAuth path:
 *
 *   Block 1 — STATIC_SUPERVISOR_PROMPT_TEMPLATE rendered with the user's name
 *             and preferred assistant name. Per-user-stable, cached `ephemeral.global`.
 *   Block 2 — formatUserContext() output (name / phone / address). Per-user-stable,
 *             cached `ephemeral.global`.
 *   Then the supervisor handler appends a user-role message with per-SMS env state.
 *
 * Mechanism: we emit `BLOCK1{BOUNDARY}BLOCK2` here; `markCacheable()` in the
 * caller appends ONE trailing boundary. The resulting two boundaries are
 * recognized by `transforms.ts` → `claudeAuth.ts` → multi-block cache logic
 * which marks each non-empty section globally cacheable. See
 * agents/providers/rose/claude_auth.py:_build_system_blocks for the source pattern.
 */
function assembleSystemPrompt(params: {
  userContextSection: string;
  userName: string;
  assistantName: string;
}): string {
  const { userContextSection, userName, assistantName } = params;

  const block1 = STATIC_SUPERVISOR_PROMPT_TEMPLATE.replace(
    /\{USER_ASSIGNED_ASSISTANT_NAME\}/g,
    assistantName
  ).replace(/\{USER_NAME\}/g, userName);

  const block2 = userContextSection.trim();

  return block2 ? `${block1}${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}${block2}` : block1;
}

/**
 * DYNAMIC per-SMS state — current datetime, agent hierarchy, pending attention
 * requests, recent visible messages. Injected as a `user`-role message before
 * the inbound user message so the static system prompt stays cache-stable.
 */
function assembleContextUserMessage(params: {
  hierarchySection: string;
  attentionSection: string;
  messagesSection: string;
}): string {
  const { hierarchySection, attentionSection, messagesSection } = params;
  return `Current state (as of ${new Date().toISOString()}):

${hierarchySection}

${attentionSection}

${messagesSection}`;
}
