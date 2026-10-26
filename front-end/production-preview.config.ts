import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config';
import { PRODUCTION_API_PREVIEW_DEFINES } from './src/lib/productionApiPreview';

/** Use only with a production API target; ordinary local stacks keep vite.config.ts. */
export default defineConfig(async (environment) => {
  const base = typeof baseConfig === 'function' ? await baseConfig(environment) : baseConfig;
  return mergeConfig(base, { define: PRODUCTION_API_PREVIEW_DEFINES });
});
