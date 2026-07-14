import assert from 'node:assert/strict';

import {
  isCorsOriginAllowed,
  PRODUCTION_WEB_ORIGINS,
  resolveAllowedOrigins,
} from '../../providers/corsConfig';

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
assert.equal(
  isCorsOriginAllowed('https://preview.vercel.app', productionOrigins, 'production'),
  false
);
assert.equal(
  isCorsOriginAllowed('https://preview.vercel.app', productionOrigins, 'development'),
  true
);
assert.equal(
  isCorsOriginAllowed(
    'https://explicit-preview.vercel.app',
    [...productionOrigins, 'https://explicit-preview.vercel.app'],
    'production'
  ),
  true
);

process.stdout.write('CORS startup configuration contracts passed\n');
