/**
 * Deep link into one section of the Integrations panel (e.g. folder settings'
 * "Switch repo in Integrations" → the GitHub Repos section, with that folder
 * pre-selected for switching).
 *
 *   section already mounted (panel open) --> scrolled into view now and told
 *                                             (INTEGRATIONS_SECTION_FOCUS_EVENT)
 *   panel still opening                   --> remembered; the section scrolls
 *                                             itself into view on mount
 *                                             (takeIntegrationsSectionFocus)
 */

export const GITHUB_REPOS_SECTION_ID = 'integrations-github-repos';

/** window event for an already-mounted section; detail is an IntegrationsSectionFocus. */
export const INTEGRATIONS_SECTION_FOCUS_EVENT = 'rose:integrations-section-focus';

const PENDING_KEY = 'rose:integrations-section-focus';

export interface IntegrationsSectionFocus {
  sectionId: string;
  /** Folder (project id) the section should pre-select, if any. */
  folderId: string | null;
}

export function focusIntegrationsSection(
  sectionId: string,
  options: { folderId?: string | null } = {},
): void {
  const focus: IntegrationsSectionFocus = { sectionId, folderId: options.folderId ?? null };
  const element = document.getElementById(sectionId);
  if (element !== null) {
    element.scrollIntoView?.({ block: 'start' });
    window.dispatchEvent(new CustomEvent(INTEGRATIONS_SECTION_FOCUS_EVENT, { detail: focus }));
    return;
  }
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(focus));
}

/** The deep link (cleared) when one asked for this section before it mounted; else null. */
export function takeIntegrationsSectionFocus(sectionId: string): IntegrationsSectionFocus | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (raw === null) return null;
  let focus: Partial<IntegrationsSectionFocus> | null = null;
  try {
    focus = JSON.parse(raw) as Partial<IntegrationsSectionFocus>;
  } catch {
    focus = null;
  }
  if (focus?.sectionId !== sectionId) return null;
  sessionStorage.removeItem(PENDING_KEY);
  return { sectionId, folderId: typeof focus.folderId === 'string' ? focus.folderId : null };
}
