/**
 * Blackbox tests for UI item 32 (Andy, 2026-10-26), now on Integrations ›
 * Projects (the left bar has no project rows since 2026-11-15): a project whose
 * repoUrl is a GitHub repository shows the repo owner's GitHub avatar.
 *
 *   GitHub repoUrl (https, .git, ssh, trailing slash) -> <img> with one stable
 *     avatars.githubusercontent.com URL per owner (browser-cached, no API call)
 *   no repo / non-GitHub / no repo segment             -> laptop icon (imported
 *                                                         from the user's computer)
 *   avatar load error                                  -> folder icon, never retried
 *                                                         (also after a remount)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import ProjectsSection from '@/features/integrations/components/ProjectsSection';
import type { Project } from '@/lib/api/projects';

import { mockSession } from './app-sidebar.fixtures';
import { clearCaptures } from './msw/capture';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

/** GitHub logins are case-insensitive: one lowercased URL per owner. */
const avatar = (owner: string) =>
  `https://avatars.githubusercontent.com/${owner.toLowerCase()}?size=64`;

function projectIcon(projectId: string) {
  const row = screen.getByTestId(`project-row-${projectId}`);
  return {
    img: row.querySelector('img'),
    folder: row.querySelector('svg.lucide-folder'),
    laptop: row.querySelector('svg.lucide-laptop'),
  };
}

function expectAvatar(projectId: string, owner: string) {
  const { img, folder, laptop } = projectIcon(projectId);
  expect(img).not.toBeNull();
  expect(img).toHaveAttribute('src', avatar(owner));
  expect(folder).toBeNull();
  expect(laptop).toBeNull();
}

function expectNoGithub(projectId: string) {
  const { img, laptop } = projectIcon(projectId);
  expect(laptop).not.toBeNull();
  expect(img).toBeNull();
}

function expectFolder(projectId: string) {
  const { img, folder } = projectIcon(projectId);
  expect(folder).not.toBeNull();
  expect(img).toBeNull();
}

function renderProjects(projects: Project[]) {
  mockProjectsApi(projects);
  return renderWithProviders(<ProjectsSection />);
}

describe('Project icon on Integrations › Projects: GitHub owner avatar (UI item 32)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
  });
  afterEach(() => localStorage.clear());

  it('a GitHub repo shows its owner avatar: 20px square, lazy, decorative, stable across a remount', async () => {
    const view = renderProjects([makeProject()]);
    await screen.findByTestId('project-row-p-rose');
    expectAvatar('p-rose', 'Rose-Ai-Labs');
    const { img } = projectIcon('p-rose');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveClass('h-5', 'w-5', 'flex-none', 'rounded-[4px]', 'object-cover');
    expect(screen.getByTestId('project-row-p-rose')).toHaveTextContent('Rose');

    // Reopening the panel keeps the same URL (one stable, browser-cached URL per owner).
    view.unmount();
    renderWithProviders(<ProjectsSection />);
    await screen.findByTestId('project-row-p-rose');
    expectAvatar('p-rose', 'Rose-Ai-Labs');
  });

  it('parses https, .git, ssh and trailing-slash GitHub URLs; anything else shows the laptop', async () => {
    renderProjects([
      makeProject({
        id: 'p-https',
        name: 'Https',
        repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
      }),
      makeProject({
        id: 'p-dotgit',
        name: 'DotGit',
        repoUrl: 'https://github.com/octo-org/tool.git',
      }),
      makeProject({ id: 'p-scp', name: 'Scp', repoUrl: 'git@github.com:acme/widgets.git' }),
      makeProject({
        id: 'p-ssh',
        name: 'Ssh',
        repoUrl: 'ssh://git@github.com/acme-ssh/widgets.git',
      }),
      makeProject({ id: 'p-slash', name: 'Slash', repoUrl: 'https://www.github.com/slashy/repo/' }),
      makeProject({ id: 'p-upper', name: 'Upper', repoUrl: 'https://github.com/ROSE-AI-LABS/web' }),
      makeProject({ id: 'p-scp-nouser', name: 'ScpNoUser', repoUrl: 'github.com:bare/repo.git' }),
      makeProject({ id: 'p-none', name: 'None', repoUrl: null, githubConnected: false }),
      makeProject({ id: 'p-gitlab', name: 'Gitlab', repoUrl: 'https://gitlab.com/acme/repo' }),
      makeProject({
        id: 'p-lookalike',
        name: 'Lookalike',
        repoUrl: 'https://github.com.evil.example/acme/repo',
      }),
      makeProject({ id: 'p-owner-only', name: 'OwnerOnly', repoUrl: 'https://github.com/acme' }),
      makeProject({ id: 'p-junk', name: 'Junk', repoUrl: 'not a url' }),
    ]);
    await screen.findByTestId('project-row-p-https');
    expectAvatar('p-https', 'Rose-Ai-Labs');
    expectAvatar('p-dotgit', 'octo-org');
    expectAvatar('p-scp', 'acme');
    expectAvatar('p-ssh', 'acme-ssh');
    expectAvatar('p-slash', 'slashy');
    expectAvatar('p-upper', 'Rose-Ai-Labs');
    expect(projectIcon('p-upper').img?.src).toBe(projectIcon('p-https').img?.src);
    expectAvatar('p-scp-nouser', 'bare');
    expectNoGithub('p-none');
    expectNoGithub('p-gitlab');
    expectNoGithub('p-lookalike');
    expectNoGithub('p-owner-only');
    expectNoGithub('p-junk');
  });

  it('an avatar load error falls back to the folder and is not retried after a remount', async () => {
    const view = renderProjects([
      makeProject({ id: 'p-broken', name: 'Broken', repoUrl: 'https://github.com/broken-owner/x' }),
    ]);
    await screen.findByTestId('project-row-p-broken');
    const { img } = projectIcon('p-broken');
    expect(img).toHaveAttribute('src', avatar('broken-owner'));

    fireEvent.error(img as HTMLImageElement);
    expectFolder('p-broken');

    view.unmount();
    renderWithProviders(<ProjectsSection />);
    await screen.findByTestId('project-row-p-broken');
    expectFolder('p-broken');
  });
});
