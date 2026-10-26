/**
 * Blackbox: the front-end on the REAL L-DISPLAY backend contract
 * (feat/rose-user-ui @ b10b038c1, back-end/src/domains/agent-tools/*).
 *
 *   1. pinned question  TOOL row toolName 'display' (IN_PROGRESS → FINISHED),
 *      metadata.display {placement 'pinned', kind 'question', …, question_id,
 *      items, deliver_to 'user', routed_agent_id} + requestingAgent;
 *      answered with POST /api/agents/:id/questions/:qid/answer {answer} | {dismiss:true};
 *      a sub-agent's pin (its own trajectory, routed_agent_id = root) shows above
 *      the ROOT's query box, sourced from the existing attention-request list.
 *   2. inline media     one ASSISTANT row per item (file_pointer + display
 *      {placement 'inline', kind 'media', sha256, mime_type, caption?}) → one
 *      gallery; text/html frames file_pointer.usercontent_url (a22e8a0b4) in a
 *      sandboxed (allow-scripts) cross-origin frame; older rows without it get
 *      a plain open/download link to the storage URL, never a frame.
 *   3. approvals        ApprovalChip labelled from requestingAgent.
 *   4. send_message_to_user from a code agent (subAgentId = task) renders in the
 *      root trajectory with its pinned inline view ({view, versionId, props}).
 *
 * Every case runs with the Rose Desktop flag on and proves flag-off is stock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { UserUiFrame } from '@/features/user-ui';
import ApprovalChip from '@/features/terminal-component-group/components/ApprovalChip';
import { PinnedQuestionMount } from '@/features/terminal-component-group/components/PinnedQuestion';
import { filterMessagesForSubAgent } from '@/features/terminal-component-group/components/useMessageFiltering';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import {
  parsePinnedQuestion,
  parseRequestingAgent,
} from '@/features/terminal-component-group/hooks/codeAgentContract';
import { derivePendingApproval } from '@/features/terminal/hooks/derivations';
import type { Message } from '@/lib/api';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import {
  API_BASE,
  ROOT_AGENT_ID,
  WithAgent,
  codexRequester,
  msg,
  questionMessage,
  renderItems,
  signIn,
} from './code-agent-steering.fixtures';

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

const STORAGE = 'https://storage.rose.test';
const SUB_AGENT_ID = 'sub-agent-7';

beforeEach(() => {
  resetCodeAgentLocalState();
  signIn();
});

function renderPinned(messages: Message[], roseDesktop = true) {
  return renderWithProviders(
    <WithAgent messages={messages}>
      <PinnedQuestionMount />
      <textarea aria-label="Query box" />
    </WithAgent>,
    { roseDesktop },
  );
}

/** Answer endpoint with the backend's RequestState reply; records every call. */
function captureAnswers(
  reply: (body: Record<string, unknown>) => Response = (body) =>
    HttpResponse.json({
      id: 'q-1',
      kind: 'question',
      status: body.dismiss === true ? 'rejected' : 'answered',
      response: body.dismiss === true ? null : body.answer,
      selected_option: null,
      answered_by: 'user',
    }),
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  server.use(
    http.post(`${API_BASE}/agents/:agentId/questions/:questionId/answer`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ url: request.url, body });
      return reply(body);
    }),
  );
  return calls;
}

/** GET /api/attention-requests as attentionRequests/service.listForUser returns it. */
function serveAttentionRequests(requests: unknown[]) {
  server.use(http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({ requests })));
}

/** The attention row agent-tools/questionService writes for a Rose sub-agent's pin. */
function subAgentQuestionRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atq_sub_1',
    agent_id: SUB_AGENT_ID,
    workflow_id: `wf-${SUB_AGENT_ID}`,
    question: 'Which venue should I book for Friday?',
    image_url: null,
    metadata: {
      agentTools: { kind: 'question', deliverTo: 'user', routedAgentId: ROOT_AGENT_ID },
      displayQuestion: {
        options: [{ label: 'Rooftop' }, { label: 'Garden', recommended: true }],
        allowOther: false,
        items: [],
      },
      requestingAgent: { kind: 'agent', agent_id: SUB_AGENT_ID, label: 'Venue scout' },
    },
    user_response: null,
    created_at: '2026-10-20T12:10:00.000Z',
    updated_at: '2026-10-20T12:10:00.000Z',
    answered: false,
    ...overrides,
  };
}

describe('L-DISPLAY 1: pinned questions on the real contract', () => {
  it('adapter reads display + requestingAgent; drops agent-routed and malformed pins', () => {
    const parsed = parsePinnedQuestion(questionMessage().metadata);
    expect(parsed).toEqual(
      expect.objectContaining({
        question_id: 'q-1',
        allow_other: true,
        items: [],
        routed_agent_id: ROOT_AGENT_ID,
      }),
    );
    // The agents worker's "Asked the agent that started you" row is not a pin.
    expect(
      parsePinnedQuestion({
        display: {
          placement: 'pinned',
          kind: 'question',
          deliver_to: 'agent',
          routed_agent_id: 'p',
        },
      }),
    ).toBeNull();
    expect(parseRequestingAgent(codexRequester())).toEqual(
      expect.objectContaining({ kind: 'code_agent', provider: 'codex', label: 'Codex' }),
    );
    expect(parseRequestingAgent({ kind: 'agent', agent_id: 'a', label: 'Root agent' })).toEqual(
      expect.objectContaining({ kind: 'agent', label: 'Rose' }),
    );
    expect(parseRequestingAgent({ kind: 'robot', agent_id: 'a', label: 'x' })).toBeNull();
  });

  it('pins an IN_PROGRESS row above the query box; its FINISHED update unpins it', () => {
    const view = renderPinned([questionMessage()]);
    const card = screen.getByTestId('pinned-question');
    expect(within(card).getByText('Codex asks')).toBeInTheDocument();
    view.rerender(
      <WithAgent messages={[questionMessage({}, { toolStatus: 'FINISHED' })]}>
        <PinnedQuestionMount />
      </WithAgent>,
    );
    expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument();
  });

  it('answers through the routed agent id with the option label', async () => {
    const calls = captureAnswers();
    renderPinned([questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: /Everyone/ }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
    expect(calls).toEqual([
      {
        url: `${API_BASE}/agents/${ROOT_AGENT_ID}/questions/q-1/answer`,
        body: { answer: 'Everyone' },
      },
    ]);
  });

  it('✕ sends {dismiss: true} so the waiting agent resumes, then unpins', async () => {
    const calls = captureAnswers();
    renderPinned([questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss question' }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
    expect(calls.map((c) => c.body)).toEqual([{ dismiss: true }]);
  });

  it('allow_other false: no Other input, and its number key does nothing', () => {
    const calls = captureAnswers();
    renderPinned([questionMessage({ allow_other: false })]);
    expect(screen.queryByPlaceholderText('Other…')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: '4' });
    expect(calls).toHaveLength(0);
  });

  it('403 keeps the pin with the account message; 400 keeps it with the validation text', async () => {
    let status = 403;
    captureAnswers(() =>
      HttpResponse.json(
        {
          error:
            status === 403
              ? 'Switch to the account that owns this question, then try again.'
              : 'answer must be one of: Only behind the flag, Everyone',
        },
        { status },
      ),
    );
    renderPinned([questionMessage()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Everyone/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Switch to the account that owns this question',
    );
    status = 400;
    await user.click(screen.getByRole('button', { name: /Everyone/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('answer must be one of'),
    );
    expect(screen.getByTestId('pinned-question')).toBeInTheDocument();
  });

  it('404 (question gone) unpins instead of leaving a dead card', async () => {
    captureAnswers(() => HttpResponse.json({ error: 'Question not found' }, { status: 404 }));
    renderPinned([questionMessage()]);
    await userEvent.setup().click(screen.getByRole('button', { name: /Everyone/ }));
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
  });

  it("a sub-agent's pin (routed to root) shows above the root's query box and answers via root", async () => {
    serveAttentionRequests([
      subAgentQuestionRequest(),
      // Already answered, another root, and an approval: never pinned here.
      subAgentQuestionRequest({ id: 'atq_done', answered: true, user_response: 'Rooftop' }),
      subAgentQuestionRequest({
        id: 'atq_other_root',
        metadata: {
          ...subAgentQuestionRequest().metadata,
          agentTools: { kind: 'question', deliverTo: 'user', routedAgentId: 'other-root' },
        },
      }),
      subAgentQuestionRequest({
        id: 'atq_approval',
        metadata: {
          ...subAgentQuestionRequest().metadata,
          agentTools: { kind: 'approval', deliverTo: 'user', routedAgentId: ROOT_AGENT_ID },
        },
      }),
    ]);
    const calls = captureAnswers();
    renderPinned([]);
    const card = await screen.findByTestId('pinned-question');
    expect(within(card).getByText('Venue scout asks')).toBeInTheDocument();
    expect(within(card).getByText('Which venue should I book for Friday?')).toBeInTheDocument();
    expect(within(card).queryByPlaceholderText('Other…')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('pinned-question')).toHaveLength(1);

    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: `${API_BASE}/agents/${ROOT_AGENT_ID}/questions/atq_sub_1/answer`,
      body: { answer: 'Garden' },
    });
    await waitFor(() => expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument());
  });

  it("the root's own pin goes first; the sub-agent's follows once it is answered", async () => {
    serveAttentionRequests([subAgentQuestionRequest()]);
    captureAnswers();
    renderPinned([questionMessage()]);
    expect(await screen.findByText('Codex asks')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Everyone/ }));
    expect(await screen.findByText('Venue scout asks')).toBeInTheDocument();
  });

  it('flag off: neither the message pin nor a descendant pin renders', async () => {
    serveAttentionRequests([subAgentQuestionRequest()]);
    renderPinned([questionMessage()], false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('pinned-question')).not.toBeInTheDocument();
  });
});

/** One ASSISTANT row per displayed item, exactly as displayService.postInline writes it. */
function mediaMessage(
  index: number,
  mime: string,
  ext: string,
  caption?: string,
  extra: Record<string, unknown> = {},
) {
  const sha = `${'a'.repeat(63)}${index}`;
  return msg(
    {
      source: 'display',
      idempotencyKey: `display:${sha}`,
      display: {
        placement: 'inline',
        kind: 'media',
        sha256: sha,
        mime_type: mime,
        ...(caption ? { caption } : {}),
      },
      requestingAgent: codexRequester(),
      excludeFromModel: true,
      ...extra,
    },
    {
      role: 'ASSISTANT',
      text: caption ?? '',
      file_pointer: {
        id: `fp-${index}`,
        storage_path: `user-1/display/${sha}.${ext}`,
        original_filename: `item-${index}.${ext}`,
        mime_type: mime,
        size_bytes: 1024,
        created_at: '2026-10-20T12:00:00.000Z',
      },
    },
  );
}

const USERCONTENT = 'https://usercontent.rose.test';

/** A text/html display row as displayService writes it since a22e8a0b4 (usercontent_url set). */
function htmlMessage(index: number, usercontentUrl: string) {
  const row = mediaMessage(index, 'text/html', 'html');
  return { ...row, file_pointer: { ...row.file_pointer!, usercontent_url: usercontentUrl } };
}

function attachmentUrlRequests() {
  return capturedRequests.filter((r) => /\/attachments\/[^/]+\/url$/.test(new URL(r.url).pathname));
}

function serveSignedUrls() {
  server.use(
    http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, ({ params }) =>
      HttpResponse.json({ signed_url: `${STORAGE}/signed/${String(params.fileId)}` }),
    ),
  );
}

describe('L-DISPLAY 2: inline media through the gallery', () => {
  it('consecutive display rows render as one gallery with the caption once', async () => {
    serveSignedUrls();
    const rows = [
      mediaMessage(1, 'image/png', 'png', 'Three mockups of the speed button'),
      mediaMessage(2, 'image/png', 'png'),
      mediaMessage(3, 'video/mp4', 'mp4'),
    ];
    renderItems(rows);
    const galleries = screen.getAllByTestId('inline-media');
    expect(galleries).toHaveLength(1);
    expect(galleries[0]).toHaveAttribute('data-layout', 'gallery');
    expect(within(galleries[0]).getAllByTestId('inline-media-item')).toHaveLength(3);
    expect(screen.getAllByText('Three mockups of the speed button')).toHaveLength(1);
    expect(screen.getByTestId('code-agent-attribution')).toHaveTextContent('Codex · via display');
    expect(await screen.findByRole('img', { name: 'item-1.png' })).toHaveAttribute(
      'src',
      `${STORAGE}/signed/fp-1`,
    );
  });

  it('a new caption starts a new gallery', () => {
    serveSignedUrls();
    renderItems([
      mediaMessage(1, 'image/png', 'png', 'First'),
      mediaMessage(2, 'image/png', 'png', 'Second'),
    ]);
    expect(screen.getAllByTestId('inline-media')).toHaveLength(2);
  });

  it('text/html frames only usercontent_url with the display sandbox, never storage', async () => {
    serveSignedUrls();
    renderItems([htmlMessage(4, `${USERCONTENT}/usercontent/display/${ROOT_AGENT_ID}/game.html`)]);
    const frame = await screen.findByTitle('item-4.html');
    expect(frame.tagName).toBe('IFRAME');
    // Display interactions do not grant same-origin access.
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups');
    expect(frame).toHaveAttribute(
      'src',
      `${USERCONTENT}/usercontent/display/${ROOT_AGENT_ID}/game.html`,
    );
    expect(screen.queryByTestId('display-html-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inline-media')).not.toBeInTheDocument();
    // The frame never asks for the storage URL.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attachmentUrlRequests()).toHaveLength(0);
  });

  it.each([
    { kind: 'page', mime: 'text/html', source: 'display' },
    { kind: 'bundle', mime: 'application/vnd.rose.bundle+json', source: 'pointer' },
    { kind: 'model', mime: 'model/gltf-binary', source: 'display' },
    { kind: 'pdf', mime: 'application/pdf', source: 'pointer' },
  ])(
    'frames $kind using the exact L-DISPLAY3 $source kind and usercontent URL',
    ({ kind, mime, source }) => {
      const row = mediaMessage(9, mime, kind);
      row.metadata = {
        ...row.metadata,
        display: {
          ...(row.metadata?.display as object),
          ...(source === 'display' ? { media_kind: kind } : {}),
        },
      };
      const url = `${USERCONTENT}/usercontent/display/${ROOT_AGENT_ID}/${kind}/index.html`;
      const file_pointer = {
        ...row.file_pointer!,
        usercontent_url: url,
        ...(source === 'pointer' ? { kind } : {}),
      };
      renderItems([{ ...row, file_pointer }]);
      const frame = screen.getByTestId('display-html-frame');
      expect(frame).toHaveAttribute('src', url);
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups');
      expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
      expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(screen.queryByTestId('inline-media')).toBeNull();
      expect(attachmentUrlRequests()).toHaveLength(0);
    },
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>no</h1>',
    'blob:https://usercontent.rose.test/file',
    '/relative-preview',
  ])('does not frame an invalid usercontent URL: %s', async (url) => {
    serveSignedUrls();
    const row = mediaMessage(10, 'application/vnd.rose.bundle+json', 'json');
    row.metadata = {
      ...row.metadata,
      display: { ...(row.metadata?.display as object), media_kind: 'bundle' },
    };
    const file_pointer = { ...row.file_pointer!, usercontent_url: url };
    renderItems([{ ...row, file_pointer }]);
    expect(await screen.findByTestId('display-html-link')).toHaveAttribute(
      'href',
      `${STORAGE}/signed/fp-10`,
    );
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('keeps generic user UI frames at allow-scripts only', () => {
    renderWithProviders(
      <UserUiFrame src={`${USERCONTENT}/generic/index.html`} title="Generic UI" />,
    );
    expect(screen.getByTitle('Generic UI')).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('an older row without usercontent_url is a plain open/download link, never framed', async () => {
    serveSignedUrls();
    renderItems([mediaMessage(4, 'text/html', 'html', 'The game')]);
    const link = await screen.findByTestId('display-html-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', `${STORAGE}/signed/fp-4`);
    expect(link).toHaveAttribute('download', 'item-4.html');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('Open item-4.html');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('a same-origin usercontent_url is never framed (falls back to the link)', async () => {
    serveSignedUrls();
    renderItems([htmlMessage(5, `${window.location.origin}/usercontent/display/x/y.html`)]);
    expect(await screen.findByTestId('display-html-link')).toHaveAttribute(
      'href',
      `${STORAGE}/signed/fp-5`,
    );
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('an unsignable older row shows the unavailable notice, no link or frame', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId/attachments/:fileId/url`, () =>
        HttpResponse.json({ error: 'gone' }, { status: 404 }),
      ),
    );
    renderItems([mediaMessage(4, 'text/html', 'html')]);
    expect(await screen.findByTestId('display-html-unavailable')).toHaveTextContent(
      'item-4.html — preview unavailable',
    );
    expect(screen.queryByTestId('display-html-link')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it("a code agent's media rows (subAgentId = task) stay in the root trajectory", () => {
    const row = mediaMessage(5, 'image/png', 'png', 'Screenshot', {
      subAgentId: 'task-1',
      task_id: 'task-1',
    });
    expect(filterMessagesForSubAgent([row], undefined, true)).toEqual([row]);
    expect(filterMessagesForSubAgent([row], undefined, false)).toEqual([]);
  });

  it('flag off: stock attachment bubble, no gallery grouping or frame', () => {
    serveSignedUrls();
    renderItems(
      [
        mediaMessage(1, 'image/png', 'png', 'Caption'),
        mediaMessage(6, 'text/html', 'html'),
        htmlMessage(7, `${USERCONTENT}/usercontent/display/${ROOT_AGENT_ID}/game.html`),
      ],
      { roseDesktop: false },
    );
    expect(screen.queryByTestId('inline-media')).not.toBeInTheDocument();
    expect(screen.queryByTitle('item-6.html')).not.toBeInTheDocument();
    expect(screen.queryByTitle('item-7.html')).not.toBeInTheDocument();
    expect(screen.queryByTestId('display-html-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-agent-attribution')).not.toBeInTheDocument();
  });
});

describe('L-DISPLAY 3: code-agent approvals', () => {
  const approval = msg(
    {
      toolCallId: 'agent-tools:atq_approval_1',
      toolName: 'request_user_approval',
      toolStatus: 'IN_PROGRESS',
      title: '🔐 Codex requests approval',
      isUserAttentionMessage: true,
      attentionMessage: 'Merge rose-ui/polish/speed into rose-ui/polish?',
      requestUserApproval: {
        attentionRequestId: 'atq_approval_1',
        toolApproval: true,
        requestingAgent: codexRequester(),
      },
      requestingAgent: codexRequester(),
      excludeFromModel: true,
      subAgentId: 'task-1',
      task_id: 'task-1',
    },
    { text: 'Merge rose-ui/polish/speed into rose-ui/polish?' },
  );

  it('ApprovalChip carries the requesting agent icon and label', () => {
    renderWithProviders(<ApprovalChip pendingApproval={derivePendingApproval([approval])} />);
    const who = screen.getByTestId('approval-requester');
    expect(who).toHaveTextContent('Codex');
    expect(within(who).getByRole('img', { name: 'Codex' })).toBeInTheDocument();
  });

  it('a Rose sub-agent requester shows its label without a provider icon', () => {
    const fromRose = {
      ...approval,
      metadata: {
        ...approval.metadata,
        requestingAgent: { kind: 'agent', agent_id: SUB_AGENT_ID, label: 'Venue scout' },
      },
    };
    renderWithProviders(<ApprovalChip pendingApproval={derivePendingApproval([fromRose])} />);
    const who = screen.getByTestId('approval-requester');
    expect(who).toHaveTextContent('Venue scout');
    expect(within(who).queryByRole('img')).not.toBeInTheDocument();
  });

  it('flag off: no requester label', () => {
    renderWithProviders(<ApprovalChip pendingApproval={derivePendingApproval([approval])} />, {
      roseDesktop: false,
    });
    expect(screen.queryByTestId('approval-requester')).not.toBeInTheDocument();
  });
});

describe('L-DISPLAY 4: code-agent send_message_to_user with an inline view', () => {
  const gameRow = msg(
    {
      toolCallId: 'agent-tools:atq_msg_1',
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      title: 'Codex: FYI for User',
      isUserAttentionMessage: true,
      attentionMessage: 'Your game is ready — use the arrow keys.',
      sendMessageToUser: { isQuestion: false, attentionKind: 'info', isWaitingForUser: false },
      inlineView: { view: 'snake-game', versionId: 'ver-42', props: { speed: 3 } },
      requestingAgent: codexRequester(),
      excludeFromModel: true,
      subAgentId: 'task-1',
      task_id: 'task-1',
    },
    { text: 'Your game is ready — use the arrow keys.' },
  );

  it('stays in the root trajectory (flag on only)', () => {
    expect(filterMessagesForSubAgent([gameRow], undefined, true)).toEqual([gameRow]);
    expect(filterMessagesForSubAgent([gameRow], undefined, false)).toEqual([]);
  });

  it('renders attributed to the code agent with its pinned inline view', () => {
    renderItems([gameRow]);
    expect(screen.getByTestId('code-agent-attribution')).toHaveTextContent(
      'Codex · via send_message_to_user',
    );
    const view = screen.getByTestId('user-ui-inline-view');
    expect(view).toHaveAttribute('data-inline-view', 'snake-game');
    expect(view).toHaveAttribute('data-inline-version', 'ver-42');
  });

  it('flag off: no attribution', () => {
    renderItems([gameRow], { roseDesktop: false });
    expect(screen.queryByTestId('code-agent-attribution')).not.toBeInTheDocument();
  });
});
