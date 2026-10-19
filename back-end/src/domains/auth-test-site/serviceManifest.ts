/** The fixture runner's private manifest, distinct from the browser-visible pages. */
import { APP_APPROVAL_CHALLENGE_TTL_MS } from './config';
import type { ScenarioPlan } from './serviceScenarios';
import type { AuthOptionsPreview, AuthTestSite, AuthTestSiteManifest } from './types';

export function buildFixtureManifest(
  site: AuthTestSite,
  plan: ScenarioPlan,
  preview: AuthOptionsPreview,
  savedBrowserAuthHidden: boolean,
  deviceUrl: string | null
): AuthTestSiteManifest {
  return {
    siteId: site.siteId,
    scenario: site.scenario,
    realm: site.realm,
    entryUrl: site.entryUrl,
    savedPasswordUsernames: site.savedPasswords.map((record) => record.username),
    mintedEmail: site.mintedEmail,
    mintedPhone: site.mintedPhone,
    expectedSignInEmail: plan.expectedSignInEmail,
    expectedMemberNumber: plan.expectedMemberNumber,
    namedAccountEmail: plan.namedAccountEmail,
    userSignIn: plan.userSignIn,
    appApprovalUser:
      deviceUrl === null
        ? null
        : {
            deviceUrl,
            expectedNumber: site.appApprovalNumber,
            challengeLifetimeSeconds: APP_APPROVAL_CHALLENGE_TTL_MS / 1000,
          },
    savedSession: plan.savedSession?.state ?? null,
    savedBrowserAuthHidden,
    authOptionsPreview: preview,
  };
}
