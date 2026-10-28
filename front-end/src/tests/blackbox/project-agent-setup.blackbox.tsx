/**
 * Blackbox tests for project settings → "Set up with your coding agent": the
 * copy-paste prompt (boxes.dev wording, Rose's CLI) with a one-time login
 * code minted by POST /api/projects/cli-login-codes { projectId } (MSW).
 *
 * Covers: exact prompt text, the mint request body, Copy (exact clipboard
 * text, "Copied", a fresh single-use code minted right after), refresh before
 * expiry, failure + Try again, and dark-mode styling of the prompt block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import RoseProjectSettingsPanel from '@/features/terminal-component-group/components/rose-sidebar/RoseProjectSettingsPanel';
import { agentInitPrompt } from '@/lib/agentInitPrompt';

import { mockSession } from './app-sidebar.fixtures';
import { server } from './msw/server';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
function exactPrompt(code: string): string {
  return `Install the Rose CLI with \`npm i -g @roselabs/cli\`, then set up this project on Rose by running \`rose agent-init --login-code ${code}\` and following its instructions. Run these commands yourself and ask for my approval when needed.`;
}

function codeFor(n: number): string {
  return `rlc_${String(n).padStart(32, 'x')}`;
}

/** Each mint returns the next code; `ttlMs` sets how long it lives. */
function mockMint(ttlMs = 30 * 60_000, failFirst = false) {
  const bodies: unknown[] = [];
  let calls = 0;
  server.use(
    http.post(`${API_BASE}/projects/cli-login-codes`, async ({ request }) => {
      bodies.push(await request.json());
      calls += 1;
      if (failFirst && calls === 1) return HttpResponse.json({ error: 'boom' }, { status: 500 });
      return HttpResponse.json(
        {
          code: codeFor(calls),
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          project: { id: 'p-rose', name: 'Rose' },
        },
        { status: 201 },
      );
    }),
  );
  return { bodies, calls: () => calls };
}

function renderPanel() {
  const project = makeProject();
  mockProjectsApi([project]);
  renderWithProviders(
    <RoseProjectSettingsPanel project={project} barExpanded={false} onClose={vi.fn()} embedded />,
  );
  return screen.getByRole('region', { name: 'Set up with your coding agent' });
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  mockSession();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Set up with your coding agent', () => {
  it('shows the exact boxes.dev-style prompt with a code minted for this project', async () => {
    const mint = mockMint();
    const section = renderPanel();
    const prompt = await within(section).findByTestId('agent-setup-prompt');
    expect(prompt.textContent).toBe(exactPrompt(codeFor(1)));
    expect(agentInitPrompt(codeFor(1))).toBe(exactPrompt(codeFor(1)));
    expect(mint.bodies).toEqual([{ projectId: 'p-rose' }]);
    expect(section).toHaveTextContent('expires in 30 minutes');
    // Clean in dark mode: the prompt block carries its own dark surface + text.
    expect(prompt.className).toMatch(/dark:bg-\[#2f2f2c\]/);
    expect(prompt.className).toMatch(/dark:text-\[#ecece8\]/);
    expect(prompt.className).toMatch(/dark:border-white/);
  });

  it('copies the exact prompt, confirms, and mints a fresh single-use code', async () => {
    const mint = mockMint();
    const section = renderPanel();
    await within(section).findByText(exactPrompt(codeFor(1)));
    fireEvent.click(within(section).getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(exactPrompt(codeFor(1))));
    expect(await within(section).findByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await within(section).findByText(exactPrompt(codeFor(2)))).toBeVisible();
    expect(mint.calls()).toBe(2);
    fireEvent.click(within(section).getByRole('button', { name: /Copied|Copy prompt/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(exactPrompt(codeFor(2))));
  });

  it('refreshes the code before it expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mint = mockMint(65_000);
    const section = renderPanel();
    await within(section).findByText(exactPrompt(codeFor(1)));
    expect(mint.calls()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(5_100);
    });
    expect(await within(section).findByText(exactPrompt(codeFor(2)))).toBeVisible();
    expect(mint.calls()).toBe(2);
  });

  it('reports a failed mint and recovers with Try again', async () => {
    mockMint(30 * 60_000, true);
    const section = renderPanel();
    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent('Could not create a setup code.');
    expect(within(section).getByRole('button', { name: 'Copy prompt' })).toBeDisabled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByText(exactPrompt(codeFor(2)))).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Copy prompt' })).toBeEnabled();
  });

  it('asks the user to copy by hand when the clipboard is unavailable', async () => {
    mockMint();
    writeText.mockRejectedValueOnce(new Error('denied'));
    const section = renderPanel();
    await within(section).findByText(exactPrompt(codeFor(1)));
    fireEvent.click(within(section).getByRole('button', { name: 'Copy prompt' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Copy failed. Select the prompt and copy it instead.',
    );
    expect(within(section).getByText(exactPrompt(codeFor(1)))).toBeVisible();
  });
});
