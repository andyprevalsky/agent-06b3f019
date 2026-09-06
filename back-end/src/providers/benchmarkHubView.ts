/**
 * Adapt a stored hub run bundle into the GET /agents detail/tree shapes.
 */
import {
  completionOutputsFromMessages,
  schemaFromCompletionOutputs,
  structuredFromCompletionOutputs,
} from './benchmarkHubOutputs';
import { BenchmarkHubUnavailableError } from './benchmarkHubErrors';
import {
  getRunBundleForAgentLookup,
  isHubRunVisible,
  type HubAgentView,
} from './benchmarkHubStore';

const TOOL_USAGE_TREE_KEYS = new Set([
  'root_agent_id',
  'agent_count',
  'tool_usage_count',
  'llm_call_count',
  'tokens_in',
  'tokens_out',
  'total_cost_cents',
  'total_cost_dollars',
  'total_tokens_from_tools',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
]);

function isAgentTreeNode(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return (
    Array.isArray(node.messages) ||
    'parent_agent_id' in node ||
    typeof node.goal === 'string' ||
    typeof node.status === 'string'
  );
}

/** Keep agent-id-keyed transcript nodes; drop `/api/tool-usage/tree` rollups. */
export function canonicalAgentTree(raw: unknown): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || TOOL_USAGE_TREE_KEYS.has(key) || !isAgentTreeNode(value)) continue;
    out[key] = value;
  }
  return out;
}

function frontendMessage(
  agentId: string,
  index: number,
  raw: Record<string, unknown>
): Record<string, unknown> {
  return {
    message_id: raw.message_id ?? `${agentId}-hub-message-${String(index).padStart(4, '0')}`,
    timestamp: raw.created_at ?? raw.timestamp ?? '',
    text: raw.message ?? raw.text ?? '',
    role: String(raw.role ?? 'ASSISTANT').toUpperCase(),
    metadata: raw.metadata ?? {},
    file_pointer: raw.file_pointer ?? null,
  };
}

function agentSummaryFromTask(
  task: Record<string, unknown>,
  agentId: string,
  messages: Array<Record<string, unknown>>,
  runTimestamp: string,
  parent: {
    parentAgentId: string | null;
    parentGoal: string | null;
    busId: string;
    goal: string;
    status: string;
  },
  node: Record<string, unknown> = {}
): Record<string, unknown> {
  const tokensIn = Number(node.tokens_in ?? task.tokens_in ?? 0);
  const tokensOut = Number(node.tokens_out ?? task.tokens_out ?? 0);
  const outputs = completionOutputsFromMessages(messages);
  return {
    agent_id: agentId,
    parent_agent_id: parent.parentAgentId,
    parent_goal: parent.parentGoal,
    busId: parent.busId,
    goal: parent.goal,
    model: 'benchmark-hub',
    source: parent.parentAgentId === null ? 'WEB' : 'AGENT',
    reasoning_effort: 'off',
    reasoning_max_tokens: null,
    progress: parent.status === 'COMPLETED' ? 100 : 0,
    status: parent.status,
    status_message: `Benchmark hub archive: ${String(task.name ?? '')}`,
    temporal_workflow_id: `benchmark-hub-${agentId}`,
    token_count: tokensIn + tokensOut,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: Number(node.context_size ?? task.context_size ?? 0),
    message_count: messages.length,
    price_limit_cents: 0,
    tree_cost_cents: Number(task.cost_cents ?? 0),
    fast_mode_cache_enabled: task.fast_mode_cache_enabled === true,
    token_in_price_microdollars: null,
    token_out_price_microdollars: null,
    created_at: runTimestamp,
    updated_at:
      messages.length > 0
        ? (messages[messages.length - 1].timestamp ?? runTimestamp)
        : runTimestamp,
    write_lock_enabled: true,
    structured_output:
      node.structured_output ??
      task.structured_output ??
      structuredFromCompletionOutputs(outputs) ??
      null,
    failure_context: null,
    verifier: null,
    tools: [],
    tools_in_use: [],
    response_schema:
      node.response_schema ?? task.response_schema ?? schemaFromCompletionOutputs(outputs) ?? null,
    benchmark_task: task.name ?? null,
    benchmark_duration_seconds: Number(task.duration_seconds ?? 0),
    benchmark_world_model_mode: task.world_model_mode ?? null,
  };
}

/**
 * When GET /tree?busId=<child> hits the hub, return that child plus its
 * descendants — not the full run tree. Live findAgentsByBusId filters on the
 * busId column; hub previously returned every node because getRunAgent always
 * attaches the root tree.
 */
export function subtreeAgentsForBus<T extends Record<string, unknown>>(
  tree: T[],
  busId: string
): T[] {
  if (!busId) return tree;
  const target = tree.find((node) => node.agent_id === busId);
  if (!target) return tree;
  const parent = target.parent_agent_id;
  const isRoot = typeof parent !== 'string' || parent === '' || parent === busId;
  if (isRoot) return tree;

  const childrenByParent = new Map<string, T[]>();
  for (const node of tree) {
    const parentId = typeof node.parent_agent_id === 'string' ? node.parent_agent_id : '';
    if (!parentId) continue;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(parentId, siblings);
  }

  const keep = new Set<string>([busId]);
  const stack = [busId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const child of childrenByParent.get(current) ?? []) {
      const childId = typeof child.agent_id === 'string' ? child.agent_id : '';
      if (!childId || keep.has(childId)) continue;
      keep.add(childId);
      stack.push(childId);
    }
  }
  return tree.filter((node) => typeof node.agent_id === 'string' && keep.has(node.agent_id));
}

/**
 * Adapt a run bundle to the frontend agent-detail shape for one agent in the
 * run (root or any sub-agent captured by logs.tree), plus the fan-out tree.
 */
export async function getRunAgent(runId: string, agentId: string): Promise<HubAgentView | null> {
  const visible = await isHubRunVisible(runId);
  if (visible === null) {
    throw new BenchmarkHubUnavailableError(
      'Benchmark Hub run visibility is temporarily unavailable; retry shortly'
    );
  }
  if (!visible) return null;
  const bundle = await getRunBundleForAgentLookup(runId);
  if (!bundle) return null;
  const runTimestamp = String(bundle.timestamp ?? '');
  const tasks = Array.isArray(bundle.tasks) ? (bundle.tasks as Array<Record<string, unknown>>) : [];

  for (const task of tasks) {
    const rootId = typeof task.agent_id === 'string' ? task.agent_id : '';
    if (!rootId) continue;
    const logs = (task.logs ?? {}) as Record<string, unknown>;
    const tree = canonicalAgentTree(logs.tree);
    const isRoot = agentId === rootId;
    const inTree = Object.prototype.hasOwnProperty.call(tree, agentId);
    if (!isRoot && !inTree) continue;

    const rootMessages = Array.isArray(logs.messages)
      ? (logs.messages as Array<Record<string, unknown>>)
      : [];
    const passedStatus = task.passed === true ? 'COMPLETED' : 'FAILED';

    const nodeInfo = (
      id: string
    ): {
      parent: string | null;
      goal: string;
      status: string;
      raw: Array<Record<string, unknown>>;
    } => {
      const info = tree[id] ?? {};
      const treeMessages = Array.isArray(info.messages)
        ? (info.messages as Array<Record<string, unknown>>)
        : [];
      const isRootNode = id === rootId;
      return {
        parent: isRootNode ? null : ((info.parent_agent_id as string | null) ?? rootId),
        goal:
          typeof info.goal === 'string' && info.goal
            ? info.goal
            : isRootNode
              ? String(
                  rootMessages.find((m) => String(m.role ?? '').toUpperCase() === 'USER')
                    ?.message ??
                    task.name ??
                    'benchmark task'
                )
              : 'sub-agent',
        status: String(info.status ?? (isRootNode ? passedStatus : 'COMPLETED')).toUpperCase(),
        raw: isRootNode && treeMessages.length === 0 ? rootMessages : treeMessages,
      };
    };

    const target = nodeInfo(agentId);
    const messages = target.raw.map((m, i) => frontendMessage(agentId, i, m));
    const parentGoal = target.parent === null ? null : nodeInfo(target.parent).goal;
    const agent = agentSummaryFromTask(
      task,
      agentId,
      messages,
      runTimestamp,
      {
        parentAgentId: target.parent,
        parentGoal,
        busId: rootId,
        goal: target.goal,
        status: target.status,
      },
      tree[agentId] ?? {}
    );

    const treeIds = new Set<string>([rootId, ...Object.keys(tree)]);
    const treeNodes = [...treeIds].map((id) => {
      const info = nodeInfo(id);
      return {
        agent_id: id,
        parent_agent_id: info.parent,
        goal: info.goal,
        status: info.status,
        progress: info.status === 'COMPLETED' ? 100 : 0,
        tools_in_use: [],
        message_count: info.raw.length,
        tree_cost_cents: id === rootId ? Number(task.cost_cents ?? 0) : 0,
        output_schema:
          (tree[id] ?? {}).response_schema ??
          (id === rootId ? task.response_schema : null) ??
          schemaFromCompletionOutputs(completionOutputsFromMessages(info.raw)) ??
          null,
        structured_output:
          (tree[id] ?? {}).structured_output ??
          (id === rootId ? task.structured_output : null) ??
          structuredFromCompletionOutputs(completionOutputsFromMessages(info.raw)) ??
          null,
        tokens_in: Number((tree[id] ?? {}).tokens_in ?? (id === rootId ? task.tokens_in : 0) ?? 0),
        tokens_out: Number(
          (tree[id] ?? {}).tokens_out ?? (id === rootId ? task.tokens_out : 0) ?? 0
        ),
      };
    });

    return { agent, messages, tree: treeNodes };
  }
  return null;
}
