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

function testPlaidProductionProductsMatchApprovedAccess() {
  const plaidSource = fs.readFileSync(path.join(backendDir, 'src/providers/plaid.ts'), 'utf8');
  const productionProductsMatch = plaidSource.match(
    /PLAID_PRODUCTION_PRODUCTS:\s*Products\[\]\s*=\s*\[([\s\S]*?)\];/
  );
  assert(productionProductsMatch, 'Plaid provider must declare production products explicitly');
  const productionProducts = productionProductsMatch[1];

  assert(
    !productionProducts.includes('Products.Auth'),
    'Production Plaid Link must not request Auth until the product is approved'
  );
  assert(
    !productionProducts.includes('Products.Identity'),
    'Production Plaid Link must not request Identity until the product is approved'
  );
}

function main() {
  testProductionRequiresPublicBackendUrl();
  testBackendBaseUrlUsesProductionEnv();
  testPlaidProductionProductsMatchApprovedAccess();
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
