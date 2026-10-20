import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripTypeScriptTypes } from 'node:module';

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

async function testReadableInboxProjection() {
  const service = fs.readFileSync(
    path.join(backendDir, 'src/domains/integrations/service.ts'),
    'utf8'
  );
  const listing = fs.readFileSync(
    path.join(backendDir, 'src/domains/integrations/repo.integrationsList.ts'),
    'utf8'
  );
  const store = fs.readFileSync(path.join(backendDir, 'src/providers/authOptionsStore.ts'), 'utf8');
  const lanternService = fs.readFileSync(
    path.join(backendDir, 'src/domains/integrations/service.lantern.ts'),
    'utf8'
  );
  function extract(source: string, name: string) {
    const start = source.indexOf(`function ${name}`);
    assert(start >= 0);
    const asyncPrefix = source.slice(start - 6, start) === 'async ' ? 'async ' : '';
    const end = source.indexOf('\n}', start) + 2;
    return stripTypeScriptTypes(asyncPrefix + source.slice(start, end));
  }
  type CredentialQuery = {
    where: {
      userId: string;
      provider: string;
      integration: { name: string; status: string };
      state: { not: string };
    };
  };
  type IntegrationQuery = { where: { userId: string } };
  const queries: CredentialQuery[] = [];
  const rows = [
    {
      userId: 'one',
      email: 'ONE@example.test',
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
    },
    { userId: 'one', email: 'one@example.test', accessToken: 'a', refreshToken: 'r' },
    { userId: 'one', email: 'stale@example.test', accessToken: '', refreshToken: 'r' },
    { userId: 'foreign', email: 'foreign@example.test', accessToken: 'a', refreshToken: 'r' },
  ];
  const prisma = {
    emailIntegrationCredential: {
      findMany: async (query: CredentialQuery) => {
        queries.push(query);
        assert.equal(query.where.provider, 'GMAIL');
        assert.deepEqual(query.where.integration, { name: 'gmail', status: 'CONNECTED' });
        assert.deepEqual(query.where.state, { not: 'needs_reconnect' });
        return rows.filter((row) => row.userId === query.where.userId);
      },
    },
    mintedAccount: { findMany: async () => [] },
  };
  const readable = Function(
    'prisma',
    'primitiveDomain',
    `${extract(store, 'findReadableInboxes')}; return (${extract(store, 'findReadableInboxEmails')});`
  )(prisma, () => 'mail.roselabs.test');
  const derive = Function(
    'isEmailProviderSlug',
    `return (${extract(service, 'withDerivedConnectedEmails')});`
  )((name: string) => name === 'gmail');
  const redactLanternIntegration = Function(
    `return (${extract(lanternService, 'redactLanternIntegration')});`
  )();
  const integrationQueries: IntegrationQuery[] = [];
  let healthCalls = 0;
  const list = Function(
    'prisma',
    'withGoogleScopeHealth',
    'findReadableInboxEmails',
    `return (${extract(listing, 'findIntegrationsByUser')});`
  )(
    {
      integration: {
        findMany: async (query: IntegrationQuery) => {
          integrationQueries.push(query);
          return [
            { name: 'gmail', status: 'CONNECTED', config: {}, emailCredentials: [] },
            { name: 'whatsapp', status: 'CONNECTED', config: {}, emailCredentials: [] },
            { name: 'gmail', status: 'CONNECTED', config: {}, emailCredentials: [] },
            {
              name: 'lantern_people',
              status: 'CONNECTED',
              config: { encryptedCredentials: 'secret-lantern-envelope' },
              emailCredentials: [],
            },
          ];
        },
      },
    },
    (rows: unknown[]) => {
      healthCalls += 1;
      return rows;
    },
    readable
  );
  const repo = {
    isAuthDomainsCached: () => true,
    findIntegrationsByUser: list,
    getAuthenticatedDomains: async () => [],
  };
  const get = Function(
    'repo',
    'log',
    'withDerivedConnectedEmails',
    'findReadableInboxEmails',
    'redactLanternIntegration',
    'settleLinkedInSync',
    `return (${extract(service, 'getIntegrations')});`
  )(
    repo,
    { info() {} },
    derive,
    readable,
    redactLanternIntegration,
    // No LinkedIn row here; its settle behavior is owned by the integrations blackbox.
    async (_userId: string, rows: unknown[]) => rows
  );
  const one = await get('one');
  assert.deepEqual(
    one.integrations[0].readableInboxEmails,
    ['one@example.test'],
    'missing user-scoped readable inbox binding'
  );
  assert.equal(integrationQueries.length, 1);
  assert.deepEqual(integrationQueries[0].where, { userId: 'one' });
  assert.equal(healthCalls, 1, 'scope-health projection remains applied');
  assert.equal(queries.length, 1, 'one shared predicate query, not one query per integration');
  assert.equal('readableInboxEmails' in one.integrations[1], false);
  assert.deepEqual(
    one.integrations[2].readableInboxEmails,
    ['one@example.test'],
    'multiple Gmail rows share the same user-scoped receiving set'
  );
  assert(!JSON.stringify(one).includes('secret-access'));
  assert(!JSON.stringify(one).includes('secret-refresh'));
  assert.deepEqual(one.integrations[3].config, {}, 'actual Lantern redactor remains applied');
  assert(!JSON.stringify(one).includes('secret-lantern-envelope'));
  const empty = await get('empty');
  assert.deepEqual(empty.integrations[0].readableInboxEmails, []);
  const foreign = await get('foreign');
  assert.deepEqual(foreign.integrations[0].readableInboxEmails, ['foreign@example.test']);
  assert(!JSON.stringify(one).includes('foreign@example.test'));
}

async function main() {
  testProductionRequiresPublicBackendUrl();
  testBackendBaseUrlUsesProductionEnv();
  testPlaidProductionProductsMatchApprovedAccess();
  await testReadableInboxProjection();
}

main()
  .then(() => {
    process.stdout.write('integrations config structural tests passed\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  });
