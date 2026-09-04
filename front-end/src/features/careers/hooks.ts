import { findRole, submitApplication, type ApplicationSubmission } from './api';
import { ROLES } from './config';
import type { Role } from './types';

/** Returns every open role, in posting order. */
export function useRoles(): readonly Role[] {
  return ROLES;
}

/** Returns the role matching a URL slug, or undefined when the slug is unknown. */
export function useRole(slug: string | undefined): Role | undefined {
  return findRole(slug);
}

/** Returns the submit handler used by the application form. */
export function useSubmitApplication(): (submission: ApplicationSubmission) => Promise<void> {
  return submitApplication;
}
