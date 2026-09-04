import { backendApiUrl } from '@/lib/backendUrl';

import { ROLES } from './config';
import type { Role } from './types';

/** Fields collected by the application form. */
export interface ApplicationSubmission {
  /** Slug of the role being applied to. */
  roleSlug: string;
  /** Applicant's full name. */
  name: string;
  /** Applicant's email address. */
  email: string;
  /** LinkedIn handle, without the linkedin.com/in/ prefix. */
  linkedin: string;
  /** Resume PDF. */
  resume: File;
}

/**
 * POST an application to the backend as multipart/form-data.
 * Throws with the backend's error message so the form can surface it verbatim.
 */
export async function submitApplication(submission: ApplicationSubmission): Promise<void> {
  const body = new FormData();
  body.append('role_slug', submission.roleSlug);
  body.append('name', submission.name);
  body.append('email', submission.email);
  body.append('linkedin', submission.linkedin);
  body.append('resume', submission.resume);

  const response = await fetch(`${backendApiUrl()}/careers/applications`, {
    method: 'POST',
    body,
  });

  if (!response.ok) {
    const detail = await response
      .json()
      .then((payload: { error?: string }) => payload.error)
      .catch(() => undefined);
    throw new Error(detail ?? 'Could not submit your application. Please try again.');
  }
}

/** Look up a role by its URL slug. */
export function findRole(slug: string | undefined): Role | undefined {
  return ROLES.find((role) => role.slug === slug);
}
