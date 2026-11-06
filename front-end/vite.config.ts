import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// Kept in this file: Rose-in-Rose previews and the cloud image build copy
// vite.config.ts without its neighbours, so it must not import local modules.

/** One id per production build: the deployed commit plus the build time. */
export function productionBuildId(): string {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || 'local';
  return `${commit}-${Date.now().toString(36)}`;
}

/** Publishes the build id as /version.json; open pages poll it to reload onto
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

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const buildId = command === 'build' ? productionBuildId() : '';
  const proxy = {
    '/anthropic-proxy': {
      target: `http://localhost:${process.env.BACKEND_PORT || '3000'}`,
      changeOrigin: true,
    },
    '/api': {
      target: process.env.VITE_BACKEND_API_URL || 'http://localhost:3001',
      changeOrigin: true,
      // Twilio hold-line media streams reach the backend through the tunnel.
      ws: true,
    },
  };

  return {
    server: {
      host: '::',
      port: parseInt(process.env.VITE_DEV_PORT || '8080'),
      allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',').filter(Boolean),
      proxy,
      hmr: process.env.VITE_ALLOWED_HOSTS
        ? {
            clientPort: 443,
          }
        : undefined,
    },
    preview: {
      host: '::',
      allowedHosts: process.env.VITE_ALLOWED_HOSTS?.split(',').filter(Boolean),
      proxy,
    },
    plugins: [react(), roseBuildVersion(buildId)],
    define: {
      'import.meta.env.VITE_ROSE_BUILD_ID': JSON.stringify(buildId),
    },
    build: {
      manifest: true,
      // Local semantic stacks serve the bundled preview, which only contains built
      // entries. Opt-in fixture pages keep their dev-server URLs there; production
      // builds never set this flag and ship only the app.
      rollupOptions:
        process.env.ROSE_E2E_FIXTURES === 'true'
          ? {
              input: {
                main: path.resolve(__dirname, 'index.html'),
                'overlay-layers': path.resolve(__dirname, 'tests-e2e/fixtures/overlay-layers.html'),
              },
            }
          : undefined,
    },
    // Animation assets -> Vite JSON strings -> JSON.parse -> unchanged frame renderer.
    // Native JSON parsing avoids compiling millions of array literals at startup.
    json: {
      stringify: true,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
