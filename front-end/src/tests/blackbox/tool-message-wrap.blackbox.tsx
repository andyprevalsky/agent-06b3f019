/**
 * Blackbox tests for generic ToolMessage wrapping behavior.
 *
 * Covers the expanded browser/tool details body, where long URLs and action
 * summaries must wrap inside the transcript column without horizontal scroll
 * or clipping.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolMessage } from '@/features/terminal-component-group/components/message-bubble/ToolMessage';

describe('ToolMessage wrapping', () => {
  it('constrains expanded tool details and applies long-token wrapping styles', async () => {
    const longUrl =
      'https://www.amazon.com/ap/signin?ie=UTF8&crossDomainRPIDCount=NONE&showRememberMe=true&openid.pape.max_auth_age=9329329%2526amp%253BuseDefaultCart%253D1%2526amp%253BoldCustomerId%253DA1XWBA6TKPRYUI%2526amp%253Breferrer%253Dcheckout';
    const longActionSummary =
      "Actions Taken (20 total, showing last 10): wait: {'action':'wait','thinking':'Current page is still Amazon forced password re-entry page and checkout is still forcing password re-entry for the Andy Prevalsky account.'}";

    const { container } = render(
      <div className="flex w-[320px] overflow-x-hidden">
        <ToolMessage
          data={{
            toolCallId: 'browser-1',
            toolName: 'browser',
            title: 'Browser automation complete',
            status: 'FINISHED',
            message: `${longUrl}\n\n${longActionSummary}`,
          }}
        />
      </div>,
    );

    await userEvent.click(await screen.findByText('Browser automation complete'));

    await waitFor(() => {
      expect(container.textContent).toContain('Actions Taken');
    });
    expect(container.querySelector('.min-w-0.max-w-full.flex-col')).not.toBeNull();
    expect(container.querySelector('.overflow-y-auto.overflow-x-hidden')).not.toBeNull();
    expect(container.querySelector('style')?.textContent).toContain('overflow-wrap: anywhere');
    expect(container.querySelector('style')?.textContent).toContain(
      '.prose.tool-message-markdown pre',
    );
  });
});
