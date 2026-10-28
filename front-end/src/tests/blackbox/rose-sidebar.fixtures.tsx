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
import { act, fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect } from 'vitest';
import type { User } from '@supabase/supabase-js';

import type { MaintenanceRun, MaintenanceState, Project, ProjectEnvFile } from '@/lib/api/projects';

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
    maintenance: {
      script: null,
      timeoutS: 480,
      nightly: false,
      onGithubChange: false,
      nextRunAt: null,
      watchCheckedAt: null,
      running: false,
    },
    snapshot: null,
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
  'maintenance',
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

/** Template sync state of one mock project (the strict backend contract for …/maintenance). */
export interface MockMaintenance {
  state: MaintenanceState;
  /** Modes of every accepted POST …/maintenance/runs, in order. */
  started: string[];
  logs: Map<string, string>;
  /** Settle the running run (as the backend would) and publish a snapshot on success. */
  finish(status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT', log?: string): void;
}

export interface MockProjectsApi {
  projects: Project[];
  envFiles: Map<string, ProjectEnvFile[]>;
  maintenance: Map<string, MockMaintenance>;
  /** The (lazily created) template-sync state of a project, for seeding runs. */
  maintenanceOf(projectId: string): MockMaintenance;
}

function makeRun(overrides: Partial<MaintenanceRun> = {}): MaintenanceRun {
  return {
    id: 'run-1',
    trigger: 'manual',
    mode: 'sync',
    status: 'SUCCEEDED',
    startedAt: '2026-10-28T10:00:00.000Z',
    finishedAt: '2026-10-28T10:03:00.000Z',
    durationMs: 180_000,
    exitCode: 0,
    headSha: null,
    snapshotId: 'snap-1',
    fromSnapshot: false,
    error: null,
    ...overrides,
  };
}

export { makeRun };

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
  const maintenance = new Map<string, MockMaintenance>();
  const maintenanceOf = (id: unknown): MockMaintenance => {
    const key = String(id);
    const existing = maintenance.get(key);
    if (existing) return existing;
    const project = projects.find((p) => p.id === key);
    const created: MockMaintenance = {
      state: {
        snapshot: project?.snapshot ?? null,
        running: false,
        nextRunAt: null,
        watchCheckedAt: null,
        runs: [],
      },
      started: [],
      logs: new Map(),
      finish(status, log = '') {
        const run = created.state.runs[0];
        if (!run) return;
        run.status = status;
        run.finishedAt = '2026-10-28T11:00:00.000Z';
        run.durationMs = 60_000;
        created.logs.set(run.id, log);
        created.state.running = false;
        if (status === 'SUCCEEDED')
          created.state.snapshot = { takenAt: '2026-10-28T11:00:00.000Z', sha: null };
      },
    };
    maintenance.set(key, created);
    return created;
  };
  server.use(
    http.get(`${API_BASE}/projects/:id/maintenance`, ({ params }) => {
      const m = maintenanceOf(params.id);
      const project = projects.find((p) => p.id === params.id);
      return HttpResponse.json({
        ...m.state,
        nextRunAt: project?.maintenance.nightly ? '2026-10-29T10:00:00.000Z' : null,
        watchCheckedAt: project?.maintenance.onGithubChange ? '2026-10-28T09:55:00.000Z' : null,
      });
    }),
    http.post(`${API_BASE}/projects/:id/maintenance/runs`, async ({ request, params }) => {
      const body = (await request.json()) as { mode?: string };
      const m = maintenanceOf(params.id);
      if (m.state.running)
        return HttpResponse.json(
          { error: 'A sync is already running', code: 'maintenance_running' },
          { status: 409 },
        );
      m.started.push(body.mode ?? 'sync');
      const run = makeRun({
        id: `run-${m.state.runs.length + 2}`,
        trigger: body.mode === 'snapshot' ? 'snapshot' : 'manual',
        mode: body.mode === 'snapshot' ? 'snapshot' : 'sync',
        status: 'RUNNING',
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        snapshotId: null,
      });
      m.state.runs.unshift(run);
      m.state.running = true;
      return HttpResponse.json(run, { status: 202 });
    }),
    http.get(`${API_BASE}/projects/:id/maintenance/runs/:runId`, ({ params }) => {
      const m = maintenanceOf(params.id);
      const run = m.state.runs.find((r) => r.id === params.runId);
      if (!run) return HttpResponse.json({ error: 'Run not found' }, { status: 404 });
      return HttpResponse.json({ ...run, log: m.logs.get(run.id) ?? '' });
    }),
  );
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
      const maintenanceBody = body.maintenance as Partial<Project['maintenance']> | undefined;
      projects[index] = {
        ...prev,
        ...(body as Partial<Project>),
        ...(body.startupScript === '' ? { startupScript: null } : {}),
        lifecycle: { ...prev.lifecycle, ...lifecycle },
        maintenance: { ...prev.maintenance, ...maintenanceBody },
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
  return { projects, envFiles: files, maintenance, maintenanceOf };
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

/** Agent menu entries Andy removed (UI #26); none may render on any surface. */
const REMOVED_AGENT_MENU_LABELS = [
  /New agent in this branch/,
  /same E2B session/,
  /Mark unread/,
  /Mute notifications/,
  /Share agent/,
  /Delete agent/,
  /Schedule a prompt/,
];

/**
 * The agent row menu is exactly: Archive agent | Pin agent, Rename agent | Copy ›.
 * Separators sit only between groups: never first, last or doubled.
 */
export function expectAgentMenuEntries(menu: HTMLElement) {
  const children = Array.from(menu.children).map((el) =>
    el.getAttribute('role') === 'separator' ? '—' : el.textContent,
  );
  expect(children).toEqual(['Archive agent', '—', 'Pin agent', 'Rename agent', '—', 'Copy']);
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent),
  ).toEqual(['Archive agent', 'Pin agent', 'Rename agent', 'Copy']);
  for (const label of REMOVED_AGENT_MENU_LABELS) {
    expect(within(menu).queryByText(label)).toBeNull();
  }
}
