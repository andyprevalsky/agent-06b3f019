/**
 * Blackbox test for the Rose left bar's Mac app title-bar clearance (Andy,
 * 2026-11-06: "we need a lil more padding here so the top bar is not so close
 * to the icons"). The Mac app window uses titleBarStyle hiddenInset, so the
 * traffic lights sit over the bar's top-left; a draggable strip pushes
 * Back | Search below them. The web bar has no strip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';

import { defaultProps, mockSession } from './app-sidebar.fixtures';
import {
  expandBar,
  makeProject,
  mockProjectsApi,
  roseBar,
  signedInUser,
} from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

function renderBar() {
  const user = signedInUser();
  return renderWithProviders(<AppSidebar {...defaultProps({ user })} />, {
    roseThemeUserId: user.id,
  });
}

describe('Rose left bar title-bar clearance', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    mockProjectsApi([makeProject()]);
  });
  afterEach(() => {
    localStorage.clear();
    delete window.api;
  });

  it('web: the top row is the first child, with no title-bar strip', () => {
    renderBar();
    expect(screen.queryByTestId('rose-sidebar-titlebar-inset')).toBeNull();
    expect(roseBar().firstElementChild).toBe(screen.getByTestId('rose-sidebar-top-row'));
  });

  it('Mac app: a draggable strip clears the traffic lights above Back | Search, collapsed and expanded', () => {
    window.api = { isElectron: true };
    renderBar();
    const bar = roseBar();
    const inset = screen.getByTestId('rose-sidebar-titlebar-inset');
    const top = screen.getByTestId('rose-sidebar-top-row');
    // Strip first (window title-bar area, draggable), then the top row (no-drag).
    expect(bar.firstElementChild).toBe(inset);
    expect(inset.nextElementSibling).toBe(top);
    expect(inset).toHaveClass('h-6', '[-webkit-app-region:drag]');
    expect(top).toHaveClass('[-webkit-app-region:no-drag]');
    expect(bar).toHaveAttribute('data-expanded', 'false');
    expandBar();
    expect(bar).toHaveAttribute('data-expanded', 'true');
    expect(bar.firstElementChild).toBe(inset);
    expect(within(top).getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });
});
