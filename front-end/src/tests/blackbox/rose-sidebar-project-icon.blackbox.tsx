/**
 * Blackbox tests for UI item 32 (Andy, 2026-10-26): a project whose repoUrl is a
 * GitHub repository shows the repo owner's GitHub avatar instead of the folder
 * icon, in the Rose left bar and in the mobile list (both render RoseProjectRow).
 *
 *   GitHub repoUrl (https, .git, ssh, trailing slash) -> <img> with one stable
 *     avatars.githubusercontent.com URL per owner (browser-cached, no API call)
 *   no repo / non-GitHub / no repo segment             -> folder icon
 *   avatar load error                                  -> folder icon, never retried
 *
 * The collapsed 64px rail keeps each project row's icon (name faded, no
 * buttons), so the avatar must survive collapse -> expand with the same URL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { RoseMobileAgentList } from '@/features/terminal-component-group/components/rose-sidebar/RoseMobileAgentList';
import type { Project } from '@/lib/api/projects';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { clearCaptures } from './msw/capture';
import {
  collapseBar,
  expandBar,
  makeProject,
  mockProjectsApi,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

/** GitHub logins are case-insensitive: one lowercased URL per owner. */
const avatar = (owner: string) =>
  `https://avatars.githubusercontent.com/${owner.toLowerCase()}?size=64`;

function projectIcon(projectId: string) {
  const row = screen.getByTestId(`rose-project-row-${projectId}`);
  return {
    img: row.querySelector('img'),
    folder: row.querySelector('svg.lucide-folder'),
  };
}

function expectAvatar(projectId: string, owner: string) {
  const { img, folder } = projectIcon(projectId);
  expect(img).not.toBeNull();
  expect(img).toHaveAttribute('src', avatar(owner));
  expect(folder).toBeNull();
}

function expectFolder(projectId: string) {
  const { img, folder } = projectIcon(projectId);
  expect(folder).not.toBeNull();
  expect(img).toBeNull();
}

function renderBar(projects: Project[]) {
  mockProjectsApi(projects);
  const props = defaultProps({
    agents: [makeAgent({ agent_id: 'a-home', goal: 'Plan Tahoe trip', project_id: null })],
    user: signedInUser(),
  });
  renderWithProviders(<AppSidebar {...props} />);
  expandBar();
}

describe('Project icon: GitHub owner avatar instead of the folder (UI item 32)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    clearCaptures();
  });
  afterEach(() => localStorage.clear());

  it('a GitHub repo shows its owner avatar: 20px square, lazy, decorative, stable across collapse', async () => {
    renderBar([makeProject()]);
    await screen.findByTestId('rose-project-row-p-rose');
    expectAvatar('p-rose', 'Rose-Ai-Labs');
    const { img } = projectIcon('p-rose');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(img).toHaveClass('h-5', 'w-5', 'flex-none', 'rounded-[4px]', 'object-cover');
    expect(screen.getByTestId('rose-project-row-p-rose')).toHaveTextContent('Rose');

    // The collapsed rail keeps the project icon (same URL), without its buttons.
    collapseBar();
    expectAvatar('p-rose', 'Rose-Ai-Labs');
    expect(screen.queryByRole('button', { name: 'Create Super Agent' })).toBeNull();
    expandBar();
    expectAvatar('p-rose', 'Rose-Ai-Labs');
  });

  it('parses https, .git, ssh and trailing-slash GitHub URLs; anything else keeps the folder', async () => {
    renderBar([
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
    await screen.findByTestId('rose-project-row-p-https');
    expectAvatar('p-https', 'Rose-Ai-Labs');
    expectAvatar('p-dotgit', 'octo-org');
    expectAvatar('p-scp', 'acme');
    expectAvatar('p-ssh', 'acme-ssh');
    expectAvatar('p-slash', 'slashy');
    expectAvatar('p-upper', 'Rose-Ai-Labs');
    expect(projectIcon('p-upper').img?.src).toBe(projectIcon('p-https').img?.src);
    expectAvatar('p-scp-nouser', 'bare');
    expectFolder('p-none');
    expectFolder('p-gitlab');
    expectFolder('p-lookalike');
    expectFolder('p-owner-only');
    expectFolder('p-junk');
  });

  it('an avatar load error falls back to the folder and is not retried after a remount', async () => {
    renderBar([
      makeProject({ id: 'p-broken', name: 'Broken', repoUrl: 'https://github.com/broken-owner/x' }),
    ]);
    await screen.findByTestId('rose-project-row-p-broken');
    const { img } = projectIcon('p-broken');
    expect(img).toHaveAttribute('src', avatar('broken-owner'));

    fireEvent.error(img as HTMLImageElement);
    expectFolder('p-broken');

    collapseBar();
    expandBar();
    expectFolder('p-broken');
  });

  it('the mobile list shows the same owner avatar', async () => {
    mockProjectsApi([makeProject()]);
    renderWithProviders(
      <RoseMobileAgentList
        agents={[makeAgent({ agent_id: 'a-rose', goal: 'Rose UI polish', project_id: 'p-rose' })]}
        selectedAgentId={null}
        onSelectAgent={vi.fn()}
        onClose={vi.fn()}
        handlers={{
          onRenameAgent: vi.fn(),
          onCopyAgentLink: vi.fn(),
          onToggleAgentPin: vi.fn(),
          onArchiveAgent: vi.fn(),
        }}
        query=""
        contentMatchAgentIds={new Set()}
        isLoading={false}
        isSearching={false}
        searchError={null}
      />,
    );
    await screen.findByTestId('rose-project-row-p-rose');
    expectAvatar('p-rose', 'Rose-Ai-Labs');
  });
});
