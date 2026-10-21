import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ProjectsNavButton } from '@/features/terminal-component-group/components/rose-sidebar/ProjectsNavButton';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockSession } from './app-sidebar.fixtures';
import { makeProject } from './rose-sidebar.fixtures';

const api = 'http://localhost:3001/api';
const project = makeProject({
  id: 'project-one',
  name: 'Website',
  repoUrl: 'https://github.com/example/site',
});
beforeEach(() => {
  mockSession();
  server.use(
    http.get(`${api}/projects`, () => HttpResponse.json({ projects: [project] })),
    http.get(`${api}/projects/:id/env-files`, () => HttpResponse.json({ envFiles: [] })),
  );
});
function openProjects() {
  renderWithProviders(<ProjectsNavButton isExpanded />);
  fireEvent.click(screen.getByRole('button', { name: /^Projects$/ }));
}
describe('Projects hub', () => {
  it('exposes repo and development environment settings from a visible Projects entry', async () => {
    openProjects();
    fireEvent.click(await screen.findByRole('button', { name: /Website.*example\/site/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toHaveValue(project.repoUrl);
    expect(screen.getByRole('button', { name: 'Download setup helper' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Startup script' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(await screen.findByRole('button', { name: /Website.*example\/site/ })).toBeVisible();
  });
  it('shows request failure with retry instead of pretending there are no projects', async () => {
    let failed = true;
    server.use(
      http.get(`${api}/projects`, () =>
        failed
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ projects: [project] }),
      ),
    );
    openProjects();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load projects');
    expect(screen.queryByText('No projects yet.')).toBeNull();
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Website.*example\/site/ })).toBeVisible();
  });
  it('saves edited repository settings using the existing project contract', async () => {
    const updates: unknown[] = [];
    server.use(
      http.put(`${api}/projects/project-one`, async ({ request }) => {
        const body = await request.json();
        updates.push(body);
        return HttpResponse.json({ ...project, ...(body as object) });
      }),
    );
    openProjects();
    fireEvent.click(await screen.findByRole('button', { name: /Website.*example\/site/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository URL' }), {
      target: { value: 'https://github.com/example/new-site' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(updates).toEqual([{ repoUrl: 'https://github.com/example/new-site' }]),
    );
  });

  it('keeps a failed create visible without claiming setup or losing the name', async () => {
    server.use(http.post(`${api}/projects`, () => new HttpResponse(null, { status: 503 })));
    openProjects();
    await screen.findByRole('button', { name: /Website.*example\/site/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Keep my name' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Create project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed|Could not/);
    expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Keep my name');
  });

  it('creates a project then opens its real repo setup, retaining errors on failure', async () => {
    const writes: unknown[] = [];
    server.use(
      http.get(`${api}/projects`, () => HttpResponse.json({ projects: [] })),
      http.post(`${api}/projects`, async ({ request }) => {
        writes.push(await request.json());
        return HttpResponse.json(project, { status: 201 });
      }),
    );
    openProjects();
    expect(await screen.findByText('No projects yet.')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), {
      target: { value: 'Website' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Create project' }));
    await waitFor(() => expect(writes).toEqual([{ name: 'Website' }]));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByRole('textbox', { name: 'Repository URL' })).toBeVisible();
  });
});
