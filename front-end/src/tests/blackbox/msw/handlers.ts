/**
 * Default MSW handlers for blackbox tests.
 * These return realistic happy-path responses for every API endpoint the frontend calls.
 * Individual tests override specific handlers for edge case testing.
 */
import { http, HttpResponse } from 'msw';

const API_BASE = 'http://localhost:3001/api';

function folderDto(params: Record<string, unknown>) {
  return {
    id: String(params.id ?? 'folder-1'),
    name: 'Folder',
    legacy_project_id: String(params.id ?? 'folder-1'),
    subfolders: [],
    github_repo: null,
    created_at: '2026-11-12T00:00:00.000Z',
    updated_at: '2026-11-12T00:00:00.000Z',
  };
}

export const handlers = [
  // Per-user UI: stock UI (nothing published) unless a test overrides it.
  http.get(`${API_BASE}/user-ui/active`, () => HttpResponse.json({ versionId: null })),
  http.get(`${API_BASE}/user-ui/versions`, () => HttpResponse.json({ versions: [] })),
  // Rose Desktop left bar groups agents by project; none unless a test overrides.
  http.get(`${API_BASE}/projects`, () => HttpResponse.json({ projects: [] })),
  http.get(`${API_BASE}/folders`, () => HttpResponse.json({ folders: [] })),
  // Folders are project aliases: create/rename take { name } only, never a repo.
  http.post(`${API_BASE}/folders`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (Object.keys(body).some((key) => key !== 'name') || name === '')
      return HttpResponse.json({ error: 'Invalid body' }, { status: 400 });
    return HttpResponse.json(
      {
        id: 'folder-1',
        name,
        legacy_project_id: 'folder-1',
        subfolders: [],
        github_repo: null,
        created_at: '2026-11-12T00:00:00.000Z',
        updated_at: '2026-11-12T00:00:00.000Z',
      },
      { status: 201 },
    );
  }),
  http.get(`${API_BASE}/folders/:id`, ({ params }) => HttpResponse.json(folderDto(params))),
  http.patch(`${API_BASE}/folders/:id`, ({ params }) => HttpResponse.json(folderDto(params))),
  http.delete(`${API_BASE}/folders/:id`, () => new HttpResponse(null, { status: 204 })),
  // Project settings mints a one-time `rose agent-init` code on open.
  http.post(`${API_BASE}/projects/cli-login-codes`, () =>
    HttpResponse.json(
      {
        code: 'rlc_defaultdefaultdefaultdefaultdefa',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        project: null,
      },
      { status: 201 },
    ),
  ),
  // Rose profile (left-bar account row name, Settings): no name unless a test overrides.
  http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({})),
  // Rose Desktop Integrations icon reads integration health; nothing connected by default.
  http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations: [] })),
  http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
  http.get(`${API_BASE}/integrations/github/repos`, () => HttpResponse.json({ repos: [] })),
  http.post(`${API_BASE}/integrations/github/repos`, () =>
    HttpResponse.json(
      { error: 'GITHUB_ACCESS_DENIED', message: 'No default GitHub repo mock' },
      { status: 403 },
    ),
  ),
  http.delete(`${API_BASE}/integrations/github/repos/:ref`, () =>
    HttpResponse.json(
      { error: 'GITHUB_REPO_NOT_CONNECTED', message: 'Repo not connected' },
      { status: 404 },
    ),
  ),
  http.get(`${API_BASE}/integrations/granola`, () =>
    HttpResponse.json({
      connected: false,
      status: 'NOT_CONNECTED',
      accountEmail: null,
      backfillDone: false,
      lastSuccessfulSyncAt: null,
      lastError: null,
      documents: {},
    }),
  ),
  http.get(`${API_BASE}/integrations/fireflies`, () =>
    HttpResponse.json({
      connected: false,
      status: 'NOT_CONNECTED',
      accountEmail: null,
      backfillDone: false,
      lastSuccessfulSyncAt: null,
      lastError: null,
      documents: {},
    }),
  ),
  // Cloud iPhone is account-gated; no assigned phone unless a test overrides it.
  http.get(`${API_BASE}/iphone/connection`, () =>
    HttpResponse.json({
      enabled: false,
      configured: false,
      status: 'not_connected',
      setupAgentId: null,
      connectionRevision: 0,
    }),
  ),
  // Device view (Phone app default): no enabled phone unless a test overrides it.
  http.get(`${API_BASE}/iphone/device`, () =>
    HttpResponse.json({
      enabled: false,
      setupState: 'not_connected',
      providerState: 'IDLE',
      holder: null,
      waiting: [],
    }),
  ),
  http.get(`${API_BASE}/iphone/device/frame`, () =>
    HttpResponse.json({ error: 'Phone is not running', state: 'IDLE' }, { status: 409 }),
  ),
  // L-INTEG-CORE cheap progress poll: nothing changed unless a test overrides.
  http.get(`${API_BASE}/integrations/progress`, () =>
    HttpResponse.json({ cursor: '2026-10-20T00:00:00.000Z', changed: false }),
  ),
  // No persisted binding by default: live views fall back to the transcript URL.
  http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, () =>
    HttpResponse.json({ error: 'Session not found' }, { status: 404 }),
  ),
  http.get(`${API_BASE}/browser-session/task/:taskId/control`, () =>
    HttpResponse.json({ state: 'agent', agentPaused: false }),
  ),
  http.post(`${API_BASE}/browser-session/task/:taskId/control`, async ({ request }) => {
    const body = (await request.json()) as { mode?: string };
    return HttpResponse.json({
      state: body.mode === 'user' ? 'user' : 'agent',
      agentPaused: false,
    });
  }),
  // Browser world (A6): Root browser closed, no Root sites, no agent forks by default.
  http.get(`${API_BASE}/browser-world/root`, () => HttpResponse.json({ root: null, sites: [] })),
  http.get(`${API_BASE}/browser-world/sites`, () => HttpResponse.json({ sites: [] })),
  http.get(`${API_BASE}/browser-world/agents/:agentId`, ({ params }) =>
    HttpResponse.json({ agent_id: params.agentId, tasks: [] }),
  ),
  // Auth endpoints
  http.post(`${API_BASE}/auth/anonymous`, () => {
    return HttpResponse.json({
      user: { id: 'anon-user-001' },
      session: {
        access_token: 'test-anon-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
      },
    });
  }),

  http.post(`${API_BASE}/auth/send-otp`, () => {
    return HttpResponse.json({ success: true });
  }),

  http.post(`${API_BASE}/auth/verify-otp`, () => {
    return HttpResponse.json({
      user: { id: 'verified-user-001', phone: '+19729777432' },
      session: {
        access_token: 'test-verified-token',
        refresh_token: 'test-verified-refresh',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
      },
    });
  }),

  // Models endpoint
  http.get(`${API_BASE}/models`, () => {
    return HttpResponse.json({
      models: [
        { id: 'rose-1-flash', name: 'Rose 1 Flash', provider: 'rose', description: 'Fast model' },
        {
          id: 'rose-1-ultra',
          name: 'Rose 1 Ultra',
          provider: 'rose',
          description: 'Powerful model',
        },
      ],
    });
  }),

  // Tools endpoint
  http.get(`${API_BASE}/tools`, () => {
    return HttpResponse.json({
      tools: [
        { id: 'web-search', name: 'Web Search', description: 'Search the web' },
        { id: 'web-fetch', name: 'Web Fetch', description: 'Fetch a webpage' },
      ],
    });
  }),

  // Development-only prompt catalog mounted by Terminal's query box
  http.get(`${API_BASE}/benchmarks/test-prompts`, () => {
    return HttpResponse.json({ prompts: [] });
  }),

  // Claude/Codex code-agent session fetch (chip closed-session fallback polls these)
  http.get(`${API_BASE}/claude-code-session/:taskId`, () => {
    return HttpResponse.json({ status: 'RUNNING', output: '' });
  }),
  http.get(`${API_BASE}/codex-session/:taskId`, () => {
    return HttpResponse.json({ status: 'RUNNING', output: '' });
  }),
  http.get(`${API_BASE}/benchmarks/claude-code-session-preview/:taskId`, () => {
    return HttpResponse.json({ status: 'RUNNING', output: '' });
  }),

  // Agents endpoints
  http.get(`${API_BASE}/agents`, () => {
    return HttpResponse.json({
      agents: [
        {
          agent_id: 'agent-001',
          goal: 'Test agent',
          model: 'rose-1-flash',
          source: 'WEB',
          reasoning_effort: 'medium',
          progress: 50,
          status: 'ACTIVE',
          status_message: null,
          temporal_workflow_id: 'wf-001',
          token_count: 1000,
          tokens_in: 800,
          tokens_out: 200,
          tool_tokens_in: 0,
          tool_tokens_out: 0,
          tool_cost_cents: 0,
          context_size: 4096,
          message_count: 5,
          price_limit_cents: 100,
          tree_cost_cents: 10,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:01:00Z',
          write_lock_enabled: false,
        },
      ],
    });
  }),

  // Sidebar search returns only server-side matches. Components union these
  // with their already-loaded list so title/goal matches remain instantaneous.
  http.get(`${API_BASE}/agents/search`, () => {
    return HttpResponse.json({ agents: [] });
  }),

  // Rose left bar: batched code agents of the listed trees (before /agents/:agentId).
  http.get(`${API_BASE}/agents/code-agents`, () => {
    return HttpResponse.json({ code_agents: [] });
  }),

  http.get(`${API_BASE}/agents/:agentId`, ({ params }) => {
    return HttpResponse.json({
      agent: {
        agent_id: params.agentId,
        goal: 'Test agent',
        model: 'rose-1-flash',
        source: 'WEB',
        reasoning_effort: 'medium',
        progress: 50,
        status: 'ACTIVE',
        status_message: null,
        temporal_workflow_id: 'wf-001',
        token_count: 1000,
        tokens_in: 800,
        tokens_out: 200,
        tool_tokens_in: 0,
        tool_tokens_out: 0,
        tool_cost_cents: 0,
        context_size: 4096,
        message_count: 2,
        price_limit_cents: 100,
        tree_cost_cents: 10,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:01:00Z',
        write_lock_enabled: false,
        parent_agent_id: null,
        parent_goal: null,
        verifier: null,
        tools: [],
      },
      messages: [
        {
          message_id: 'msg-001',
          timestamp: '2026-01-01T00:00:00Z',
          text: 'Starting agent...',
          role: 'SYSTEM',
        },
        {
          message_id: 'msg-002',
          timestamp: '2026-01-01T00:00:01Z',
          text: 'Working on your task.',
          role: 'ASSISTANT',
        },
      ],
      pagination: {
        has_more: false,
        oldest_timestamp: null,
      },
    });
  }),

  http.post(`${API_BASE}/agents`, () => {
    return HttpResponse.json({
      agent_id: 'new-agent-001',
      goal: 'New test agent',
      model: 'rose-1-flash',
      source: 'WEB',
      reasoning_effort: 'medium',
      progress: 0,
      status: 'STARTING_UP',
      status_message: null,
      temporal_workflow_id: 'wf-new-001',
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      tool_tokens_in: 0,
      tool_tokens_out: 0,
      tool_cost_cents: 0,
      context_size: 0,
      message_count: 0,
      price_limit_cents: 100,
      tree_cost_cents: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      write_lock_enabled: false,
    });
  }),

  http.post(`${API_BASE}/agents/:agentId/messages`, () => {
    return HttpResponse.json({
      message_id: 'msg-new-001',
      timestamp: new Date().toISOString(),
      text: 'Message received',
      role: 'USER',
    });
  }),

  http.delete(`${API_BASE}/agents/:agentId`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE}/agents/:agentId/pause`, () => {
    return HttpResponse.json({ success: true });
  }),

  http.post(`${API_BASE}/agents/:agentId/resume`, () => {
    return HttpResponse.json({ success: true });
  }),

  http.patch(`${API_BASE}/agents/:agentId`, () => {
    return HttpResponse.json({ agent: {} });
  }),

  http.post(`${API_BASE}/agents/:agentId/start-agent`, () => {
    return HttpResponse.json({ success: true });
  }),

  // Attention requests
  http.get(`${API_BASE}/attention-requests`, () => {
    return HttpResponse.json({ requests: [] });
  }),

  // Pinned question answer (agent-tools questionService.answerQuestion RequestState)
  http.post(
    `${API_BASE}/agents/:agentId/questions/:questionId/answer`,
    async ({ params, request }) => {
      const body = (await request.json()) as { answer?: string; dismiss?: boolean };
      return HttpResponse.json({
        id: String(params.questionId),
        kind: 'question',
        status: body.dismiss === true ? 'rejected' : 'answered',
        response: body.dismiss === true ? null : (body.answer ?? null),
        selected_option: null,
        answered_by: 'user',
      });
    },
  ),

  http.post(`${API_BASE}/attention-requests/:requestId/respond`, () => {
    return HttpResponse.json({ success: true });
  }),

  http.post(`${API_BASE}/attention-requests/:requestId/skip`, () => {
    return HttpResponse.json({ success: true });
  }),

  http.post(`${API_BASE}/attention-requests/:requestId/reject`, () => {
    return HttpResponse.json({ success: true });
  }),

  // Invite codes
  http.get(`${API_BASE}/invite-codes/my-code`, () => {
    return HttpResponse.json({
      inviteCode: 123456,
      uses: 3,
      usesRemaining: 7,
    });
  }),

  http.post(`${API_BASE}/invite-codes/use`, () => {
    return HttpResponse.json({ success: true, message: 'Invite code applied' });
  }),

  http.get(`${API_BASE}/invite-codes/check`, () => {
    return HttpResponse.json({ needsInviteCode: false });
  }),

  // People / Network
  http.get(`${API_BASE}/people`, () => {
    return HttpResponse.json({
      people: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
  }),

  // Tree state
  http.get(`${API_BASE}/agents/tree`, () => {
    return HttpResponse.json({ agents: [], code_agents: [] });
  }),

  http.get(`${API_BASE}/agents/:agentId/ancestors`, () => {
    return HttpResponse.json({ ancestors: [] });
  }),

  // Blueprints
  http.get(`${API_BASE}/blueprints/by-goal`, () => {
    return new HttpResponse(null, { status: 404 });
  }),

  // Upload
  http.post(`${API_BASE}/upload`, () => {
    return HttpResponse.json({
      file_pointer: {
        id: 'file-001',
        storage_path: 'uploads/test/file.txt',
        original_filename: 'file.txt',
        mime_type: 'text/plain',
        size_bytes: 100,
        created_at: new Date().toISOString(),
      },
    });
  }),

  // Credits/usage
  http.get(`${API_BASE}/credits/usage`, () => {
    return HttpResponse.json({
      used: 0,
      limit: 1000,
      remaining: 1000,
    });
  }),

  // Generate LLM judge prompt
  http.post(`${API_BASE}/generate-llm-judge-prompt`, () => {
    return HttpResponse.json({ prompt: 'Test LLM judge prompt' });
  }),

  // Signal endpoints
  http.post(`${API_BASE}/agents/:agentId/signal/signup_completed`, () => {
    return HttpResponse.json({ success: true });
  }),

  http.post(`${API_BASE}/agents/:agentId/signal/signup_dismissed`, () => {
    return HttpResponse.json({ success: true });
  }),
];
