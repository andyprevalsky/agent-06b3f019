import type { Plugin } from 'vite';

/** One id per production build: the deployed commit plus the build time. */
export function productionBuildId(): string {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || 'local';
  return `${commit}-${Date.now().toString(36)}`;
}

/** Vite build plugin (imported by vite.config.ts, never by the app). Publishes
 * the build id as /version.json; open pages poll it to reload onto
 * a newer deploy (src/lib/appVersion.ts). */
export function roseBuildVersion(buildId: string): Plugin {
  return {
    name: 'rose-build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ buildId })}\n`,
      });
    },
  };
}
