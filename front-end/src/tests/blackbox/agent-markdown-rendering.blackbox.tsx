/**
 * Blackbox: agent markdown renders as structure on every agent surface (C16).
 *
 * Real prod output: root 1a3d495c ("Rose Repo Status") and its Claude Code task
 * 6f8f8f4d (GitHub token redacted), a root reply table from agent ddf91c56
 * (contact values redacted) and a headings + nested-list reply from 0e16359e.
 * Every surface renders through the shared MarkdownText tree, so tables,
 * code, headings and emphasis are elements, never literal markdown syntax,
 * whether the reply is streaming, fading in or settled.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';

import { MarkdownText } from '@/features/terminal-component-group/components/MarkdownText';
import { AttentionMessage } from '@/features/terminal-component-group/components/message-bubble/AttentionMessage';
import { linkifyMarkdownText } from '@/features/terminal-component-group/components/markdown-text';
import { buildCodeSession } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { fenceTerminalOutput } from '@/lib/fenceTerminalOutput';
import type { Message } from '@/lib/api';

import { renderItems, signIn } from './code-agent-steering.fixtures';
import { agentMarkdownViolations, expectedMarkdown } from '../agent-markdown/agentMarkdownCheck';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const PROD_CODE_ROWS = JSON.parse(
  fixture('code-agent-markdown-prod-1a3d495c.fixture.json'),
) as Message[];
const TABLE_REPLY = fixture('agent-ddf91c56-table-reply.txt');
const HEADINGS_REPLY = fixture('agent-0e16359e-headings-reply.txt');
const TASK_ID = '6f8f8f4d-c670-4bc8-b5df-e2c785c4a908';

interface CodeRecord {
  type: string;
  text?: string;
  tool?: { result?: { output?: string } };
}
const CODE_RECORDS = PROD_CODE_ROWS.flatMap(
  (m) => (m.metadata?.code_agent_events as CodeRecord[] | undefined) ?? [],
);
/** Claude Code's final reply, verbatim from the session's result record. */
const CLAUDE_REPLY = CODE_RECORDS.filter((r) => r.type === 'result').at(-1)!.text!;
/** The last command's stdout: the open PR list (multi-line, with hostnames). */
const PR_LIST_STDOUT = CODE_RECORDS.filter((r) =>
  r.tool?.result?.output?.includes('OPEN_ISSUES'),
).at(-1)!.tool!.result!.output!;

function finalAnswer(text: string, id: string): Message {
  return {
    message_id: id,
    timestamp: '2026-11-06T04:24:55.000Z',
    role: 'TOOL',
    text,
    metadata: {
      isUserAttentionMessage: true,
      attentionMessage: text,
      toolStatus: 'FINISHED',
      toolCallId: id,
      title: 'Answer',
    },
  };
}

function expectTable(container: HTMLElement) {
  expect(expectedMarkdown(TABLE_REPLY).tables).toEqual([2]);
  const table = container.querySelector('table')!;
  expect(table).not.toBeNull();
  expect(Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
    'Field',
    'Response plan',
  ]);
  expect(table.querySelectorAll('tbody tr')).toHaveLength(17);
  expect(table.parentElement).toHaveClass('markdown-table-scroll');
  expect(agentMarkdownViolations(container, TABLE_REPLY)).toEqual([]);
}

beforeEach(() => {
  signIn();
});

describe('Claude Code reply on the shared message list (S5, prod 1a3d495c)', () => {
  it('renders inline code, bold and the fenced git log as elements', () => {
    const { container } = renderItems([finalAnswer(CLAUDE_REPLY, 'claude-final')]);
    const reply = container.querySelector<HTMLElement>('[data-message-kind="final-answer"]')!;
    expect(within(reply).getAllByText('/home/user/.rose/handoff.json')[0].tagName).toBe('CODE');
    expect(within(reply).getByText('Default branch:').tagName).toBe('STRONG');
    expect(reply.querySelector('pre')?.textContent).toContain(
      '75d1b1df8f877f20a60cc5cf84cf0219e451715c|andyprevalsky',
    );
    expect(agentMarkdownViolations(reply, CLAUDE_REPLY)).toEqual([]);
  });

  for (const [state, props] of [
    ['settled', { isWaiting: false }],
    ['fading in', { isWaiting: true }],
    ['streaming', { isWaiting: true, isStreaming: true }],
  ] as const) {
    it(`keeps the reply's own line breaks (${state})`, () => {
      // "**Open PRs:** 262\n**Open issues:** 8" is two lines, not one run-on line.
      const { container } = render(<AttentionMessage attentionMessage={CLAUDE_REPLY} {...props} />);
      const counts = Array.from(container.querySelectorAll('p')).find((p) =>
        p.textContent?.startsWith('Open PRs:'),
      )!;
      expect(counts.querySelector('br')).not.toBeNull();
      expect(counts.textContent).toBe('Open PRs: 262\nOpen issues: 8');
    });
  }

  it('the check flags the old plain-text transcript rendering of the same reply', () => {
    const { container } = render(<div>{CLAUDE_REPLY}</div>);
    expect(agentMarkdownViolations(container, CLAUDE_REPLY)).toEqual(
      expect.arrayContaining([
        '0 <pre> blocks for 1 fenced code blocks',
        'literal ``` fence in visible text',
        'literal backtick in visible text',
      ]),
    );
  });
});

describe('code-agent tool output (prod 1a3d495c)', () => {
  it('the session projection hands the renderer stdout as a fenced block', () => {
    const entries = buildCodeSession({
      messages: PROD_CODE_ROWS,
      taskId: TASK_ID,
      ownerAgentId: '1a3d495c-826c-4eca-afe0-382fcbf72e82',
      provider: 'claude',
      sessionState: 'completed',
      sessionEndedAt: null,
      echoes: [],
    });
    const activities = entries.flatMap((e) => (e.kind === 'work' ? e.turn.activities : []));
    const prList = activities.find((m) => m.text.includes('OPEN_ISSUES 8'))!;
    expect(prList.text).toBe(fenceTerminalOutput(PR_LIST_STDOUT));
  });

  it('renders stdout verbatim in a <pre>: every line kept, nothing linkified', () => {
    const row: Message = {
      message_id: 'bash-pr-list',
      timestamp: '2026-11-06T04:24:46.000Z',
      role: 'TOOL',
      text: fenceTerminalOutput(PR_LIST_STDOUT),
      metadata: { toolName: 'Bash', toolStatus: 'FINISHED', title: 'Bash', toolCallId: 'b1' },
    };
    const { container } = renderItems([row]);
    fireEvent.click(container.querySelector('.cursor-pointer')!);
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toBe(`${PR_LIST_STDOUT.replace(/\n+$/, '')}\n`);
    expect(pre.textContent?.split('\n').length).toBeGreaterThan(50);
    expect(pre.querySelector('a')).toBeNull();
  });

  it('a fence outruns backtick runs inside the output and linkify leaves it alone', () => {
    const output = 'see ``` here\nexample.com';
    const fenced = fenceTerminalOutput(output);
    expect(fenced.startsWith('````text\n')).toBe(true);
    expect(linkifyMarkdownText(fenced)).toBe(fenced);
    const { container } = render(<MarkdownText text={fenced} />);
    expect(container.querySelector('pre')?.textContent).toBe(`${output}\n`);
    expect(fenceTerminalOutput(undefined)).toBe('');
  });
});

describe('root reply with a table (prod ddf91c56)', () => {
  it('settled: a real table with header cells inside a horizontal scroll container', () => {
    const { container } = render(
      <AttentionMessage attentionMessage={TABLE_REPLY} isWaiting={false} />,
    );
    expectTable(container);
  });

  it('fading in: the same table while the final answer animates', async () => {
    const { container } = render(<AttentionMessage attentionMessage={TABLE_REPLY} isWaiting />);
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expectTable(container);
  });

  it('streaming: a final answer still arriving renders the table, not raw pipes', () => {
    const { container } = render(
      <AttentionMessage attentionMessage={TABLE_REPLY} isWaiting isStreaming />,
    );
    expectTable(container);
  });

  it('on the shared message list (send_message_to_user)', () => {
    const { container } = renderItems([finalAnswer(TABLE_REPLY, 'root-final')]);
    expectTable(container);
  });
});

describe('root reply with headings and nested lists (prod 0e16359e)', () => {
  for (const shouldAnimate of [false, true]) {
    it(`renders h2/h3, nested lists and links (${shouldAnimate ? 'fading in' : 'settled'})`, () => {
      const { container } = render(
        <MarkdownText text={HEADINGS_REPLY} shouldAnimate={shouldAnimate} />,
      );
      expect(Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)).toEqual([
        'Important ratio correction',
        'Ranked candidates',
        'Products found but excluded from the verified ranked list',
        'Bottom line',
      ]);
      expect(container.querySelectorAll('h3')).toHaveLength(3);
      expect(container.querySelectorAll('li > ul > li')).toHaveLength(7);
      expect(container.textContent).not.toMatch(/(^|\n)#{2,3} /);
      expect(agentMarkdownViolations(container, HEADINGS_REPLY)).toEqual([]);
    });
  }

  it('links carry only href/target/rel (no leaked react-markdown node prop)', () => {
    const { container } = render(<MarkdownText text={HEADINGS_REPLY} />);
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBeGreaterThan(10);
    for (const a of links) {
      expect(a.getAttributeNames().sort()).toEqual(['href', 'rel', 'target']);
    }
  });
});

describe('fading reply completion', () => {
  it('reports completion once the last word has faded in', async () => {
    const onComplete = vi.fn();
    render(<MarkdownText text={TABLE_REPLY} shouldAnimate onComplete={onComplete} />);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });
});
