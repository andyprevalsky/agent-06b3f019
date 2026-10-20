/**
 * Shared fixtures for the Rose Desktop left-bar suites (rose-sidebar*.blackbox).
 *
 * Projects API (backend contract feat/rose-user-ui @ ea032a02a; typed client in
 * lib/api/projects.ts):
 *   GET    /api/projects                       -> { projects: ProjectDto[] }
 *   POST   /api/projects { name, ... }         -> 201 ProjectDto | 409 duplicate name
 *   PUT    /api/projects/:id (edited subset)   -> ProjectDto | 400 unknown field (strict)
 *   DELETE /api/projects/:id                   -> 204
 *   GET    /api/projects/:id/env-files         -> { envFiles: EnvFileDto[], query: null }
 *                                                 (never values)
 *   POST   /api/projects/:id/env-files { path, description?, content? } -> 201 EnvFileDto
 *   DELETE /api/projects/:id/env-files/:fileId -> 204
 * `mockProjectsApi` keeps in-memory lists so every call round-trips; envFileCount
 * is derived from the env-file list exactly like the server.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { User } from '@supabase/supabase-js';

import type { Project, ProjectEnvFile } from '@/lib/api/projects';

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
    startupTimeoutS: 120,
    lifecycle: { autoWake: true },
    sync: { revision: 3, lastSyncedAt: '2026-10-20T17:05:00.000Z' },
    envFileCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-20T17:05:00.000Z',
    ...overrides,
  };
}

export function makeEnvFile(overrides: Partial<ProjectEnvFile> = {}): ProjectEnvFile {
  return {
    id: 'ef-agents',
    path: 'agents/.env',
    description: 'Agent worker secrets',
    kind: 'env',
    source: 'managed',
    variables: [{ name: 'BACKEND_API_KEY' }, { name: 'FLY_API_TOKEN', description: 'Fly deploys' }],
    hasContent: true,
    sizeBytes: 812,
    linkTarget: null,
    updatedAt: '2026-10-20T17:05:00.000Z',
    ...overrides,
  };
}

/** Rose's default env files: agents/.env and back-end/.env. */
export function roseEnvFiles(): ProjectEnvFile[] {
  return [
    makeEnvFile(),
    makeEnvFile({
      id: 'ef-backend',
      path: 'back-end/.env',
      description: 'Backend secrets',
      variables: [{ name: 'DATABASE_URL' }, { name: 'RENDER_API_KEY' }],
    }),
  ];
}

const PROJECT_WRITE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'repoUrl',
  'defaultBranch',
  'startupScript',
  'startupTimeoutS',
  'lifecycle',
]);
const ENV_FILE_CREATE_FIELDS: ReadonlySet<string> = new Set([
  'path',
  'description',
  'variables',
  'content',
  'declared',
]);

function hasUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(body).some((key) => !allowed.has(key));
}

/** Variable names of a dotenv paste (`KEY=value`, `export KEY=value`; comments skipped). */
function dotenvNames(content: string): { name: string }[] {
  return content
    .split('\n')
    .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .map((name) => ({ name }));
}

export interface MockProjectsApi {
  projects: Project[];
  envFiles: Map<string, ProjectEnvFile[]>;
}

/**
 * In-memory Projects API; returns the live lists so tests can assert on them.
 * `envFiles` defaults to Rose's two files for `p-rose` and none elsewhere.
 */
export function mockProjectsApi(
  initial: Project[],
  envFiles: Record<string, ProjectEnvFile[]> = { 'p-rose': roseEnvFiles() },
): MockProjectsApi {
  const projects = [...initial];
  const files = new Map<string, ProjectEnvFile[]>(
    initial.map((p) => [p.id, [...(envFiles[p.id] ?? [])]]),
  );
  const dto = (p: Project): Project => ({ ...p, envFileCount: files.get(p.id)?.length ?? 0 });
  const filesOf = (id: unknown) => files.get(String(id)) ?? [];
  server.use(
    http.get(`${API_BASE}/projects`, () => HttpResponse.json({ projects: projects.map(dto) })),
    http.post(`${API_BASE}/projects`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (hasUnknownFields(body, PROJECT_WRITE_FIELDS))
        return HttpResponse.json({ error: 'Invalid body' }, { status: 400 });
      const name = String(body.name).trim();
      if (projects.some((p) => p.name === name))
        return HttpResponse.json({ error: 'A project with this name exists' }, { status: 409 });
      const created = makeProject({
        id: `p-${projects.length + 1}`,
        name,
        repoUrl: null,
        githubConnected: false,
        startupScript: null,
        sync: { revision: 0, lastSyncedAt: null },
      });
      projects.push(created);
      files.set(created.id, []);
      return HttpResponse.json(dto(created), { status: 201 });
    }),
    http.put(`${API_BASE}/projects/:id`, async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (hasUnknownFields(body, PROJECT_WRITE_FIELDS))
        return HttpResponse.json({ error: 'Invalid body' }, { status: 400 });
      const index = projects.findIndex((p) => p.id === params.id);
      const prev = projects[index];
      const lifecycle = body.lifecycle as Partial<Project['lifecycle']> | undefined;
      projects[index] = {
        ...prev,
        ...(body as Partial<Project>),
        ...(body.startupScript === '' ? { startupScript: null } : {}),
        lifecycle: { ...prev.lifecycle, ...lifecycle },
      };
      return HttpResponse.json(dto(projects[index]));
    }),
    http.delete(`${API_BASE}/projects/:id`, ({ params }) => {
      const index = projects.findIndex((p) => p.id === params.id);
      if (index >= 0) projects.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API_BASE}/projects/:id/env-files`, ({ params }) =>
      HttpResponse.json({ envFiles: filesOf(params.id), query: null }),
    ),
    http.post(`${API_BASE}/projects/:id/env-files`, async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      if (hasUnknownFields(body, ENV_FILE_CREATE_FIELDS))
        return HttpResponse.json({ error: 'Invalid body' }, { status: 400 });
      const list = filesOf(params.id);
      const content = typeof body.content === 'string' ? body.content : '';
      const created = makeEnvFile({
        id: `ef-new-${list.length + 1}`,
        path: String(body.path),
        description: typeof body.description === 'string' ? body.description : null,
        variables: dotenvNames(content),
        hasContent: content !== '',
        sizeBytes: content.length,
      });
      files.set(String(params.id), [...list, created]);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.delete(`${API_BASE}/projects/:id/env-files/:fileId`, ({ params }) => {
      files.set(
        String(params.id),
        filesOf(params.id).filter((f) => f.id !== params.fileId),
      );
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { projects, envFiles: files };
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
