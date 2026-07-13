import assert from 'node:assert/strict';

import { PRODUCTION_WEB_ORIGINS, resolveAllowedOrigins } from '../../providers/corsConfig';

const localhostOrigins = resolveAllowedOrigins({ NODE_ENV: 'development' });
assert.ok(localhostOrigins.includes('http://localhost:8080'));

assert.throws(
  () => resolveAllowedOrigins({ NODE_ENV: 'production' }),
  /ALLOWED_ORIGINS is required in production/
);

assert.throws(
  () =>
    resolveAllowedOrigins({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: PRODUCTION_WEB_ORIGINS[0],
    }),
  /missing required production origins.*https:\/\/roselabs\.ai/
);

const productionOrigins = resolveAllowedOrigins({
  NODE_ENV: 'production',
  ALLOWED_ORIGINS: PRODUCTION_WEB_ORIGINS.join(','),
});
assert.deepEqual(productionOrigins, [...PRODUCTION_WEB_ORIGINS]);

process.stdout.write('CORS startup configuration contracts passed\n');
