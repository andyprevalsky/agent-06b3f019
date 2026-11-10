/** Shared fixtures for code-session sidebar rows; no test registration. */
import { http, HttpResponse } from 'msw';
import type { Agent, AttentionRequest } from '@/lib/api';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { makeAgent } from './app-sidebar.fixtures';
import { server } from './msw/server';

const API_BASE = 'http://localhost:3001/api';

export const RUNNING = { status: 'ACTIVE' as const, temporal_workflow_id: 'wf-1' };
export const createdMinutesAgo = (minutes: number) => ({
  created_at: new Date(Date.parse('2026-10-20T12:00:00Z') - minutes * 60_000).toISOString(),
});
export const AGENTS = [
  makeAgent({ agent_id: 'home-run', goal: 'Plan Tahoe trip', ...RUNNING, ...createdMinutesAgo(1) }),
  makeAgent({
    agent_id: 'home-done',
    goal: 'Get me socks',
    status: 'COMPLETED',
    ...createdMinutesAgo(2),
  }),
  makeAgent({
    agent_id: 'rose-run',
    goal: 'Rose UI polish',
    ...RUNNING,
    project_id: 'p-rose',
    ...createdMinutesAgo(3),
  }),
  makeAgent({
    agent_id: 'rose-fail',
    goal: 'Fix Hub export retry',
    status: 'FAILED',
    project_id: 'p-rose',
    ...createdMinutesAgo(4),
  }),
  makeAgent({
    agent_id: 'habits-done',
    goal: 'Streak widget',
    status: 'COMPLETED',
    project_id: 'p-habits',
    ...createdMinutesAgo(5),
  }),
  makeAgent({
    agent_id: 'orphan',
    goal: 'Unknown project agent',
    ...RUNNING,
    project_id: 'gone',
    ...createdMinutesAgo(6),
  }),
];

export function codeAgent(
  overrides: Partial<CodeAgentListItem> & { code_agent_id: string },
): CodeAgentListItem {
  return {
    owner_agent_id: 'home-run',
    root_agent_id: 'home-run',
    provider: 'claude',
    title: 'Write the export retry',
    status: 'ACTIVE',
    created_at: '2026-10-20T11:00:00.000Z',
    ...overrides,
  };
}

export function mockCodeAgents(rows: CodeAgentListItem[]) {
  server.use(
    http.get(`${API_BASE}/agents/code-agents`, ({ request }) => {
      const raw = new URL(request.url).searchParams.get('root_ids') ?? '';
      const ids = raw.split(',').filter(Boolean);
      if (ids.length === 0 || ids.length > 50) {
        return HttpResponse.json({ error: 'root_ids must list 1-50 agent ids' }, { status: 400 });
      }
      const roots = new Set(ids);
      return HttpResponse.json({
        code_agents: rows.filter((row) => roots.has(row.root_agent_id)).slice(0, 500),
      });
    }),
  );
}

/** The attention row agent-tools writes for a code agent's question (questionService). */
export function codeAgentQuestion(taskId: string, answered = false): AttentionRequest {
  return {
    id: `atq_${taskId}`,
    agent_id: 'home-run',
    workflow_id: 'wf-1',
    question: 'Ship the 26px button?',
    metadata: {
      agentTools: { kind: 'question', deliverTo: 'user', routedAgentId: 'home-run' },
      requestingAgent: {
        kind: 'code_agent',
        agent_id: 'home-run',
        label: 'Claude Code',
        provider: 'claude',
        task_id: taskId,
      },
      sandboxTool: { provider: 'claude', taskId },
    },
    created_at: '2026-10-20T11:30:00.000Z',
    updated_at: '2026-10-20T11:30:00.000Z',
    answered,
  };
}

export function bulkAgents(count: number, overrides: (i: number) => Partial<Agent> = () => ({})) {
  return Array.from({ length: count }, (_, i) =>
    makeAgent({
      agent_id: `bulk-${i}`,
      goal: `Bulk ${i}`,
      status: 'COMPLETED',
      ...createdMinutesAgo(i + 1),
      ...overrides(i),
    }),
  );
}

export const ROWS = [
  codeAgent({
    code_agent_id: 'cc-fix',
    provider: 'codex',
    status: 'ERROR',
    title: 'Fix flaky test',
  }),
  codeAgent({
    code_agent_id: 'cc-build',
    provider: 'claude',
    title: 'Build the widget',
    created_at: '2026-10-20T10:00:00.000Z',
  }),
  // Owned by a sub-agent of rose-run: listed under its root row; provider null = legacy → Claude.
  codeAgent({
    code_agent_id: 'cc-sub',
    owner_agent_id: 'rose-sub',
    root_agent_id: 'rose-run',
    provider: null,
    status: 'COMPLETED',
    title: 'Refactor nav',
  }),
];
