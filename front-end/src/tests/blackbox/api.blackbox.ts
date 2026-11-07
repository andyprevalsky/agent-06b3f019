/* eslint-disable max-lines */
/**
 * Blackbox tests for src/lib/api.ts
 *
 * Focuses on exercising the major branches of each exported fetch wrapper:
 *   happy path (2xx) — returns parsed body
 *   error path (non-2xx) — throws with either error.error, error.details, or a default
 *   auth guard — getAuthHeaders() throws 'Not authenticated' when no session
 *
 * MSW handlers (src/tests/blackbox/msw/handlers.ts) cover most routes; a few
 * endpoints (tree, ancestors, blueprint feedback, pagination-before) register
 * additional handlers inline via server.use().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import {
  getAllAgents,
  getAgent,
  createAgent,
  postMessage,
  uploadAttachment,
  getAttachmentUrl,
  deleteAgent,
  generateLLMJudgePrompt,
  getTools,
  pauseAgent,
  resumeAgent,
  updateAgent,
  hasActiveAttentionRequest,
  checkAndRespondToAttentionRequest,
  respondToAttentionRequest,
  skipAttentionRequest,
  rejectAttentionRequest,
  getMyInviteCode,
  useInviteCode,
  checkNeedsInviteCode,
  getPeople,
  signalSignupCompleted,
  signalSignupDismissed,
  startAgent,
  fetchTreeState,
  fetchAncestors,
  findBlueprintByGoal,
  submitBlueprintFeedback,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
} from '@/lib/api';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

describe('api.ts', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────
  describe('exported constants', () => {
    it('MAX_FILE_SIZE is 20MB', () => {
      expect(MAX_FILE_SIZE).toBe(20 * 1024 * 1024);
    });
    it('MAX_TOTAL_ATTACHMENTS_SIZE is 100MB', () => {
      expect(MAX_TOTAL_ATTACHMENTS_SIZE).toBe(100 * 1024 * 1024);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Auth guard
  // ─────────────────────────────────────────────────────────────────────
  describe('auth guard', () => {
    it('throws "Not authenticated" when no session', async () => {
      localStorage.clear();
      await expect(getAllAgents()).rejects.toThrow('Not authenticated');
    });

    it('throws "Not authenticated" in createAgent too', async () => {
      localStorage.clear();
      await expect(createAgent({ goal: 'x' })).rejects.toThrow('Not authenticated');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getAllAgents
  // ─────────────────────────────────────────────────────────────────────
  describe('getAllAgents', () => {
    it('returns the agents array on 200', async () => {
      const agents = await getAllAgents();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThan(0);
      expect(agents[0].agent_id).toBe('agent-001');
    });

    it('throws on non-2xx', async () => {
      server.use(
        http.get(`${API_BASE}/agents`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
      );
      await expect(getAllAgents()).rejects.toThrow('Failed to fetch agents');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getAgent
  // ─────────────────────────────────────────────────────────────────────
  describe('getAgent', () => {
    it('returns agent + messages on success', async () => {
      const result = await getAgent('agent-001');
      expect(result.agent.agent_id).toBe('agent-001');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.pagination).toBeDefined();
    });

    it('includes ?before= query when provided', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/agents/:agentId`, ({ request, params }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            agent: { agent_id: params.agentId },
            messages: [],
            pagination: { has_more: false, oldest_timestamp: null },
          });
        }),
      );
      await getAgent('agent-001', '2026-01-01T00:00:00Z');
      expect(capturedUrl).toContain('before=2026-01-01T00:00:00Z');
    });

    it('hydrates response_schema from Task Complete outputs when Hub omits it', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json({
            agent: {
              agent_id: 'a3dc7669-1b6d-4858-a6b8-5bb4b22c99dc',
              response_schema: null,
            },
            messages: [
              {
                message_id: 'final',
                timestamp: '2026-08-27T00:00:00Z',
                text: '',
                role: 'TOOL',
                metadata: {
                  isFinalSummary: true,
                  completionSummary: {
                    summary: 'Completed a 50-creator competitive analysis.',
                    outputs: [
                      {
                        key: 'positioning_statement',
                        label: 'Positioning Statement',
                        value: 'Engineer approach to longevity',
                      },
                      {
                        key: 'top_creators_analysis',
                        label: 'Top Creators Analysis',
                        value: '1. Andrew Huberman',
                      },
                    ],
                  },
                },
              },
            ],
            pagination: { has_more: false, oldest_timestamp: null },
          }),
        ),
      );
      const result = await getAgent('a3dc7669-1b6d-4858-a6b8-5bb4b22c99dc');
      expect(result.agent.response_schema?.fields.map((field) => field.name)).toEqual([
        'positioning_statement',
        'top_creators_analysis',
      ]);
    });

    it('throws on failure', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json({ error: 'nope' }, { status: 404 }),
        ),
      );
      await expect(getAgent('missing')).rejects.toThrow('Failed to fetch agent');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // createAgent
  // ─────────────────────────────────────────────────────────────────────
  describe('createAgent', () => {
    it('posts the goal and returns the created agent', async () => {
      const agent = await createAgent({ goal: 'do stuff' });
      expect(agent.agent_id).toBe('new-agent-001');
    });

    it('defaults source to WEB when not provided', async () => {
      let capturedBody: unknown = null;
      server.use(
        http.post(`${API_BASE}/agents`, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ agent_id: 'a' });
        }),
      );
      await createAgent({ goal: 'x' });
      expect((capturedBody as { source: string }).source).toBe('WEB');
    });

    it('preserves explicit source', async () => {
      let capturedBody: unknown = null;
      server.use(
        http.post(`${API_BASE}/agents`, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({ agent_id: 'a' });
        }),
      );
      await createAgent({ goal: 'x', source: 'MAC_APP' });
      expect((capturedBody as { source: string }).source).toBe('MAC_APP');
    });

    it('throws with server error.error when available', async () => {
      server.use(
        http.post(`${API_BASE}/agents`, () =>
          HttpResponse.json({ error: 'Invalid goal' }, { status: 400 }),
        ),
      );
      await expect(createAgent({ goal: 'bad' })).rejects.toThrow('Invalid goal');
    });

    it('throws default error when server returns no error field', async () => {
      server.use(http.post(`${API_BASE}/agents`, () => HttpResponse.json({}, { status: 500 })));
      await expect(createAgent({ goal: 'bad' })).rejects.toThrow('Failed to create agent');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // postMessage
  // ─────────────────────────────────────────────────────────────────────
  describe('postMessage', () => {
    it('posts message without attachments', async () => {
      let capturedBody: unknown = null;
      server.use(
        http.post(`${API_BASE}/agents/:agentId/messages`, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            message_id: 'm1',
            timestamp: '2026-01-01T00:00:00Z',
            text: 'hi',
            role: 'USER',
          });
        }),
      );
      const msg = await postMessage('agent-001', 'hi');
      expect(msg.message_id).toBe('m1');
      const body = capturedBody as { message: string; attachments?: unknown[] };
      expect(body.message).toBe('hi');
      expect(body.attachments).toBeUndefined();
    });

    it('includes attachments when provided', async () => {
      let capturedBody: unknown = null;
      server.use(
        http.post(`${API_BASE}/agents/:agentId/messages`, async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            message_id: 'm2',
            timestamp: '2026-01-01T00:00:00Z',
            text: 'hi',
            role: 'USER',
          });
        }),
      );
      await postMessage('agent-001', 'hi', [
        {
          id: 'f1',
          storage_path: 'p/f.txt',
          original_filename: 'f.txt',
          mime_type: 'text/plain',
          size_bytes: 10,
          created_at: '2026-01-01T00:00:00Z',
        },
      ]);
      const body = capturedBody as { attachments: unknown[] };
      expect(Array.isArray(body.attachments)).toBe(true);
      expect(body.attachments.length).toBe(1);
    });

    it('throws server error.error', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/messages`, () =>
          HttpResponse.json({ error: 'Blocked' }, { status: 403 }),
        ),
      );
      await expect(postMessage('a', 'm')).rejects.toThrow('Blocked');
    });

    it('throws default error when no error field', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/messages`, () =>
          HttpResponse.json({}, { status: 500 }),
        ),
      );
      await expect(postMessage('a', 'm')).rejects.toThrow('Failed to post message');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // uploadAttachment (XHR-based)
  // ─────────────────────────────────────────────────────────────────────
  describe('uploadAttachment', () => {
    it('throws when no session', async () => {
      localStorage.clear();
      const file = new File(['hi'], 'hi.txt', { type: 'text/plain' });
      await expect(uploadAttachment(file)).rejects.toThrow('Not authenticated');
    });

    it('uploads successfully and returns file pointer', async () => {
      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
      const ptr = await uploadAttachment(file);
      expect(ptr.id).toBe('file-001');
      expect(ptr.original_filename).toBe('file.txt');
    });

    it('rejects on server error with error.error', async () => {
      server.use(
        http.post(`${API_BASE}/upload`, () =>
          HttpResponse.json({ error: 'too big' }, { status: 413 }),
        ),
      );
      const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
      await expect(uploadAttachment(file)).rejects.toThrow('too big');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getAttachmentUrl
  // ─────────────────────────────────────────────────────────────────────
  describe('getAttachmentUrl', () => {
    it('returns signed_url on success', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, () =>
          HttpResponse.json({ signed_url: 'https://signed.example/file' }),
        ),
      );
      const url = await getAttachmentUrl('a', 'f', 'path/f.txt');
      expect(url).toBe('https://signed.example/file');
    });

    it('URL-encodes the storage_path', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ signed_url: 'ok' });
        }),
      );
      await getAttachmentUrl('a', 'f', 'path with spaces/f.txt');
      expect(capturedUrl).toContain('path%20with%20spaces');
    });

    it('throws on non-2xx', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, () =>
          HttpResponse.json({ error: 'no' }, { status: 404 }),
        ),
      );
      await expect(getAttachmentUrl('a', 'f', 'p')).rejects.toThrow(/Failed to get attachment URL/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // deleteAgent / pauseAgent / resumeAgent / startAgent
  // ─────────────────────────────────────────────────────────────────────
  describe('simple POST/DELETE wrappers', () => {
    it('deleteAgent resolves on 204', async () => {
      await expect(deleteAgent('a')).resolves.toBeUndefined();
    });

    it('deleteAgent throws on failure', async () => {
      server.use(
        http.delete(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json({ error: 'nope' }, { status: 500 }),
        ),
      );
      await expect(deleteAgent('a')).rejects.toThrow('Failed to delete agent');
    });

    it('pauseAgent resolves on success', async () => {
      await expect(pauseAgent('a')).resolves.toEqual({ user_control_revision: undefined });
    });

    it('pauseAgent throws on failure', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/pause`, () =>
          HttpResponse.json({ error: 'x' }, { status: 500 }),
        ),
      );
      await expect(pauseAgent('a')).rejects.toThrow('Failed to pause agent');
    });

    it('resumeAgent resolves on success', async () => {
      await expect(resumeAgent('a')).resolves.toBeUndefined();
    });

    it('resumeAgent throws on failure', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/resume`, () =>
          HttpResponse.json({ error: 'x' }, { status: 500 }),
        ),
      );
      await expect(resumeAgent('a')).rejects.toThrow('Failed to resume agent');
    });

    it('startAgent resolves on success', async () => {
      await expect(startAgent('a')).resolves.toBeUndefined();
    });

    it('startAgent throws server error.error', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/start-agent`, () =>
          HttpResponse.json({ error: 'denied' }, { status: 403 }),
        ),
      );
      await expect(startAgent('a')).rejects.toThrow('denied');
    });

    it('startAgent falls back to default on unparseable error body', async () => {
      server.use(
        http.post(
          `${API_BASE}/agents/:agentId/start-agent`,
          () => new HttpResponse('not json', { status: 500 }),
        ),
      );
      await expect(startAgent('a')).rejects.toThrow('Failed to start agent');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // generateLLMJudgePrompt
  // ─────────────────────────────────────────────────────────────────────
  describe('generateLLMJudgePrompt', () => {
    it('returns prompt on success', async () => {
      const p = await generateLLMJudgePrompt('find apartment');
      expect(p).toBe('Test LLM judge prompt');
    });

    it('prefers error.details over error.error', async () => {
      server.use(
        http.post(`${API_BASE}/generate-llm-judge-prompt`, () =>
          HttpResponse.json({ details: 'Deep detail', error: 'Shallow' }, { status: 400 }),
        ),
      );
      await expect(generateLLMJudgePrompt('x')).rejects.toThrow('Deep detail');
    });

    it('falls back to error.error when no details', async () => {
      server.use(
        http.post(`${API_BASE}/generate-llm-judge-prompt`, () =>
          HttpResponse.json({ error: 'Shallow' }, { status: 400 }),
        ),
      );
      await expect(generateLLMJudgePrompt('x')).rejects.toThrow('Shallow');
    });

    it('falls back to default when neither field set', async () => {
      server.use(
        http.post(`${API_BASE}/generate-llm-judge-prompt`, () =>
          HttpResponse.json({}, { status: 500 }),
        ),
      );
      await expect(generateLLMJudgePrompt('x')).rejects.toThrow('Failed to generate prompt');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getTools (no auth required)
  // ─────────────────────────────────────────────────────────────────────
  describe('getTools', () => {
    it('returns tools array on success (no auth needed)', async () => {
      localStorage.clear(); // getTools is the only method that doesn't require auth
      const tools = await getTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools[0].id).toBe('web-search');
    });

    it('throws on failure', async () => {
      server.use(http.get(`${API_BASE}/tools`, () => HttpResponse.json({}, { status: 500 })));
      await expect(getTools()).rejects.toThrow('Failed to fetch tools');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // updateAgent
  // ─────────────────────────────────────────────────────────────────────
  describe('updateAgent', () => {
    it('returns updated agent payload', async () => {
      server.use(
        http.patch(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json({ agent: { agent_id: 'a', model: 'rose-1-ultra' } }),
        ),
      );
      const updated = await updateAgent('a', { model: 'rose-1-ultra' });
      expect(updated.model).toBe('rose-1-ultra');
    });

    it('throws on failure', async () => {
      server.use(
        http.patch(`${API_BASE}/agents/:agentId`, () =>
          HttpResponse.json({ error: 'x' }, { status: 500 }),
        ),
      );
      await expect(updateAgent('a', { model: 'x' })).rejects.toThrow('Failed to update agent');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Attention requests
  // ─────────────────────────────────────────────────────────────────────
  describe('attention requests', () => {
    it('hasActiveAttentionRequest returns false when no pending match', async () => {
      expect(await hasActiveAttentionRequest('some-agent')).toBe(false);
    });

    it('hasActiveAttentionRequest returns true when a pending request matches', async () => {
      server.use(
        http.get(`${API_BASE}/attention-requests`, () =>
          HttpResponse.json({
            requests: [
              {
                id: 'req-1',
                agent_id: 'agent-x',
                workflow_id: 'wf-1',
                question: '?',
                created_at: '',
                updated_at: '',
                answered: false,
              },
            ],
          }),
        ),
      );
      expect(await hasActiveAttentionRequest('agent-x')).toBe(true);
    });

    it('hasActiveAttentionRequest returns false on non-2xx (fail-open)', async () => {
      server.use(
        http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({}, { status: 500 })),
      );
      expect(await hasActiveAttentionRequest('any')).toBe(false);
    });

    it('checkAndRespondToAttentionRequest returns false when no match', async () => {
      expect(await checkAndRespondToAttentionRequest('agent-x', 'yes')).toBe(false);
    });

    it('checkAndRespondToAttentionRequest returns false when list fetch fails', async () => {
      server.use(
        http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({}, { status: 500 })),
      );
      expect(await checkAndRespondToAttentionRequest('agent-x', 'yes')).toBe(false);
    });

    it('checkAndRespondToAttentionRequest posts response and returns true', async () => {
      server.use(
        http.get(`${API_BASE}/attention-requests`, () =>
          HttpResponse.json({
            requests: [
              {
                id: 'req-42',
                agent_id: 'agent-x',
                workflow_id: 'wf-1',
                question: '?',
                created_at: '',
                updated_at: '',
                answered: false,
              },
            ],
          }),
        ),
      );
      expect(await checkAndRespondToAttentionRequest('agent-x', 'yes')).toBe(true);
    });

    it('checkAndRespondToAttentionRequest throws on respond failure', async () => {
      server.use(
        http.get(`${API_BASE}/attention-requests`, () =>
          HttpResponse.json({
            requests: [
              {
                id: 'req-42',
                agent_id: 'agent-x',
                workflow_id: 'wf-1',
                question: '?',
                created_at: '',
                updated_at: '',
                answered: false,
              },
            ],
          }),
        ),
        http.post(`${API_BASE}/attention-requests/:id/respond`, () =>
          HttpResponse.json({ error: 'no' }, { status: 500 }),
        ),
      );
      await expect(checkAndRespondToAttentionRequest('agent-x', 'yes')).rejects.toThrow(
        'Failed to respond to attention request',
      );
    });

    it('respondToAttentionRequest resolves on success', async () => {
      await expect(respondToAttentionRequest('r1', 'yes')).resolves.toBeUndefined();
    });

    it('respondToAttentionRequest throws server error.error', async () => {
      server.use(
        http.post(`${API_BASE}/attention-requests/:id/respond`, () =>
          HttpResponse.json({ error: 'denied' }, { status: 403 }),
        ),
      );
      await expect(respondToAttentionRequest('r1', 'yes')).rejects.toThrow('denied');
    });

    it('respondToAttentionRequest falls back to default on unparseable error', async () => {
      server.use(
        http.post(
          `${API_BASE}/attention-requests/:id/respond`,
          () => new HttpResponse('oops', { status: 500 }),
        ),
      );
      await expect(respondToAttentionRequest('r1', 'yes')).rejects.toThrow(
        'Failed to respond to attention request',
      );
    });

    it('skipAttentionRequest resolves on success', async () => {
      await expect(skipAttentionRequest('r1')).resolves.toBeUndefined();
    });

    it('skipAttentionRequest throws on failure', async () => {
      server.use(
        http.post(`${API_BASE}/attention-requests/:id/skip`, () =>
          HttpResponse.json({ error: 'e' }, { status: 500 }),
        ),
      );
      await expect(skipAttentionRequest('r1')).rejects.toThrow('e');
    });

    it('rejectAttentionRequest resolves on success (no message)', async () => {
      await expect(rejectAttentionRequest('r1')).resolves.toBeUndefined();
    });

    it('rejectAttentionRequest sends message in body when provided', async () => {
      let capturedBody: string | null = null;
      server.use(
        http.post(`${API_BASE}/attention-requests/:id/reject`, async ({ request }) => {
          capturedBody = await request.text();
          return HttpResponse.json({ ok: true });
        }),
      );
      await rejectAttentionRequest('r1', 'hello');
      expect(capturedBody).toContain('hello');
    });

    it('rejectAttentionRequest throws on failure', async () => {
      server.use(
        http.post(`${API_BASE}/attention-requests/:id/reject`, () =>
          HttpResponse.json({ error: 'x' }, { status: 500 }),
        ),
      );
      await expect(rejectAttentionRequest('r1')).rejects.toThrow('x');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Invite codes
  // ─────────────────────────────────────────────────────────────────────
  describe('invite codes', () => {
    it('getMyInviteCode returns info on success', async () => {
      const info = await getMyInviteCode();
      expect(info.inviteCode).toBe(123456);
      expect(info.usesRemaining).toBe(7);
    });

    it('getMyInviteCode throws on failure', async () => {
      server.use(
        http.get(`${API_BASE}/invite-codes/my-code`, () => HttpResponse.json({}, { status: 500 })),
      );
      await expect(getMyInviteCode()).rejects.toThrow('Failed to fetch invite code');
    });

    it('useInviteCode returns payload on success', async () => {
      const result = await useInviteCode(123456);
      expect(result.success).toBe(true);
    });

    it('useInviteCode throws server error.error on failure', async () => {
      server.use(
        http.post(`${API_BASE}/invite-codes/use`, () =>
          HttpResponse.json({ error: 'invalid code' }, { status: 400 }),
        ),
      );
      await expect(useInviteCode(1)).rejects.toThrow('invalid code');
    });

    it('useInviteCode throws default on empty error body', async () => {
      server.use(
        http.post(`${API_BASE}/invite-codes/use`, () => HttpResponse.json({}, { status: 500 })),
      );
      await expect(useInviteCode(1)).rejects.toThrow('Failed to use invite code');
    });

    it('checkNeedsInviteCode returns boolean on success', async () => {
      expect(await checkNeedsInviteCode()).toBe(false);
    });

    it('checkNeedsInviteCode throws on failure', async () => {
      server.use(
        http.get(`${API_BASE}/invite-codes/check`, () => HttpResponse.json({}, { status: 500 })),
      );
      await expect(checkNeedsInviteCode()).rejects.toThrow('Failed to check invite code status');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getPeople
  // ─────────────────────────────────────────────────────────────────────
  describe('getPeople', () => {
    it('returns paginated response on success with defaults', async () => {
      const result = await getPeople();
      expect(result.people).toEqual([]);
      expect(result.pagination.page).toBe(1);
    });

    it('passes pagination + sort + search params in URL', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/people`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            people: [],
            pagination: { page: 2, limit: 25, total: 0, totalPages: 0 },
          });
        }),
      );
      await getPeople(2, 25, { sort: 'name', sortDirection: 'desc', search: 'alice' });
      expect(capturedUrl).toContain('page=2');
      expect(capturedUrl).toContain('limit=25');
      expect(capturedUrl).toContain('sort=name');
      expect(capturedUrl).toContain('sortDirection=desc');
      expect(capturedUrl).toContain('search=alice');
    });

    it('throws on failure', async () => {
      server.use(http.get(`${API_BASE}/people`, () => HttpResponse.json({}, { status: 500 })));
      await expect(getPeople()).rejects.toThrow('Failed to fetch people');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Signup signals
  // ─────────────────────────────────────────────────────────────────────
  describe('signup signals', () => {
    it('signalSignupCompleted resolves on success', async () => {
      await expect(signalSignupCompleted('a')).resolves.toBeUndefined();
    });

    it('signalSignupCompleted throws server error.error', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/signal/signup_completed`, () =>
          HttpResponse.json({ error: 'bad' }, { status: 400 }),
        ),
      );
      await expect(signalSignupCompleted('a')).rejects.toThrow('bad');
    });

    it('signalSignupCompleted falls back to default on unparseable error', async () => {
      server.use(
        http.post(
          `${API_BASE}/agents/:agentId/signal/signup_completed`,
          () => new HttpResponse('oops', { status: 500 }),
        ),
      );
      await expect(signalSignupCompleted('a')).rejects.toThrow('Failed to signal signup completed');
    });

    it('signalSignupDismissed resolves on success', async () => {
      await expect(signalSignupDismissed('a')).resolves.toBeUndefined();
    });

    it('signalSignupDismissed throws on failure', async () => {
      server.use(
        http.post(`${API_BASE}/agents/:agentId/signal/signup_dismissed`, () =>
          HttpResponse.json({ error: 'no' }, { status: 400 }),
        ),
      );
      await expect(signalSignupDismissed('a')).rejects.toThrow('no');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Tree / Ancestors
  // ─────────────────────────────────────────────────────────────────────
  describe('tree + ancestors', () => {
    it('fetchTreeState returns agents array on success', async () => {
      server.use(
        http.get(`${API_BASE}/agents/tree`, () =>
          HttpResponse.json({
            agents: [
              {
                agent_id: 'a',
                parent_agent_id: null,
                goal: 'g',
                status: 'ACTIVE',
                progress: 0,
                tools_in_use: [],
                message_count: 0,
                tree_cost_cents: 0,
              },
            ],
          }),
        ),
      );
      const agents = await fetchTreeState('bus-123');
      expect(agents.length).toBe(1);
      expect(agents[0].agent_id).toBe('a');
    });

    it('fetchTreeState encodes busId in URL', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/agents/tree`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ agents: [] });
        }),
      );
      await fetchTreeState('bus id with spaces');
      expect(capturedUrl).toContain('bus%20id%20with%20spaces');
    });

    it('fetchTreeState throws on failure', async () => {
      server.use(http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({}, { status: 500 })));
      await expect(fetchTreeState('b')).rejects.toThrow('Failed to fetch tree state');
    });

    it('fetchAncestors returns ancestors array on success', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId/ancestors`, () =>
          HttpResponse.json({
            ancestors: [
              { id: 'p1', goal: 'parent goal' },
              { id: 'p2', goal: 'grandparent' },
            ],
          }),
        ),
      );
      const ancestors = await fetchAncestors('a');
      expect(ancestors.length).toBe(2);
      expect(ancestors[0].id).toBe('p1');
    });

    it('fetchAncestors normalizes agent_id rows to id', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId/ancestors`, () =>
          HttpResponse.json({
            ancestors: [{ agent_id: 'root', goal: 'root goal' }],
          }),
        ),
      );
      const ancestors = await fetchAncestors('a');
      expect(ancestors).toEqual([{ id: 'root', goal: 'root goal' }]);
    });

    it('fetchAncestors throws on failure', async () => {
      server.use(
        http.get(`${API_BASE}/agents/:agentId/ancestors`, () =>
          HttpResponse.json({}, { status: 500 }),
        ),
      );
      await expect(fetchAncestors('a')).rejects.toThrow('Failed to fetch ancestors');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Blueprints
  // ─────────────────────────────────────────────────────────────────────
  describe('blueprints', () => {
    it('findBlueprintByGoal returns null on 404', async () => {
      const bp = await findBlueprintByGoal('nonexistent goal');
      expect(bp).toBeNull();
    });

    it('findBlueprintByGoal returns {id} on success', async () => {
      server.use(
        http.get(`${API_BASE}/blueprints/by-goal`, () => HttpResponse.json({ id: 'bp-1' })),
      );
      const bp = await findBlueprintByGoal('some goal');
      expect(bp?.id).toBe('bp-1');
    });

    it('findBlueprintByGoal throws on non-404 failure', async () => {
      server.use(
        http.get(`${API_BASE}/blueprints/by-goal`, () => HttpResponse.json({}, { status: 500 })),
      );
      await expect(findBlueprintByGoal('g')).rejects.toThrow('Failed to find blueprint');
    });

    it('findBlueprintByGoal encodes goal in URL', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/blueprints/by-goal`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ id: 'bp-1' });
        }),
      );
      await findBlueprintByGoal('goal with spaces & stuff');
      expect(capturedUrl).toContain('goal%20with%20spaces');
      expect(capturedUrl).toContain('%26');
    });

    it('submitBlueprintFeedback resolves on success', async () => {
      server.use(
        http.patch(`${API_BASE}/blueprints/:id/feedback`, () =>
          HttpResponse.json({ success: true }),
        ),
      );
      await expect(
        submitBlueprintFeedback('bp-1', { rating: 5, helpImprove: true, agentId: 'a' }),
      ).resolves.toBeUndefined();
    });

    it('submitBlueprintFeedback throws on failure', async () => {
      server.use(
        http.patch(`${API_BASE}/blueprints/:id/feedback`, () =>
          HttpResponse.json({ error: 'x' }, { status: 500 }),
        ),
      );
      await expect(
        submitBlueprintFeedback('bp-1', { rating: 5, helpImprove: true, agentId: 'a' }),
      ).rejects.toThrow('Failed to submit feedback');
    });
  });
});
