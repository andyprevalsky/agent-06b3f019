/**
 * Realistic fixture rows for the agent UI gallery (dev only). Shapes mirror
 * what the backend posts: spawn rows under the original toolCallId, agent
 * message / completion rows keyed by `agentMessage` / `agentNotification`,
 * and agent tool rows (list_agents inside explore steps, send_message_to_agent,
 * kill_agent, wait_for agents mode). Agent message / completion bodies are Codex format.
 */
import type { AgentTreeNode, Message } from '@/lib/api';

const T0 = Date.UTC(2026, 9, 19, 15, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

let counter = 0;
function row(role: Message['role'], text: string, metadata: Record<string, unknown> = {}): Message {
  counter += 1;
  return { message_id: `gallery-${counter}`, timestamp: at(counter), role, text, metadata };
}

export function tool(toolName: string, metadata: Record<string, unknown>, text = ''): Message {
  return row('TOOL', text, {
    toolCallId: `call_${toolName}_${counter + 1}`,
    toolName,
    toolStatus: 'FINISHED',
    ...metadata,
  });
}

const BUDGET_SCHEMA = {
  fields: [
    { name: 'total_budget_usd', type: 'float', required: true, description: '' },
    { name: 'notes', type: 'str', required: true, description: '' },
  ],
};
const VENUE_SCHEMA = {
  fields: [
    { name: 'venue_name', type: 'str', required: true, description: '' },
    { name: 'capacity', type: 'int', required: true, description: '' },
  ],
};

function node(
  agentId: string,
  goal: string,
  status: AgentTreeNode['status'],
  extra: Partial<AgentTreeNode> = {},
): AgentTreeNode {
  return {
    agent_id: agentId,
    parent_agent_id: 'gallery-root',
    goal,
    status,
    progress: status === 'COMPLETED' ? 1 : 0.4,
    tools_in_use: [],
    message_count: 6,
    tree_cost_cents: 4,
    ...extra,
  };
}

/** Tree snapshots served for GET /agents/tree?busId=… (the real SubAgentTree data path). */
export const TREES: Record<string, AgentTreeNode[]> = {
  'bus-running': [
    node('gp-running', 'Draft outreach emails for the 3 shortlisted Austin venues', 'ACTIVE', {
      tools_in_use: ['web_search'],
    }),
  ],
  'bus-done': [
    node('gp-done', 'Draft a rough budget for 12 people for 2 days', 'COMPLETED', {
      output_schema: BUDGET_SCHEMA as AgentTreeNode['output_schema'],
      structured_output: {
        total_budget_usd: 5518,
        notes: 'Two hotel nights, meeting room, meals.',
      },
    }),
  ],
  'bus-failed': [
    node('gp-failed', 'Book a meeting room at Fair Market for Nov 14', 'FAILED', {
      failure_context: {
        trajectory: [{ tool_name: 'browser_agent', success: false, error_message: 'Login wall' }],
        progress_estimate: '40%',
        verifier_reasoning: 'Booking requires a signed-in venue account.',
        steps_taken: 7,
      },
    }),
  ],
  'bus-for-each': [
    node('fe-0', 'Row item:\nFair Market', 'COMPLETED', {
      output_schema: VENUE_SCHEMA as AgentTreeNode['output_schema'],
      structured_output: { venue_name: 'Fair Market', capacity: 900 },
    }),
    node('fe-1', 'Row item:\nBrazos Hall', 'COMPLETED', {
      output_schema: VENUE_SCHEMA as AgentTreeNode['output_schema'],
      structured_output: { venue_name: 'Brazos Hall', capacity: 500 },
    }),
    node('fe-2', 'Row item:\nMohawk Austin', 'ACTIVE', { tools_in_use: ['web_fetch'] }),
    node('fe-3', 'Row item:\nLustre Pearl', 'FAILED'),
  ],
};

function spawnRow(busId: string, ids: string[], toolName = 'spawn_general_purpose_agent') {
  return tool(toolName, { busId, subAgentIds: ids, spawnGroupId: busId });
}

export const SPAWNS = {
  running: spawnRow('bus-running', ['gp-running']),
  done: spawnRow('bus-done', ['gp-done']),
  failed: spawnRow('bus-failed', ['gp-failed']),
  forEach: spawnRow(
    'bus-for-each',
    ['fe-0', 'fe-1', 'fe-2', 'fe-3'],
    'spawn_general_purpose_agent_for_each',
  ),
};

/** Codex-format body: header lines + Payload (the UI shows only the payload). */
function codexBody(type: string, taskName: string, sender: string, payload: string): string {
  return `Message Type: ${type}\nTask name: ${taskName}\nSender: ${sender}\nPayload:\n${payload}`;
}

export const AGENT_MESSAGES = {
  user: row(
    'USER',
    codexBody('MESSAGE', 'outreach', '/root', 'Only contact venues in East Austin; skip downtown.'),
    {
      agentMessage: true,
      messageType: 'MESSAGE',
      fromAgentId: 'gallery-root',
      fromAgentPath: '/root',
      toAgentPath: '/root/outreach',
    },
  ),
};

const COMPLETION_TYPES: Record<string, string> = {
  completed: 'FINAL_ANSWER',
  failed: 'FAILED',
};

function completion(path: string, status: string, payload: string): Message {
  const messageType = COMPLETION_TYPES[status] ?? 'FINAL_ANSWER';
  return row('USER', codexBody(messageType, path.split('/').pop() ?? path, path, payload), {
    agentNotification: true,
    toolName: 'agent_notification',
    messageType,
    fromAgentAddress: path,
    fromAgentPath: path,
    toAgentPath: '/root',
    status,
  });
}

const TREE_TEXT = [
  'You are /root (depth 0). Address = first column; pass it to send_message_to_agent.',
  '▶ /root [YOU ARE HERE] agent ACTIVE: Plan the Austin offsite',
  '  - /root/budget_planner [your child] agent COMPLETED: Draft a rough budget…',
  '  - /root/venue_capacities_0 [your child] agent COMPLETED: Fair Market capacity',
  '  - /root/venue_capacities_1 [your child] agent ACTIVE: Brazos Hall capacity',
  '  - /root/outreach [your child] agent ACTIVE: Draft outreach emails',
  '  - /root/hotel_price [your task] explore running: Average Austin hotel price',
].join('\n');

const treeNode = (
  agentId: string,
  path: string,
  parent: string | null,
  status: string,
  goal: string,
  extra: Record<string, unknown> = {},
) => ({
  agent_id: agentId,
  path,
  parent_agent_id: parent,
  status,
  goal,
  type: 'agent',
  depth: path.split('/').length - 2,
  child_count: 0,
  active_child_count: 0,
  ...extra,
});

export const TOOL_CHIPS = {
  sendMessage: tool(
    'send_message_to_agent',
    {
      to: '/root/outreach',
      toAgentPath: '/root/outreach',
      message: 'Skip Mohawk; it is outdoors only.',
    },
    'Message sent to /root/outreach.',
  ),
  killAgent: tool(
    'kill_agent',
    { to: '/root/room_booking' },
    'Killed /root/room_booking (1 agent).',
  ),
  waitRunning: tool(
    'wait_for',
    {
      toolStatus: 'IN_PROGRESS',
      waitForMode: 'agents',
      agents: ['/root/outreach', '/root/budget_planner'],
      description: 'outreach and budget',
    },
    'Waiting up to 10m for /root/outreach, /root/budget_planner',
  ),
  waitWoken: tool(
    'wait_for',
    {
      waitForMode: 'agents',
      agents: ['/root/outreach', '/root/budget_planner'],
      wokenBy: 'agent_notification',
    },
    'Woken by agent finished (/root/budget_planner) after 2m.\nAgents:\n- /root/budget_planner COMPLETED\n- /root/outreach ACTIVE',
  ),
  failed: tool(
    'send_message_to_agent',
    { toolStatus: 'ERROR', title: 'send_message_to_agent failed' },
    'Message delivery failed: no agent at /root/typo.',
  ),
};

// ── Background spawns (new shape: rows under the ORIGINAL toolCallId with
// excludeFromModel; the model-facing "Started…" row is hidden) ─────────────

function started(callId: string, type: string, path: string, goal: string): Message {
  return row('TOOL', `Started ${type} agent in background. Address: ${path}.`, {
    toolCallId: callId,
    toolName: 'spawn_agent',
    toolStatus: 'FINISHED',
    hidden: true,
    runInBackground: true,
    backgroundAddress: path,
    backgroundPath: path,
    backgroundGoal: goal,
    backgroundAgentType: type,
  });
}

function live(callId: string, metadata: Record<string, unknown>, text = ''): Message {
  return row('TOOL', text, {
    toolCallId: callId,
    toolName: 'spawn_general_purpose_agent',
    toolStatus: 'IN_PROGRESS',
    excludeFromModel: true,
    ...metadata,
  });
}

function notified(callId: string, path: string, status: string, body: string): Message {
  const message = completion(path, status, body);
  return { ...message, metadata: { ...message.metadata, backgroundTaskId: callId } };
}

export function gpSpawn(
  callId: string,
  agentId: string,
  busId: string,
  status?: string,
): Message[] {
  const path = `/root/${callId.replace('call_', '')}`;
  const rows = [
    started(callId, 'general_purpose', path, 'Draft a rough budget for 12 people for 2 days'),
    live(callId, { busId, subAgentIds: [agentId], spawnGroupId: callId }),
  ];
  if (status) {
    rows.push(
      live(callId, {
        busId,
        subAgentIds: [agentId],
        spawnGroupId: callId,
        toolStatus: status === 'failed' ? 'ERROR' : 'FINISHED',
      }),
    );
    rows.push(notified(callId, path, status, `Budget agent ${status}.`));
  }
  return rows;
}

export function forEachSpawn(
  callId: string,
  busId: string,
  ids: string[],
  done = false,
): Message[] {
  const rows: Message[] = [
    started(callId, 'for_each', '/root/venue_capacities', 'Look up each venue capacity'),
    ...ids.map((id, idx) =>
      live(`${callId}:${idx}`, {
        busId,
        subAgentIds: [id],
        spawnGroupId: callId,
        forEachChild: true,
      }),
    ),
  ];
  if (done) {
    rows.push(
      notified(callId, '/root/venue_capacities', 'completed', 'Completed for_each for 4 items.'),
    );
  }
  return rows;
}

export function exploreSpawn(callId: string, state: 'running' | 'completed' | 'failed'): Message[] {
  const goal = 'Find the average Austin hotel price in November';
  const base = {
    toolCallId: callId,
    toolName: 'spawn_agent',
    excludeFromModel: true,
    agentType: 'explore',
    taskId: `task-${callId}`,
    fullGoal: goal,
  };
  const rows: Message[] = [
    started(callId, 'explore', '/root/hotel_price', goal),
    row('TOOL', goal, { ...base, toolStatus: 'IN_PROGRESS', title: 'Exploring' }),
    row('TOOL', 'Query: average Austin hotel price November', {
      ...base,
      toolName: 'web_search',
      toolStatus: state === 'running' ? 'IN_PROGRESS' : 'FINISHED',
      title: 'Searching the web',
    }),
  ];
  if (state !== 'running') {
    rows.push(
      row(
        'TOOL',
        state === 'failed'
          ? 'Explore failed: every source was paywalled.'
          : 'Average: **$164/night** (Kayak, Nov 2025).',
        { ...base, toolStatus: state === 'failed' ? 'ERROR' : 'FINISHED', title: goal },
      ),
    );
  }
  return rows;
}

export function browserSpawn(callId: string, state: 'completed' | 'failed'): Message[] {
  const goal = 'Check room availability on Peerspace';
  return [
    started(callId, 'browser', '/root/peerspace_check', goal),
    state === 'completed'
      ? row('TOOL', 'Fair Market is free on Nov 14 (hold until Friday).', {
          toolCallId: callId,
          toolName: 'spawn_browser_agent',
          toolStatus: 'FINISHED',
          excludeFromModel: true,
          action_type: 'task_complete',
          task_id: `task-${callId}`,
          title: 'Browser automation complete',
        })
      : row('TOOL', 'Browser automation failed: login wall on peerspace.com', {
          toolCallId: callId,
          toolName: 'spawn_browser_agent',
          toolStatus: 'ERROR',
          excludeFromModel: true,
          title: 'Browser automation failed',
        }),
  ];
}

export function taskSpawn(callId: string, type: string, state: 'running' | 'completed' | 'failed') {
  return exploreSpawn(callId, state).map((m) =>
    m.metadata?.runInBackground
      ? { ...m, metadata: { ...m.metadata, backgroundAgentType: type } }
      : m,
  );
}

const running = (id: string, goal: string, tools: string[] = []) =>
  node(id, goal, 'ACTIVE', { tools_in_use: tools });

Object.assign(TREES, {
  'bus-chips': [
    running('gp-running', 'Draft outreach emails', ['web_search']),
    TREES['bus-done'][0],
    TREES['bus-failed'][0],
    ...TREES['bus-for-each'],
    node('fe-d0', 'Row item:\nFair Market', 'COMPLETED'),
    node('fe-d1', 'Row item:\nBrazos Hall', 'COMPLETED'),
  ],
  'bus-dock-running': [
    running('d-1', 'Draft outreach emails', ['send_email']),
    running('d-2', 'Price check: Fair Market', ['web_search']),
    running('d-3', 'Price check: Brazos Hall'),
    { ...running('d-4', 'Draft venue A email', ['web_fetch']), parent_agent_id: 'd-1' },
  ],
  'bus-dock-mixed': [
    {
      ...running('m-1', 'Draft outreach emails', ['send_email']),
      output_schema: BUDGET_SCHEMA as AgentTreeNode['output_schema'],
    },
    node('m-4', 'Budget planner', 'COMPLETED', {
      output_schema: BUDGET_SCHEMA as AgentTreeNode['output_schema'],
      structured_output: { total_budget_usd: 5518, notes: 'Two hotel nights, meeting room.' },
    }),
    node('mf-0', 'Row item:\nFair Market', 'COMPLETED', {
      output_schema: VENUE_SCHEMA as AgentTreeNode['output_schema'],
      structured_output: { venue_name: 'Fair Market', capacity: 900 },
    }),
    node('mf-1', 'Row item:\nBrazos Hall', 'COMPLETED', {
      output_schema: VENUE_SCHEMA as AgentTreeNode['output_schema'],
      structured_output: { venue_name: 'Brazos Hall', capacity: 500 },
    }),
    {
      ...running('mf-2', 'Row item:\nMohawk Austin', ['web_fetch']),
      output_schema: VENUE_SCHEMA as AgentTreeNode['output_schema'],
    },
    node('mf-3', 'Row item:\nLustre Pearl', 'FAILED', {
      output_schema: VENUE_SCHEMA as AgentTreeNode['output_schema'],
    }),
  ],
  'bus-dock-done': [node('d-1', 'Draft outreach emails', 'COMPLETED')],
});

export function dockRows(busId: string, ids: string[], withExplore = true): Message[] {
  return [
    started('call_dock', 'general_purpose', '/root/outreach', 'Draft outreach emails'),
    live('call_dock', { busId, subAgentIds: ids, spawnGroupId: 'call_dock' }),
    ...(withExplore ? taskSpawn('call_dock_ex', 'explore', 'running') : []),
  ];
}

/** Mixed dock: GP agents with schemas, a for_each with a results table, an explore task. */
export function dockMixedRows(): Message[] {
  return [
    ...dockRows('bus-dock-mixed', ['m-1', 'm-4']),
    ...forEachSpawn('call_dock_fe', 'bus-dock-mixed', ['mf-0', 'mf-1', 'mf-2', 'mf-3']),
  ];
}

/**
 * An explore agent (owned by /root/outreach) whose steps include a list_agents
 * call: the explore task is the caller ("you are here"), its owner the parent.
 */
const EXPLORE_TREE = {
  self_agent_id: '/root/outreach/venue_scan',
  root_agent_id: 'a-root',
  caller_path: [
    {
      agent_id: 'a-root',
      path: '/root',
      goal: 'Plan the Austin offsite',
      status: 'ACTIVE',
      depth: 0,
    },
    {
      agent_id: 'a-outreach',
      path: '/root/outreach',
      goal: 'Draft outreach emails',
      status: 'ACTIVE',
      depth: 1,
    },
    {
      agent_id: '/root/outreach/venue_scan',
      path: '/root/outreach/venue_scan',
      goal: 'Scan venues',
      status: 'running',
      depth: 2,
    },
  ],
  node_path: [],
  nodes: [
    treeNode('a-root', '/root', null, 'ACTIVE', 'Plan the Austin offsite', {
      child_count: 3,
      active_child_count: 2,
    }),
    treeNode(
      'a-budget',
      '/root/budget_planner',
      'a-root',
      'COMPLETED',
      'Draft a rough budget for 12 people',
    ),
    treeNode(
      'a-outreach',
      '/root/outreach',
      'a-root',
      'ACTIVE',
      'Draft outreach emails for the shortlisted venues',
      { child_count: 1, active_child_count: 1 },
    ),
    treeNode(
      'a-draft-a',
      '/root/outreach/draft_fair_market',
      'a-outreach',
      'ACTIVE',
      'Draft email to Fair Market',
    ),
    {
      ...treeNode(
        '/root/outreach/venue_scan',
        '/root/outreach/venue_scan',
        'a-outreach',
        'running',
        'Scan venue websites for contact forms',
      ),
      type: 'explore',
    },
    treeNode(
      'a-venues',
      '/root/venue_capacities',
      'a-root',
      'ACTIVE',
      'Look up each venue capacity (for_each)',
      { child_count: 4, active_child_count: 1 },
    ),
  ],
  next_cursor: null,
};

export function exploreWithListAgents(): Message[] {
  const callId = 'call_venue_scan';
  const goal = 'Scan venue websites for contact forms';
  const base = {
    toolCallId: callId,
    excludeFromModel: true,
    agentType: 'explore',
    taskId: 'task-venue-scan',
    fullGoal: goal,
  };
  return [
    row('TOOL', goal, {
      ...base,
      toolName: 'spawn_agent',
      toolStatus: 'IN_PROGRESS',
      title: 'Exploring',
    }),
    row('TOOL', TREE_TEXT, {
      ...base,
      toolName: 'list_agents',
      toolStatus: 'FINISHED',
      title: 'Listed 6 agents',
      agentTree: EXPLORE_TREE,
    }),
    row('TOOL', 'Query: Fair Market Austin events contact', {
      ...base,
      toolName: 'web_search',
      toolStatus: 'IN_PROGRESS',
      title: 'Searching the web',
    }),
  ];
}
