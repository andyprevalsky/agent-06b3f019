/**
 * Plain one-line messages for the publish route's failure codes
 * (back-end providers/codePreview/publish.ts + service.ts, route 404).
 */
import { UserAppsApiError } from '@/lib/api/userApps';

export const PUBLISH_ERROR_TEXT: Record<string, string> = {
  NOT_A_GITHUB_REPO: "This code session isn't a GitHub repo.",
  NO_CODE_SESSION: 'This agent has no code session to publish.',
  SESSION_RETIRED: 'This code session was closed.',
  NO_BRANCH: "The session isn't on a branch.",
  ON_MERGE_TARGET: 'The session is on its merge branch; publish needs a work branch.',
  NO_COMMITS: 'There are no commits to publish yet.',
  UNSUPPORTED_TARGET: 'This agent runs on your Mac; it opens the PR from there.',
  PUSH_FAILED: "Couldn't push the branch. Try again.",
  PR_CREATE_FAILED: "GitHub didn't open the PR. Try again.",
  GITHUB_UNAVAILABLE: 'GitHub is unavailable right now. Try again.',
  CODE_TASK_NOT_FOUND: 'This code session no longer exists.',
};

export function publishErrorText(error: unknown): string {
  const code = error instanceof UserAppsApiError ? error.code : null;
  return (code !== null ? PUBLISH_ERROR_TEXT[code] : undefined) ?? "Couldn't publish. Try again.";
}
