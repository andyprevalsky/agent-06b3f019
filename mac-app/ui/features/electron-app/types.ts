/**
 * Type definitions for the electron-app feature — the renderer shell that
 * decides between the Onboarding flow and the main Terminal routes.
 *
 * Types layer: external packages + shared provider types only. No imports from
 * own api/hooks/components.
 */

/**
 * Shape of the auth context consumed by the ElectronApp shell.
 *
 * Mirrors the subset of `useAuth()` (@/features/auth) that this feature needs.
 * Kept local so the shell does not leak into other auth-feature types.
 */
export interface AuthState {
  isFullySignedIn: boolean;
  isAnonymous: boolean;
  loading: boolean;
  refreshAuthState: (reason: string) => Promise<void>;
}

/**
 * Collapsed auth snapshot passed into the onboarding-resolver hook.
 *
 * This is the derived view (loading/signed-in/anonymous) that the resolver
 * actually branches on, separated from the `refreshAuthState` callback so
 * the resolver is a pure state consumer.
 */
export interface AuthSnapshot {
  authLoading: boolean;
  isFullySignedIn: boolean;
  isAnonymous: boolean;
}

/**
 * Subset of the `/api/user-settings` response that drives onboarding gating.
 * The backend returns more fields; we only consume `onboardingCompletedAt`.
 */
export interface UserSettingsResponse {
  onboardingCompletedAt?: string | null;
}
