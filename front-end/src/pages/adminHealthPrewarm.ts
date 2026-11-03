/**
 * Lets shells outside the admin-health feature (which may not import it) warm
 * Biz health for admins: loads the feature chunk lazily, then starts the
 * backend's monthly build. See prewarmAdminHealth.
 */
export function prewarmAdminHealth(): void {
  void import('@/features/admin-health')
    .then((feature) => feature.prewarmAdminHealth())
    .catch(() => undefined);
}
