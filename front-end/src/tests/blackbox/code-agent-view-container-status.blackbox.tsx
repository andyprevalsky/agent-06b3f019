/**
 * Blackbox (final-run5 replay, code agent 7e45fb38): the code-agent view's query
 * box carries the container status and devbox usage at its top-right corner, and
 * its model chip / speed toggle show the session's own settings.
 *
 *   corner  CodeContainerStatus (green awake with a slow fade, orange stopped,
 *           red destroyed; tooltip with the plain state) + the usage bars,
 *           always shown, never floating over the transcript; absent for a
 *           non-code agent's query box
 *   source  the live transcript snapshot while the task runs, else the left
 *           bar's code-agents list (container_state from CodeSession.state)
 *   speed   the session's exact speed (fast stays fast with an ultra account
 *           preference); a live session cycles only through the model's speeds,
 *           an ended one is read-only and never writes the account preference
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import { writeQueryPreferences } from '@/lib/queryPreferences';
import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import { codeContainerState } from '@/features/terminal-component-group/components/code-agent-view/codeContainerState';
import Terminal from '@/pages/Terminal';

import run5 from './code-agent-view-final-run5.fixture.json';
import { server } from './msw/server';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import { WithAgent, chipMessage } from './code-agent-steering.fixtures';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const API_BASE = 'http://localhost:3001/api';
const OWNER = run5.agent.agent_id;
const TASK = '7e45fb38-1729-4677-aa8e-fd9c7dfb37da';
const MESSAGES = run5.messages as unknown as Message[];
const USER = ROSE_DESKTOP_USER_IDS[0];
/**
 * Ceiling for waits on real async work (detail, list and capabilities fetches)
 * so a loaded parallel run never trips the 1 s default; each wait still ends
 * the moment its condition holds.
 */
const LOAD = { timeout: 10_000 };

type Rec = Record<string, unknown>;

function signIn() {
  const user = { id: USER, is_anonymous: false };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

function ownerAgent(messages: Message[]) {
  return {
    ...run5.agent,
    model: 'rose-labs/rose-1-ultra',
    source: 'MAC_APP',
    reasoning_effort: 'medium',
    progress: 1,
    status_message: null,
    temporal_workflow_id: `wf-${OWNER}`,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    context_size: 0,
    message_count: messages.length,
    price_limit_cents: 1000,
    tree_cost_cents: 0,
    write_lock_enabled: true,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
  };
}

/**
 * The fixture edited: `live` drops the task's completion row and marks every
 * code_agent snapshot live; `speed` rewrites the CLI's session record;
 * `noSessionState` drops the session state its close reported.
 */
function edited({
  live,
  speed,
  noSessionState,
}: {
  live?: boolean;
  speed?: string;
  noSessionState?: boolean;
}): Message[] {
  const rows = live
    ? MESSAGES.filter((message) => message.metadata?.action_type !== 'task_complete')
    : MESSAGES;
  return rows.map((message) => {
    const metadata = { ...(message.metadata as Rec) };
    if (live && metadata.code_agent && typeof metadata.code_agent === 'object') {
      metadata.code_agent = { ...(metadata.code_agent as Rec), state: 'live', ended_at: undefined };
    }
    if (noSessionState && metadata.code_session && typeof metadata.code_session === 'object') {
      metadata.code_session = { ...(metadata.code_session as Rec), state: undefined };
    }
    if (speed && Array.isArray(metadata.code_agent_events)) {
      metadata.code_agent_events = (metadata.code_agent_events as Rec[]).map((record) =>
        record.type === 'session' ? { ...record, speed } : record,
      );
    }
    return { ...message, metadata } as Message;
  });
}

const RUN2 = 'run2-0000-4000-8000-000000000002';

/**
 * The fixture plus a second run of the same spawn (a resumed agent: same tool
 * call, new task id, an hour later). `live`: only its start row; otherwise its
 * completion too, with no session state on its close (the list must decide).
 */
function withResumedRun({ live }: { live: boolean }): Message[] {
  const actions = live ? ['claude_code_started'] : ['claude_code_started', 'task_complete'];
  const start = Date.parse(MESSAGES[MESSAGES.length - 1].timestamp) + 3_600_000;
  const run = MESSAGES.filter(
    (message) =>
      message.metadata?.task_id === TASK && actions.includes(String(message.metadata?.action_type)),
  ).map((message, index) => {
    const at = new Date(start + index * 1000).toISOString();
    const metadata: Rec = { ...(message.metadata as Rec), task_id: RUN2 };
    const meta = metadata.code_agent as Rec | undefined;
    if (meta) {
      metadata.code_agent = live
        ? { ...meta, task_id: RUN2, state: 'live', ended_at: undefined }
        : { ...meta, task_id: RUN2, ...(meta.ended_at ? { ended_at: at } : {}) };
    }
    if (metadata.code_session && typeof metadata.code_session === 'object') {
      metadata.code_session = { ...(metadata.code_session as Rec), state: undefined };
    }
    return { ...message, message_id: `run2-${index}`, timestamp: at, metadata } as Message;
  });
  return [...MESSAGES, ...run];
}

interface ViewOptions {
  messages?: Message[];
  container?: 'awake' | 'stopped' | 'destroyed' | null;
  listedStatus?: string;
  speeds?: string[];
  codeAgent?: boolean;
  /** The task row's status (GET claude-code-session/:taskId). */
  sessionStatus?: string;
  /** More code-agents list rows (another run of the same spawn). */
  extraListed?: Rec[];
}

async function openView({
  messages = MESSAGES,
  container = 'stopped',
  listedStatus = 'CLOSED',
  speeds,
  codeAgent = true,
  sessionStatus = 'CLOSED',
  extraListed = [],
}: ViewOptions = {}) {
  const capabilityTaskIds: string[] = [];
  const turnBodies: Rec[] = [];
  let served = () => {};
  const capabilitiesServed = new Promise<void>((resolve) => {
    served = resolve;
  });
  const agent = ownerAgent(messages);
  const detail = { agent, messages, pagination: { has_more: false, oldest_timestamp: null } };
  server.use(
    http.get(`${API_BASE}/agents`, () => HttpResponse.json({ agents: [agent] })),
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/code-agents`, () =>
      HttpResponse.json({
        code_agents: [
          {
            code_agent_id: TASK,
            owner_agent_id: OWNER,
            root_agent_id: OWNER,
            provider: 'claude',
            status: listedStatus,
            title: 'fix_nub',
            container_state: container,
            created_at: '2026-10-20T16:00:00.000Z',
          },
          ...extraListed,
        ],
      }),
    ),
    http.get(`${API_BASE}/agents/:agentId`, () => HttpResponse.json(detail)),
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, ({ params }) => {
      capabilityTaskIds.push(String(params.taskId));
      served();
      return speeds
        ? HttpResponse.json({
            effective_settings: { model: 'claude-opus-5-5', effort: 'xhigh' },
            models: [
              { model: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['xhigh'], speeds },
            ],
          })
        : HttpResponse.json({ error: 'not live' }, { status: 502 });
    }),
    http.post(`${API_BASE}/claude-code-session/:taskId/turns`, async ({ request }) => {
      turnBodies.push((await request.json()) as Rec);
      return HttpResponse.json({ status: 'delivered' });
    }),
    http.get(`${API_BASE}/claude-code-session/:taskId`, () =>
      HttpResponse.json({ status: sessionStatus, output: '' }),
    ),
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Andy' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
  const query = codeAgent ? `/?agent-id=${OWNER}&code-agent=${TASK}` : `/?agent-id=${OWNER}`;
  window.history.replaceState({}, '', query);
  renderWithProviders(<Terminal />);
  if (codeAgent) await screen.findByTestId('code-agent-view', {}, LOAD);
  const box = await screen.findByTestId('query-input-host', {}, LOAD);
  return Object.assign(box, { capabilitiesServed, capabilityTaskIds, turnBodies });
}

beforeEach(() => {
  localStorage.clear();
  resetCodeAgentLocalState();
  signIn();
  mockProjectsApi([makeProject()]);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('code-agent query box: container status + devbox usage at the top-right corner', () => {
  it('sits inside the query box, never floating over the transcript', async () => {
    const box = await openView();
    const corner = within(box).getByTestId('query-input-corner-status');
    await waitFor(
      () => expect(within(corner).getByTestId('code-container-status')).toBeInTheDocument(),
      LOAD,
    );
    // The usage bars persist even with nothing measured (the session is not running).
    expect(within(corner).getByTestId('code-resources')).toBeInTheDocument();
    expect(screen.getAllByTestId('code-resources')).toHaveLength(1);
    expect(
      within(screen.getByTestId('code-agent-view')).queryByTestId('code-resources'),
    ).toBeNull();
    fireEvent.pointerEnter(within(corner).getByTestId('code-resources'), { pointerType: 'mouse' });
    expect(await screen.findByTestId('code-resources-idle', {}, LOAD)).toHaveTextContent(
      'Usage shows while the container is awake',
    );
  });

  it.each([
    ['stopped', 'bg-orange-500', 'Container stopped (resumes when you send a message)'],
    ['destroyed', 'bg-red-500', 'Container destroyed'],
  ] as const)(
    'an ended task with a %s container: steady dot, plain tooltip',
    async (container, color, label) => {
      const box = await openView({ container });
      const status = await within(box).findByTestId('code-container-status', {}, LOAD);
      await waitFor(() => expect(status).toHaveAttribute('data-state', container), LOAD);
      expect(status).toHaveAttribute('aria-label', label);
      const dot = within(status).getByTestId('code-container-dot');
      expect(dot).toHaveClass(color);
      expect(dot).not.toHaveClass('code-container-blink');
      fireEvent.focus(status);
      expect((await screen.findAllByText(label, {}, LOAD)).length).toBeGreaterThan(0);
    },
  );

  it('a live task is awake: green with the slow fade, whatever an older list read said', async () => {
    const box = await openView({
      messages: edited({ live: true }),
      container: 'stopped',
      listedStatus: 'ACTIVE',
    });
    const status = await within(box).findByTestId('code-container-status', {}, LOAD);
    expect(status).toHaveAttribute('data-state', 'awake');
    expect(status).toHaveAttribute('aria-label', 'Container awake');
    const dot = within(status).getByTestId('code-container-dot');
    expect(dot).toHaveClass('bg-emerald-500', 'code-container-blink');
  });

  it('a session without a known container shows no dot but keeps the usage bars', async () => {
    const box = await openView({ messages: edited({ noSessionState: true }), container: null });
    const corner = within(box).getByTestId('query-input-corner-status');
    expect(within(corner).getByTestId('code-resources')).toBeInTheDocument();
    expect(within(corner).queryByTestId('code-container-status')).toBeNull();
  });

  it("a Rose agent's own query box has no container status", async () => {
    const box = await openView({ codeAgent: false });
    expect(within(box).queryByTestId('query-input-corner-status')).toBeNull();
    expect(screen.queryByTestId('code-container-status')).toBeNull();
  });
});

describe('code-agent query box: the session model and exact speed', () => {
  it('an ended fast session shows fast (not the account ultra preference), read-only', async () => {
    writeQueryPreferences(USER, { ultraPreferred: true });
    const box = await openView({ messages: edited({ speed: 'fast' }) });
    expect(await within(box).findByTestId('query-model-selector', {}, LOAD)).toHaveTextContent(
      'claude-opus-5-5 · xhigh',
    );
    const toggle = within(box).getByTestId('speed-toggle');
    expect(toggle).toHaveAttribute('data-state', 'fast');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('data-state', 'fast');
  });

  it('an ultrafast session shows ultra', async () => {
    const box = await openView({ messages: edited({ speed: 'ultrafast' }) });
    expect(await within(box).findByTestId('speed-toggle', {}, LOAD)).toHaveAttribute(
      'data-state',
      'ultra',
    );
  });

  it('a live session cycles the next turn through the speeds its model supports', async () => {
    const box = await openView({
      messages: edited({ live: true, speed: 'standard' }),
      speeds: ['standard', 'fast'],
      sessionStatus: 'ACTIVE',
    });
    const toggle = await within(box).findByTestId('speed-toggle', {}, LOAD);
    expect(toggle).toHaveAttribute('data-state', 'normal');
    // The live session's catalog decides which speeds it can cycle through.
    await box.capabilitiesServed;
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'), LOAD);
    fireEvent.click(toggle);
    expect(within(box).getByTestId('speed-toggle')).toHaveAttribute('data-state', 'fast');
    // Ultrafast is not offered by this model: the next click goes back to standard.
    fireEvent.click(within(box).getByTestId('speed-toggle'));
    expect(within(box).getByTestId('speed-toggle')).toHaveAttribute('data-state', 'normal');
  });
});

describe('a resumed code agent: its newest run decides', () => {
  it("an ended resumed run reads the list row of that run, never the original task's", async () => {
    const box = await openView({
      messages: withResumedRun({ live: false }),
      // The original task's row is stale; the newest run's row was read after it ended.
      container: 'destroyed',
      extraListed: [
        {
          code_agent_id: RUN2,
          owner_agent_id: OWNER,
          root_agent_id: OWNER,
          provider: 'claude',
          status: 'CLOSED',
          title: 'fix_nub',
          container_state: 'stopped',
          created_at: '2026-11-06T13:28:43.000Z',
        },
      ],
    });
    const status = await within(box).findByTestId('code-container-status', {}, LOAD);
    await waitFor(() => expect(status).toHaveAttribute('data-state', 'stopped'), LOAD);
  });

  it("a live resumed run is awake and reads the newest run's catalog", async () => {
    const box = await openView({
      messages: withResumedRun({ live: true }),
      container: 'destroyed',
      speeds: ['standard', 'fast'],
      sessionStatus: 'ACTIVE',
    });
    expect(await within(box).findByTestId('code-container-status', {}, LOAD)).toHaveAttribute(
      'data-state',
      'awake',
    );
    await box.capabilitiesServed;
    expect(box.capabilityTaskIds).toContain(RUN2);
    expect(box.capabilityTaskIds).not.toContain(TASK);
  });
});

describe('Codex: its fast tier is `priority`', () => {
  it('an ended Codex session on priority shows fast', async () => {
    const box = await openView({ messages: edited({ speed: 'priority' }) });
    expect(await within(box).findByTestId('speed-toggle', {}, LOAD)).toHaveAttribute(
      'data-state',
      'fast',
    );
  });

  it('a live Codex session offering priority cycles to fast and sends priority', async () => {
    const box = await openView({
      messages: edited({ live: true, speed: 'standard' }),
      speeds: ['standard', 'priority'],
      sessionStatus: 'ACTIVE',
    });
    const toggle = await within(box).findByTestId('speed-toggle', {}, LOAD);
    await box.capabilitiesServed;
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'), LOAD);
    fireEvent.click(toggle);
    expect(within(box).getByTestId('speed-toggle')).toHaveAttribute('data-state', 'fast');
    const input = within(box).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'go faster' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(box.turnBodies).toHaveLength(1), LOAD);
    expect(box.turnBodies[0]).toMatchObject({ text: 'go faster', speed: 'priority' });
  });
});

describe('the dot follows the run as its rows arrive (no list refetch)', () => {
  const listed = (state: 'awake' | 'stopped' | 'destroyed', status: string, readAt: number) => ({
    item: {
      code_agent_id: TASK,
      owner_agent_id: OWNER,
      root_agent_id: OWNER,
      provider: 'claude' as const,
      status: status as 'ACTIVE',
      title: 'fix_nub',
      container_state: state,
      created_at: '2026-11-06T12:22:16.000Z',
    },
    readAt,
  });
  const meta = (extra: Rec) =>
    ({
      task_id: TASK,
      provider: 'claude',
      target: 'cloud',
      branch: 'b',
      started_at: 0,
      ...extra,
    }) as never;

  it('live → awake; its close row (realtime) → the state the close reported, over an older list read', () => {
    const readWhileRunning = listed('awake', 'ACTIVE', Date.parse('2026-11-06T12:25:00Z'));
    expect(codeContainerState(meta({ state: 'live' }), readWhileRunning)).toBe('awake');
    const closed = meta({
      state: 'completed',
      ended_at: '2026-11-06T12:28:43Z',
      code_session: { code_session_id: 'cs', pushed: false, merged: false, state: 'PAUSED' },
    });
    expect(codeContainerState(closed, readWhileRunning)).toBe('stopped');
    // A list read after the end wins (e.g. the session was retired since).
    const readAfter = listed('destroyed', 'CLOSED', Date.parse('2026-11-07T00:00:00Z'));
    expect(codeContainerState(closed, readAfter)).toBe('destroyed');
  });
});

describe('the open view: a close row arriving in realtime flips the dot (no list refetch)', () => {
  const LIST_KEY = ['rose-code-agents', 'agent-001'];
  const row = (status: string, container_state: string) => ({
    code_agent_id: 'task-1',
    owner_agent_id: 'agent-001',
    root_agent_id: 'agent-001',
    provider: 'claude',
    status,
    title: 'speed_button',
    container_state,
    created_at: '2026-10-20T12:00:00.000Z',
  });

  let cache: ReturnType<typeof useQueryClient> | null = null;

  /** What the left bar's earlier list read left in the query cache (no request here). */
  function CachedList({ rows, readAt }: { rows: Rec[]; readAt: number }) {
    const client = useQueryClient();
    cache = client;
    useState(() => {
      client.setQueryDefaults(['rose-code-agents'], { gcTime: Infinity });
      client.setQueryData(LIST_KEY, rows, { updatedAt: readAt });
      return null;
    });
    return null;
  }

  function view(messages: Message[], readAt: number) {
    return (
      <WithAgent messages={messages}>
        <CachedList rows={[row('ACTIVE', 'awake')]} readAt={readAt} />
        <CodeAgentConversationView
          codeAgent={{
            taskId: 'task-1',
            ownerAgentId: 'agent-001',
            provider: 'claude',
            title: 'speed_button',
            status: 'ACTIVE',
          }}
          readOnlyMessage={null}
        />
      </WithAgent>
    );
  }

  it('live + list ACTIVE/awake → green; the close (PAUSED, after the list read) → orange', async () => {
    const readAt = Date.now();
    const live = chipMessage({ state: 'live' });
    const rendered = renderWithProviders(view([live], readAt), { roseDesktop: true });
    const dot = () => screen.getByTestId('code-container-status');
    expect(dot()).toHaveAttribute('data-state', 'awake');

    const endedAt = new Date(readAt + 60_000).toISOString();
    const close = chipMessage(
      { state: 'completed', ended_at: endedAt },
      {
        action_type: 'task_complete',
        toolStatus: 'FINISHED',
        code_session: { code_session_id: 'cs-1', pushed: false, merged: false, state: 'PAUSED' },
      },
    );
    rendered.rerender(view([live, close], readAt));
    await waitFor(() => expect(dot()).toHaveAttribute('data-state', 'stopped'), LOAD);
    expect(dot()).toHaveAttribute(
      'aria-label',
      'Container stopped (resumes when you send a message)',
    );
    expect(within(dot()).getByTestId('code-container-dot')).not.toHaveClass('code-container-blink');

    // Only the list can say destroyed (the close reported PAUSED): a later list read
    // (the session retired since) reaches the open view through the shared cache.
    act(() => {
      cache!.setQueryData(LIST_KEY, [row('CLOSED', 'destroyed')], {
        updatedAt: Date.parse(endedAt) + 1000,
      });
    });
    await waitFor(() => expect(dot()).toHaveAttribute('data-state', 'destroyed'), LOAD);
  });

  it('an ended run trusts a list row only when it is no longer ACTIVE and was read after the end', () => {
    const endedAt = Date.parse('2026-11-06T12:28:43Z');
    const closed = {
      task_id: 'task-1',
      provider: 'claude',
      target: 'cloud',
      branch: 'b',
      started_at: 0,
      state: 'completed',
      ended_at: '2026-11-06T12:28:43Z',
      code_session: { code_session_id: 'cs-1', pushed: false, merged: false, state: 'PAUSED' },
    } as never;
    const listed = (status: string, state: string, readAt: number) => ({
      item: row(status, state) as never,
      readAt,
    });
    // A client clock ahead of the worker's: a read "after" the end that still lists ACTIVE.
    expect(codeContainerState(closed, listed('ACTIVE', 'awake', endedAt + 60_000))).toBe('stopped');
    // Not ACTIVE, but read before the end: the close decides.
    expect(codeContainerState(closed, listed('CLOSED', 'destroyed', endedAt - 60_000))).toBe(
      'stopped',
    );
    // Not ACTIVE and read after the end: the list (e.g. retired since) wins.
    expect(codeContainerState(closed, listed('CLOSED', 'destroyed', endedAt + 60_000))).toBe(
      'destroyed',
    );
  });
});
