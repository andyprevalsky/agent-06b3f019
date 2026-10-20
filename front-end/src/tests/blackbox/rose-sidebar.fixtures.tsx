/**
 * Shared fixtures for the Rose Desktop left-bar suites (rose-sidebar*.blackbox).
 *
 * Projects API (not merged yet; typed client in lib/api/projects.ts):
 *   GET /api/projects -> Project[]; POST/PATCH/DELETE /api/projects[/:id]
 * `projectsHandlers` keeps an in-memory list so create/rename/delete round-trip.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { User } from '@supabase/supabase-js';

import type { Project } from '@/lib/api/projects';

import { server } from './msw/server';

const API_BASE = 'http://localhost:3001/api';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-rose',
    name: 'Rose',
    repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
    githubConnected: true,
    defaultBranch: 'main',
    startupScript: 'sudo service postgresql start || true',
    startupTimeoutSec: 120,
    envFiles: [
      { path: 'agents/.env', description: 'Agent worker secrets' },
      { path: 'back-end/.env', description: 'Backend secrets' },
    ],
    autoWake: true,
    ...overrides,
  };
}

/** In-memory Projects API; returns the live list so tests can assert on it. */
export function mockProjectsApi(initial: Project[]): Project[] {
  const list = [...initial];
  server.use(
    http.get(`${API_BASE}/projects`, () => HttpResponse.json(list)),
    http.post(`${API_BASE}/projects`, async ({ request }) => {
      const body = (await request.json()) as { name: string };
      const created = makeProject({ id: `p-${list.length + 1}`, name: body.name, envFiles: [] });
      list.push(created);
      return HttpResponse.json(created);
    }),
    http.patch(`${API_BASE}/projects/:id`, async ({ request, params }) => {
      const body = (await request.json()) as Partial<Project>;
      const index = list.findIndex((p) => p.id === params.id);
      list[index] = { ...list[index], ...body };
      return HttpResponse.json(list[index]);
    }),
    http.delete(`${API_BASE}/projects/:id`, ({ params }) => {
      const index = list.findIndex((p) => p.id === params.id);
      if (index >= 0) list.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return list;
}

export function signedInUser(name = 'Andy Prevalsky'): User {
  return {
    id: 'test-user',
    is_anonymous: false,
    user_metadata: { full_name: name },
    app_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
  } as User;
}

export function anonymousUser(): User {
  return { ...signedInUser(), is_anonymous: true, user_metadata: {} } as User;
}

export function roseBar(): HTMLElement {
  return screen.getByTestId('rose-sidebar');
}

/** Hover the bar so it expands to full titles (UI ledger row 21). */
export function expandBar(): void {
  act(() => {
    fireEvent.mouseEnter(roseBar());
  });
}

export function collapseBar(): void {
  act(() => {
    fireEvent.mouseLeave(roseBar());
  });
}

export async function openContextMenu(target: HTMLElement, testId: string): Promise<HTMLElement> {
  fireEvent.contextMenu(target);
  return await screen.findByTestId(testId);
}
