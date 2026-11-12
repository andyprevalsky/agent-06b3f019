/**
 * Deep link into one section of the Integrations panel (e.g. folder settings'
 * "Connect / Change in Integrations" → the GitHub Repos section).
 *
 *   section already mounted (panel open) --> scrolled into view now
 *   panel still opening                   --> remembered; the section scrolls
 *                                             itself into view on mount
 *                                             (takeIntegrationsSectionFocus)
 */

export const GITHUB_REPOS_SECTION_ID = 'integrations-github-repos';

const PENDING_KEY = 'rose:integrations-section-focus';

export function focusIntegrationsSection(sectionId: string): void {
  const element = document.getElementById(sectionId);
  if (element !== null) {
    element.scrollIntoView?.({ block: 'start' });
    return;
  }
  sessionStorage.setItem(PENDING_KEY, sectionId);
}

/** True (and cleared) when a deep link asked for this section before it mounted. */
export function takeIntegrationsSectionFocus(sectionId: string): boolean {
  if (sessionStorage.getItem(PENDING_KEY) !== sectionId) return false;
  sessionStorage.removeItem(PENDING_KEY);
  return true;
}
