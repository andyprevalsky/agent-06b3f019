import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');

function testProductionRequiresPublicBackendUrl() {
  const configSource = fs.readFileSync(
    path.join(backendDir, 'src/domains/integrations/config.ts'),
    'utf8'
  );
  assert(
    /process\.env\.NODE_ENV\s*===\s*['"]production['"][\s\S]*?throw new Error\([\s\S]*?BACKEND_URL or RENDER_EXTERNAL_URL env var is required in production/.test(
      configSource
    ),
    'Production integrations config must fail without BACKEND_URL or RENDER_EXTERNAL_URL'
  );
}

function testBackendBaseUrlUsesProductionEnv() {
  const configSource = fs.readFileSync(
    path.join(backendDir, 'src/domains/integrations/config.ts'),
    'utf8'
  );
  assert(
    configSource.includes('process.env.BACKEND_URL ?? process.env.RENDER_EXTERNAL_URL'),
    'Integrations config must prefer BACKEND_URL and then RENDER_EXTERNAL_URL'
  );
  assert(
    configSource.includes("configuredUrl.trim().replace(/\\/$/, '')"),
    'Integrations config must trim trailing slash from the backend URL'
  );
}

function testRenderConfigPreservesProductionShape() {
  const renderYaml = fs.readFileSync(path.join(backendDir, 'render.yaml'), 'utf8');
  assert(
    /rootDir:\s*back-end/.test(renderYaml),
    'render.yaml must set rootDir to back-end so Render runs commands from the backend package'
  );
  assert(
    /region:\s*virginia/.test(renderYaml),
    'render.yaml should use Render virginia to stay close to Fly iad workers'
  );
  assert(
    /key:\s*BACKEND_URL[\s\S]*?sync:\s*false/.test(renderYaml),
    'render.yaml must preserve BACKEND_URL as a manually provided final public URL'
  );
  assert(
    /key:\s*GMAIL_WEB_CLIENT_SECRET[\s\S]*?sync:\s*false/.test(renderYaml),
    'render.yaml must not commit Gmail OAuth secrets'
  );
}

function main() {
  testProductionRequiresPublicBackendUrl();
  testBackendBaseUrlUsesProductionEnv();
  testRenderConfigPreservesProductionShape();
}

try {
  main();
  process.stdout.write('integrations config structural tests passed\n');
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
