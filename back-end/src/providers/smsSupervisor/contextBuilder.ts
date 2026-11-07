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
import { extractFingerprintTimeZone, formatUserTemporalContext } from './timeContext';
import { formatReplyTargetIndex } from './messageReply';
import { SMS_DELIVERY_INSTRUCTIONS } from '../smsDeliveryContract';

const log = createLogger('SmsContext');

// Cache boundary handling: the SMS supervisor system prompt reuses the main
// agent's three-block skeleton (agents/utils/prompts.py:build_system_prompt):
//
//   Block 1  ROSE_CORE            — universal, user-agnostic core prose, shared
//                                   byte-for-byte with the main agent. One
//                                   fleet-wide ephemeral.global cache block.
//   Block 2  # User Context       — per-user profile (name / phone / address).
//                                   Per-user ephemeral.global cache block.
//   Block 3  SMS_SURFACE_OVERLAY  — everything SMS-specific (surface framing,
//                                   grep grounding, input format, response
//                                   rules). User-agnostic; global cache block.
//
// Blocks are separated by SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinels; the call
// site (supervisorHandler.ts) wraps the result in `markCacheable()`, which
// appends one trailing boundary. claudeAuth.ts (buildAnthropicBody) then marks
// each non-empty section a globally-cached system block. Per-SMS dynamic state
// (datetime, hierarchy, attention requests, recent activity) is returned as
// `contextUserMessage`, then injected by the handler as a run-local
// get_environment tool result after the newest inbound SMS.

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

export interface UserProfileContext {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  deliveryRecipientName: string | null;
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
   * Volatile per-SMS state (agent hierarchy, pending attention requests,
   * recent visible messages, current datetime). The handler injects this as a
   * run-local get_environment tool result after the newest inbound SMS.
   */
  contextUserMessage: string;
  sessionHistory: CompletionMessage[];
}

/**
 * Build the full SMS supervisor context for a user.
 */
export async function buildSmsContext(
  userId: string,
  options: { excludeInboundSeq?: number } = {}
): Promise<SmsContext> {
  const startTime = Date.now();
  const currentInstant = new Date();

  log.info('[SmsContext] Building context', { userId });

  // Fetch all data in parallel
  const [rootAgents, attentionRequests, user, session, fingerprintIntegration] = await Promise.all([
    fetchAgentHierarchy(userId),
    fetchPendingAttentionRequests(userId),
    fetchUserProfile(userId),
    fetchSmsSession(userId),
    fetchBrowserFingerprint(userId),
  ]);
  const timeZone = extractFingerprintTimeZone(fingerprintIntegration?.config);

  log.info('[SmsContext] Fetched data', {
    userId,
    rootAgentCount: rootAgents.length,
    attentionRequestCount: attentionRequests.length,
    hasSession: !!session,
    hasTimeZone: timeZone !== null,
    timeZone: timeZone ?? undefined,
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

  // STATIC three-block system prompt (see module header):
  //   Block 1 ROSE_CORE — universal, user-agnostic (shared with the main agent)
  //   Block 2 # User Context — per-user profile (name / phone / address)
  //   Block 3 SMS_SURFACE_OVERLAY — SMS-specific surface + response rules
  // Per-SMS dynamic state stays out of all three (see contextUserMessage).
  const userContextSection = formatUserContext(user);
  const systemPrompt = assembleSystemPrompt({ userContextSection });

  // DYNAMIC: hierarchy, attention requests, recent activity, current datetime —
  // these change on every SMS and are injected after the newest inbound SMS
  // as the synthetic get_environment result.
  const hierarchySection = formatAgentHierarchy(rootAgents);
  const attentionSection = formatAttentionRequests(attentionRequests);
  const messagesSection = formatVisibleMessages(visibleMessages, rootAgents);
  const contextUserMessage =
    assembleContextUserMessage({
      currentUtcInstant: currentInstant.toISOString(),
      temporalContext: formatUserTemporalContext(currentInstant, timeZone),
      hierarchySection,
      attentionSection,
      messagesSection,
    }) + formatReplyTargetIndex(session?.messages, options.excludeInboundSeq);

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
          (m): m is { role: 'user' | 'assistant'; content: string; inboundSeq?: number } =>
            typeof m === 'object' &&
            m !== null &&
            ((m as Record<string, unknown>).role === 'user' ||
              (m as Record<string, unknown>).role === 'assistant') &&
            typeof (m as Record<string, unknown>).content === 'string' &&
            (options.excludeInboundSeq === undefined ||
              (m as Record<string, unknown>).inboundSeq !== options.excludeInboundSeq)
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

  return {
    systemPrompt,
    contextUserMessage,
    sessionHistory: sessionMessages,
  };
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
      email: true,
      phone: true,
      deliveryRecipientName: true,
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

async function fetchBrowserFingerprint(userId: string) {
  return prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'browser_fingerprint', accountId: '' } },
    select: { config: true },
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

export function formatUserContext(user: UserProfileContext | null): string {
  if (!user) return '';

  const parts = ['# User Context\n'];

  // Assistant name is per-user (the user's chosen `systemName`, default "Rose").
  // It lives here in the per-user Block 2 rather than the shared, user-agnostic
  // ROSE_CORE so Block 1 stays byte-identical across the whole fleet.
  const assistantName = user.systemName || 'Rose';
  parts.push(`You are the user's personal assistant; they have named you "${assistantName}".`);

  const personalInformation = [];
  if (user.name) personalInformation.push(`Full Name: ${user.name}`);
  if (user.phone) personalInformation.push(`Phone: ${user.phone}`);
  if (user.email) personalInformation.push(`Email: ${user.email}`);
  if (personalInformation.length > 0) {
    parts.push(`## Personal Information\n${personalInformation.join('\n')}`);
  }

  // Delivery address identity is independent from the account owner's identity.
  const addressParts = [user.addressLine1, user.addressLine2].filter(Boolean);
  const cityStateZip = [user.city, user.state, user.postalCode].filter(Boolean).join(', ');
  if (user.deliveryRecipientName || addressParts.length > 0 || cityStateZip) {
    const fullAddress = [
      user.deliveryRecipientName ? `Recipient Name: ${user.deliveryRecipientName}` : null,
      ...addressParts,
      cityStateZip,
      user.country,
    ]
      .filter(Boolean)
      .join('\n');
    parts.push(`## Delivery Address\n${fullAddress}`);
  } else {
    const locationParts = [user.city, user.state, user.country].filter(Boolean);
    if (locationParts.length > 0) {
      parts.push(`Location: ${locationParts.join(', ')}`);
    }
  }

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
 * Block 1 — Rose core. The universal, surface-agnostic prose shared byte-for-
 * byte with the main agent (agents/utils/prompts.py:MAIN_SYSTEM_PROMPT): the
 * seed/identity metaphor, the low-energy-COO / bias-to-action paragraph, and
 * the harness auto-escalation approval paragraph.
 *
 * MUST contain no per-user interpolation and no surface-specific text, so it is
 * byte-identical across every user AND matches the main agent's wording. That
 * makes it one fleet-wide `ephemeral.global` cache block on the claudeAuth path.
 * It is pinned to the Python source by
 * tests/structural/prompt-personality-sync.test.ts — edit both together.
 */
export const ROSE_CORE = `You are a Rose Labs Agent. A single agent in a massive network of agents that together form a super-intelligent system. Each agent, including you, is a nurturer of metaphysical seeds - the user plants a goal and your job
is to grow it to full fruition using the tools available to you.

Operate with the lowest energy expenditure possible. Each tool invocation consumes
human attention, social credibility, or monetary capital. Behave like a world-class COO: make reasonable assumptions, don't get blocked, move forward, MAJOR bias towards action. You specialize in real-world, long-horizon task execution. The task is not complete unless the goal is entirely accomplished with no further actions required from the user.

Irreversible, external, destructive, and privacy-sensitive actions 100% ARE allowed, that is because you are in a harness that automatically detects those behaviors and escalates them for human approval. This is to allow you to bias completely towards action with the confidence that an external entity will ensure any attempted actions are safe, asking for permission in this case is much worse than asking for forgiveness. In browser sessions the approval prompt fires when the browser agent clicks the final commit control itself (Place order, Pay, Send, Post, etc.), so when a task needs the user's approval first, tell the browser agent to carry the flow through that click and never tell it not to click.`;

/**
 * Block 3 — SMS surface overlay. Everything specific to running over SMS: the
 * surface framing, the `grep` grounding contract (the main agent's equivalent
 * names `spawn_agent(type="explore")`), the input/state-block format docs, and
 * the response rules. User-agnostic (no names, no per-SMS state), so it is a
 * globally-cacheable block just like Block 1.
 */
export const SMS_SURFACE_OVERLAY = `# Your Surface

You are responding over SMS. You receive SMS messages from the user and orchestrate massive agent networks to accomplish user goals. Be conversational but concise — this is texting, not email.

${SMS_DELIVERY_INSTRUCTIONS}

Context is available to you primarily through grep, this tool's purpose is to acquire factual information from the user's own data (every source its tool definition lists). Search it before asking the user for a fact about themselves or their plans (IDs, documents, addresses, contacts, past bookings); their synced data often has it. MANDATORY: All load-bearing information must be grounded by being retrieved from grep, web_search, the current state block, or because it came from a user.

# Your Inputs

For every user message, you will receive a timestamp and a state of the agent network you are managing at that time. Treat the state block as ground truth for "right now"; older session turns may reflect stale state.

Session history is the SMS transcript only (user texts and the bodies you previously sent with send_user_message). Tool calls from previous runs — start_new_agent, kill_agent, grep, web_search, reply_to_agent, and the rest — are erased from this context to save space. Do NOT assume a prior assistant turn was tool-free just because no tools appear beside it; those turns often called tools that are not shown here. Never reconstruct "what I must have done last time" from the SMS text alone. For what is true right now, trust the current state block and this run's tool results.

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

# How This Surface Works

One inbound SMS wakes you for one run. Inside a run you loop: you emit tool calls, the runtime executes them and hands the results back, and you go again. The run ends when you call argument-free attempt_completion(), or when the runtime stops you.

Who is speaking, mechanically:

- The human speaks to you exactly once per run: the inbound SMS that woke you. That is the only message in this conversation authored by a person.
- Everything else arriving mid-run — tool results, the state block, runtime instructions — comes back on the tool channel. It is the machine reporting to you, not the user sending another text.
- Session history is the real SMS thread. Its user turns are texts they actually typed; its assistant turns are texts their phone actually received.

Where your agents' messages come from: an agent you start owns its own channel to this same phone. The runtime texts the user directly when that agent starts, asks a question, needs an approval, hits its budget, and finishes. Those texts land in this thread without passing through you. You do see them: each arrives in this conversation, verbatim, as soon as it is sent. Treat every one as already read on the user's phone — saying it again sends them a second copy of something they already have. You are not the relay, and an agent making progress is not an event that needs a text from you.

What costs money: start_new_agent, increase_budget, and kill_agent are committed at the end of the run and change the real world — new agents bill against the user's balance, budget increases authorize more of their money to be spent, kills destroy in-flight work. Reads (grep, web_search, get_environment) are free and reversible; those three are not.

# How to Respond

Think step by step. Parallelize as many tool calls per turn as reasonable so you respond quickly with grounded, accurate answers.

- Respond to the user on your first turn, failing to respond quickly risks disengagement from the user.
- Be conversational but concise, this is texting, not email. Write the way the person you are texting writes.
- for details you want to double check with the user, make them extremely easy to parse, and include the defaults that you are assuming
- Reactions must attach to the original message. The runtime handles native WhatsApp reactions and silently discards SMS reaction calls. Never send a separate emoji-only acknowledgment as a substitute. Continue with a substantive reply when a native reaction is unavailable or fails.
- Never expose agent IDs, agent prefixes, attention request IDs, or shortcodes to the user. Use internal IDs only for tool calls.
- Resolve natural approval language against pending requests. If more than one pending request could match, ask a natural clarification.
- Do not send a placeholder such as "I'll check now" and then stop. If you send a progress message, keep working in the same run and send the substantive result before attempt_completion.
- If grep and web_search can't find information you need, escalate with start_new_agent instead of asking the user for it.`;

/**
 * Compose the three-block SMS supervisor system prompt:
 *
 *   ROSE_CORE  {BOUNDARY}  # User Context  {BOUNDARY}  SMS_SURFACE_OVERLAY
 *
 * `markCacheable()` at the call site appends ONE trailing boundary; claudeAuth's
 * `buildAnthropicBody` then splits on the boundaries and marks each non-empty
 * section a globally-cached system block (see the module header). When there is
 * no user profile, Block 2 is omitted and the layout collapses to two blocks.
 */
export function assembleSystemPrompt(params: { userContextSection: string }): string {
  const { userContextSection } = params;

  const block2 = userContextSection.trim();
  const blocks = block2
    ? [ROSE_CORE, block2, SMS_SURFACE_OVERLAY]
    : [ROSE_CORE, SMS_SURFACE_OVERLAY];

  return blocks.join(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
}

/**
 * DYNAMIC per-SMS state — current datetime, agent hierarchy, pending attention
 * requests, recent visible messages. Encoded as a synthetic get_environment
 * tool result after the inbound user message so the static prompt stays cached.
 */
function assembleContextUserMessage(params: {
  currentUtcInstant: string;
  temporalContext: string;
  hierarchySection: string;
  attentionSection: string;
  messagesSection: string;
}): string {
  const {
    currentUtcInstant,
    temporalContext,
    hierarchySection,
    attentionSection,
    messagesSection,
  } = params;
  const stateHeading = `Current state (as of ${currentUtcInstant}):\n\n${temporalContext}`;
  return `${stateHeading}

${hierarchySection}

${attentionSection}

${messagesSection}`;
}
