/** Real Chromium coverage of the shared native-code conversation renderer. */
import { expect, test } from '@playwright/test';
import { FRONTEND_URL, attachRecorder, hasUncaughtErrors } from './helpers';
import { ROSE_DESKTOP_USER_IDS } from '../src/lib/roseDesktop';

const OWNER = 'browser-code-owner';
const TASK = 'browser-code-session';
const START = '2026-10-20T12:00:00.000Z';
const END = '2026-10-20T12:00:57.720Z';
const FINAL = 'The updated speed control is ready for review.';

function records(completed: boolean) {
  return [
    {
      id: 'start',
      seq: 0,
      type: 'turn',
      event: 'started',
      turn_id: 'native-turn',
      ts: START,
      turn_started_at: START,
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `tool-${i}`,
      seq: i + 1,
      rev: 2,
      type: 'tool',
      turn_id: 'native-turn',
      ts: new Date(Date.parse(START) + (i + 1) * 1000).toISOString(),
      tool: {
        name: 'Run',
        target: `echo command-${i}`,
        activity_kind: 'exec',
        result: { status: 'ok', output: `command-${i}` },
      },
    })),
    ...(completed
      ? [
          { id: 'answer', seq: 31, type: 'message', turn_id: 'native-turn', ts: END, text: FINAL },
          {
            id: 'end',
            seq: 32,
            type: 'turn',
            event: 'ended',
            turn_id: 'native-turn',
            ts: END,
            turn_started_at: START,
            turn_ended_at: END,
            turn_outcome: 'completed',
          },
        ]
      : []),
  ];
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: tools collapse into one slot, retain history and survive replay`, async ({
    page,
  }) => {
    const rec = attachRecorder(page);
    let completed = false;
    await page.addInitScript((id) => {
      const user = { id, is_anonymous: false };
      localStorage.setItem('app-user', JSON.stringify(user));
      localStorage.setItem(
        'rose-session',
        JSON.stringify({
          user,
          access_token: 'fixture-access',
          refresh_token: 'fixture-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      );
    }, ROSE_DESKTOP_USER_IDS[0]);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/api/')) {
        await route.continue();
        return;
      }
      const agent = {
        agent_id: OWNER,
        goal: 'Polish the speed control',
        model: 'rose-1-flash',
        source: 'WEB',
        reasoning_effort: 'medium',
        progress: 50,
        status: 'ACTIVE',
        status_message: null,
        temporal_workflow_id: null,
        token_count: 0,
        tokens_in: 0,
        tokens_out: 0,
        context_size: 0,
        message_count: 2,
        price_limit_cents: 100,
        tree_cost_cents: 0,
        created_at: START,
        updated_at: END,
        write_lock_enabled: false,
        parent_agent_id: null,
        parent_goal: null,
        verifier: null,
        tools: [],
      };
      let body: unknown = {};
      if (path === '/api/agents') body = { agents: [agent] };
      else if (path === `/api/agents/${OWNER}`)
        body = {
          agent,
          pagination: { has_more: false, oldest_timestamp: null },
          messages: [
            {
              message_id: 'spawn',
              timestamp: START,
              role: 'TOOL',
              text: '',
              metadata: {
                toolName: 'spawn_claude_code_agent',
                toolCallId: `call-${TASK}`,
                task_id: TASK,
                toolStatus: completed ? 'FINISHED' : 'IN_PROGRESS',
                code_provider: provider,
                code_agent: {
                  task_id: TASK,
                  provider,
                  target: 'cloud',
                  branch: 'ui/speed',
                  state: completed ? 'completed' : 'live',
                  started_at: START,
                  ...(completed ? { ended_at: END } : {}),
                  title: 'Speed control',
                },
              },
            },
            {
              message_id: 'events',
              timestamp: END,
              role: 'TOOL',
              text: '',
              metadata: {
                toolName: 'spawn_claude_code_agent',
                task_id: TASK,
                subAgentId: TASK,
                action_type: 'code_agent_events',
                hidden: true,
                code_agent_events: [...records(completed), ...records(completed)],
              },
            },
          ],
        };
      else if (path === '/api/agents/code-agents')
        body = {
          code_agents: [
            {
              code_agent_id: TASK,
              owner_agent_id: OWNER,
              root_agent_id: OWNER,
              provider,
              status: completed ? 'COMPLETED' : 'ACTIVE',
              title: 'Speed control',
              created_at: START,
            },
          ],
        };
      else if (path === '/api/projects') body = { projects: [] };
      else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
      else if (path === '/api/attention-requests') body = { requests: [] };
      else if (path.endsWith('/capabilities'))
        body = {
          effective_settings: { model: 'fixture-model', effort: 'medium', speed: 'standard' },
          models: [
            {
              model: 'fixture-model',
              label: 'Fixture model',
              efforts: ['medium'],
              speeds: ['standard'],
            },
          ],
        };
      else if (path.endsWith(`-code-session/${TASK}`))
        body = { status: completed ? 'COMPLETED' : 'RUNNING', output: '' };
      await route.fulfill({ json: body });
    });
    await page.goto(`${FRONTEND_URL}/?agent-id=${OWNER}&code-agent=${TASK}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('query-input-layer').locator('textarea')).toBeVisible({
      timeout: 60_000,
    });
    const view = page.getByTestId('code-agent-view');
    const slot = view.getByTestId('trajectory-work-group');
    const header = slot.locator(':scope > button');
    const history = slot.getByTestId('trajectory-work-history');
    const entries = history.getByTestId('trajectory-history-entry');
    const pageOf = (position: string) => history.getByText(position, { exact: true });
    await expect(slot).toHaveCount(1);
    await expect(slot).toHaveAttribute('data-state', 'running');
    // A running turn is one row: its latest activity and elapsed time. Its steps
    // (thoughts included) appear only once the row is expanded.
    await expect(header).toContainText('Run echo command-29');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(history).toHaveCount(0);
    await expect(page.getByTestId('query-input-layer').locator('textarea')).toBeVisible();
    await header.click();
    // 30 deduped steps fit one page (50 a page, the trajectory work groups' pager,
    // anchored at the newest): every step shows and no pager renders.
    await expect(entries).toHaveCount(30);
    await expect(history.getByRole('button', { name: 'Previous activities' })).toHaveCount(0);
    await expect(pageOf('1 / 1')).toHaveCount(0);
    completed = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(slot).toHaveCount(1);
    await expect(slot).toHaveAttribute('data-state', 'completed');
    // The root transcript's work group times its activities (first step to last), not the turn record.
    await expect(header).toContainText('Worked for 56.7s');
    await expect(header).toContainText('30 activities');
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(view.getByText(FINAL, { exact: true })).toBeVisible();
    await expect(slot.getByText(FINAL, { exact: true })).toHaveCount(0);
    await header.click();
    await expect(entries).toHaveCount(30);
    await expect(history.getByRole('button', { name: 'Next activities' })).toHaveCount(0);
    await header.click();
    await expect(history).toHaveCount(0);
    expect(hasUncaughtErrors(rec)).toEqual([]);
  });
}
