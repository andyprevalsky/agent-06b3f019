import assert from 'node:assert/strict';

import {
  isAllowedRedirectUrl,
  isGranolaRedirectOrigin,
} from '../../domains/integrations/oauthService';

function test(name: string, run: () => void): void {
  run();
  process.stdout.write(`PASS oauth-redirect-patterns: ${name}\n`);
}

test('OAuth return URLs match whole hosts, never a look-alike prefix', () => {
  for (const url of [
    'http://localhost:5050/integrations',
    'http://127.0.0.1:8080/',
    'https://rose-pr-12.vercel.app/integrations?x=1',
    'https://roselabs.ai',
    'https://www.roselabs.ai/integrations#top',
    'roselabs://oauth/done',
  ]) {
    assert.equal(isAllowedRedirectUrl(url), true, url);
  }
  for (const url of [
    'https://www.roselabs.ai.evil.com/integrations',
    'https://roselabs.ai.evil.com',
    'http://localhost.evil.com/x',
    'http://localhost:5050.evil.com/x',
    'http://127.0.0.1.evil.com/',
    'https://evil.com/.vercel.app',
    'https://x.vercel.app.evil.com/',
    'https://evil.com@x.vercel.app.evil.com/',
  ]) {
    assert.equal(isAllowedRedirectUrl(url), false, url);
  }
});

test('Granola redirects go only to exact Rose web origins', () => {
  assert.equal(isGranolaRedirectOrigin('https://www.roselabs.ai'), true);
  assert.equal(isGranolaRedirectOrigin('https://roselabs.ai'), true);
  assert.equal(isGranolaRedirectOrigin('https://attacker.vercel.app'), false, 'no vercel suffix');
  assert.equal(isGranolaRedirectOrigin('https://www.roselabs.ai.evil.com'), false);
  const env = process.env.NODE_ENV;
  const origins = process.env.ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV = 'test';
    assert.equal(isGranolaRedirectOrigin('http://localhost:5050'), true, 'dev origin in dev');
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://www.roselabs.ai,https://roselabs.ai';
    assert.equal(isGranolaRedirectOrigin('http://localhost:5050'), false, 'no dev origin in prod');
  } finally {
    process.env.NODE_ENV = env;
    if (origins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = origins;
  }
});
