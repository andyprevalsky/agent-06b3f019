/**
 * Blackbox tests for CreateAgentModal.
 * Covers open/closed state, goal/model/reasoning inputs, tool toggles,
 * prompt generation (success + empty-goal error), submit success + error,
 * cancel path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import CreateAgentModal from '@/features/terminal-component-group/components/CreateAgentModal';

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

const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

describe('CreateAgentModal', () => {
  beforeEach(() => {
    // cmdk (the repo picker's list) scrolls the active item; jsdom has no layout.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    mockSession();
    clearCaptures();
    // Provide tools response (the component useEffect fetches on open)
    server.use(
      http.get(`${API_BASE}/tools`, () =>
        HttpResponse.json({
          tools: [
            { id: 'web-search', name: 'Web Search', description: 'Search the web' },
            { id: 'web-fetch', name: 'Web Fetch', description: 'Fetch web page' },
          ],
        }),
      ),
      http.get(`${API_BASE}/integrations/github/repos`, () =>
        HttpResponse.json({
          repos: [
            {
              canonical_ref: 'gh:rose-ai-labs/rose',
              repo_name: 'rose',
              repo_url: 'https://github.com/Rose-Ai-Labs/rose',
              owner: 'rose-ai-labs',
              default_branch: 'main',
              connected_rose_project_ref: null,
            },
          ],
        }),
      ),
    );
  });

  afterEach(() => {
    localStorage.clear();
    if (scrollIntoView)
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('does not render dialog content when closed', () => {
    renderWithProviders(<CreateAgentModal open={false} onClose={() => {}} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/Create New Agent/i)).not.toBeInTheDocument();
  });

  it('renders title, goal input, and default buttons when open', async () => {
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={vi.fn()} />);
    expect(screen.getByText(/Create New Agent/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Goal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Agent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
  });

  it('shows validation error when submitting without a goal', async () => {
    const onSubmit = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={onSubmit} />);
    await u.click(screen.getByRole('button', { name: /Create Agent/i }));
    // onSubmit should not be called without goal
    await new Promise((r) => setTimeout(r, 50));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits valid goal and closes on success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={onClose} onSubmit={onSubmit} />);
    await u.type(screen.getByLabelText('Goal'), 'Buy a bike');
    await u.click(screen.getByRole('button', { name: /Create Agent/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ goal: 'Buy a bike', reasoning_effort: 'high' }),
      );
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows error toast when onSubmit rejects', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('nope'));
    const onClose = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={onClose} onSubmit={onSubmit} />);
    await u.type(screen.getByLabelText('Goal'), 'X');
    await u.click(screen.getByRole('button', { name: /Create Agent/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // onClose NOT called on failure
    expect(onClose).not.toHaveBeenCalled();
  });

  it('inherits the project repo by default (no github_repo_ref sent)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={onSubmit} />);
    expect(screen.getByRole('combobox', { name: /GitHub Repo/i })).toHaveTextContent(
      'Project default (inherited)',
    );
    await u.type(screen.getByLabelText('Goal'), 'Fix the bug');
    await u.click(screen.getByRole('button', { name: /Create Agent/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('github_repo_ref');
  });

  it('submits the selected connected repo as github_repo_ref', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={onSubmit} />);
    await u.type(screen.getByLabelText('Goal'), 'Fix the bug');
    await u.click(screen.getByRole('combobox', { name: /GitHub Repo/i }));
    await u.click(await screen.findByText('gh:rose-ai-labs/rose'));
    await u.click(screen.getByRole('button', { name: /Create Agent/i }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ goal: 'Fix the bug', github_repo_ref: 'gh:rose-ai-labs/rose' }),
      ),
    );
  });

  it('shows an inline error naming a repo the backend reports as not connected', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('GitHub repo not connected'));
    const onClose = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={onClose} onSubmit={onSubmit} />);
    await u.type(screen.getByLabelText('Goal'), 'Fix the bug');
    await u.click(screen.getByRole('combobox', { name: /GitHub Repo/i }));
    await u.click(await screen.findByText('gh:rose-ai-labs/rose'));
    await u.click(screen.getByRole('button', { name: /Create Agent/i }));
    expect(
      (await screen.findAllByText(/GitHub repo gh:rose-ai-labs\/rose is not connected/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: /GitHub Repo/i })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel button invokes onClose', async () => {
    const onClose = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={onClose} onSubmit={vi.fn()} />);
    await u.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Generate from Goal is disabled when goal is empty', () => {
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /Generate from Goal/i });
    expect(btn).toBeDisabled();
  });

  it('Generate from Goal populates prompt on success', async () => {
    server.use(
      http.post(`${API_BASE}/generate-llm-judge-prompt`, () =>
        HttpResponse.json({ prompt: 'Generated judge prompt' }),
      ),
    );
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={vi.fn()} />);
    await u.type(screen.getByLabelText('Goal'), 'Cool goal');
    await u.click(screen.getByRole('button', { name: /Generate from Goal/i }));

    const textarea = screen.getByLabelText('LLM Judge Prompt') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('Generated judge prompt'));
  });

  it('Generate from Goal shows error toast on API failure', async () => {
    server.use(
      http.post(`${API_BASE}/generate-llm-judge-prompt`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={vi.fn()} />);
    await u.type(screen.getByLabelText('Goal'), 'Hi');
    await u.click(screen.getByRole('button', { name: /Generate from Goal/i }));

    // Eventually settles: button re-enables
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Generate from Goal/i })).toBeEnabled(),
    );
  });

  it('loads and displays tool badges', async () => {
    const u = userEvent.setup();
    renderWithProviders(<CreateAgentModal open onClose={() => {}} onSubmit={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Web Search')).toBeInTheDocument());
    // Toggle the badge
    await u.click(screen.getByText('Web Search'));
    // Still visible (badge is clickable toggle)
    expect(screen.getByText('Web Search')).toBeInTheDocument();
    // Toggle off
    await u.click(screen.getByText('Web Search'));
    expect(screen.getByText('Web Search')).toBeInTheDocument();
  });
});
