import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { LocalPreviewPane } from '@/features/terminal-component-group/components/rose-apps/LocalPreviewPane';
import { BrowserModeTabs } from '@/features/terminal-component-group/components/rose-apps/BrowserModeTabs';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { signIn } from './code-agent-steering.fixtures';
beforeEach(signIn);
const API = 'http://localhost:3001/api';
const view = (agent = 'child', status = 'running') => ({
  agent_id: agent,
  root_agent_id: 'root',
  stable_path: '/?agent-id=root&browser=local',
  code_session_id: 'session',
  task_id: 'task',
  status,
  preview_url: 'https://preview-a.example/',
  checked_at: '2026-10-21',
});
function serve(target = 'https://preview-a.example/', status = 'running') {
  server.use(
    http.get(`${API}/agents/child/local-preview`, () => HttpResponse.json(view('child', status))),
    http.post(`${API}/claude-code-session/task/preview/handoff`, () =>
      HttpResponse.json({ code: 'one-use-fixture', preview_url: target }),
    ),
  );
}
describe('Local root preview binding', () => {
  it('fails closed when the handoff target differs from the root preview', async () => {
    serve('https://other-root.example/');
    renderWithProviders(<LocalPreviewPane agentId="child" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Local preview changed');
    expect(screen.queryByTitle('Local root preview')).toBeNull();
  });
  it('embeds the matching root preview and exposes a stable app link without a token', async () => {
    serve();
    renderWithProviders(<LocalPreviewPane agentId="child" />);
    expect(await screen.findByTitle('Local root preview')).toHaveAttribute(
      'src',
      'https://preview-a.example/#rose_preview_handoff=one-use-fixture',
    );
    expect(screen.getByRole('link', { name: 'Stable link' })).toHaveAttribute(
      'href',
      '/?agent-id=root&browser=local',
    );
  });
  it('refreshes discovery before retrying a changed workspace handoff', async () => {
    serve('https://other-root.example/');
    renderWithProviders(<LocalPreviewPane agentId="child" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Local preview changed');
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh local preview' }));
    expect(await screen.findByTitle('Local root preview')).toHaveAttribute(
      'src',
      'https://preview-a.example/#rose_preview_handoff=one-use-fixture',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not mint a frame or wake a paused preview', async () => {
    serve(undefined, 'paused');
    renderWithProviders(<LocalPreviewPane agentId="child" />);
    expect(await screen.findByText(/Local preview is paused/)).toBeInTheDocument();
    expect(screen.queryByTitle('Local root preview')).toBeNull();
  });
  it('discards late responses when changing agents', async () => {
    server.use(
      http.get(`${API}/agents/:id/local-preview`, async ({ params }) => {
        if (params.id === 'a') await delay(100);
        return HttpResponse.json({
          ...view(String(params.id), 'unavailable'),
          root_agent_id: String(params.id),
          stable_path: `/?agent-id=${params.id}&browser=local`,
          task_id: null,
          preview_url: null,
        });
      }),
    );
    const ui = renderWithProviders(<LocalPreviewPane agentId="a" />);
    ui.rerender(<LocalPreviewPane agentId="b" />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Stable link' })).toHaveAttribute(
        'href',
        '/?agent-id=b&browser=local',
      ),
    );
    await delay(150);
    expect(screen.getByRole('link', { name: 'Stable link' })).toHaveAttribute(
      'href',
      '/?agent-id=b&browser=local',
    );
    expect(screen.queryByTitle('Local root preview')).toBeNull();
  });
  it('offers keyboard-operable Local and Remote tabs on an agent', () => {
    renderWithProviders(<BrowserModeTabs />, { selectedAgentId: 'child' });
    const remote = screen.getByRole('tab', { name: 'Remote' }),
      local = screen.getByRole('tab', { name: 'Local' });
    remote.focus();
    fireEvent.keyDown(remote, { key: 'ArrowLeft' });
    expect(local).toHaveFocus();
    expect(local).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(local, { key: 'End' });
    expect(remote).toHaveFocus();
    expect(remote).toHaveAttribute('aria-selected', 'true');
  });
});
