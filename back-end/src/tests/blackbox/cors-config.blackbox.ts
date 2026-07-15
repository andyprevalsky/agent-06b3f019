#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { PRODUCTION_WEB_ORIGINS, resolveAllowedOrigins } from '../../providers/corsConfig';

const processEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  ALLOWED_ORIGINS: PRODUCTION_WEB_ORIGINS.join(','),
};

assert.deepEqual(resolveAllowedOrigins(processEnvironment), [...PRODUCTION_WEB_ORIGINS]);

process.stdout.write('CORS ProcessEnv boundary contract passed\n');
