/** Strict opt-in rollout config; no prefix matching or anonymous grants. */
import assert from 'node:assert/strict';
import { parsePhoneAllowlist } from '../../providers/phoneAllowlist';
import { permitted } from '../../providers/phoneAccountPolicy';
import { phoneFixtureNumber } from './phone-fixture-users';
assert.deepEqual(parsePhoneAllowlist(undefined), []);
assert.deepEqual(parsePhoneAllowlist('+15550000111, +15550000111'), ['+15550000111']);
for (const value of [
  '*',
  '+1555*',
  '15550000111',
  '+15550000111,',
  Array(513).fill('+15550000111').join(','),
]) {
  assert.throws(() => parsePhoneAllowlist(value));
}
const previous = process.env.CLOUD_IPHONE_ENABLED;
try {
  const phone = phoneFixtureNumber();
  const user = { userId: 'synthetic-policy-owner', phone, isAnonymous: false };
  process.env.CLOUD_IPHONE_ENABLED = 'false';
  assert.equal(permitted(user), false);
  process.env.CLOUD_IPHONE_ENABLED = 'true';
  assert.equal(permitted(user), true);
  assert.equal(permitted({ ...user, isAnonymous: true }), false);
  assert.equal(permitted({ ...user, phone: '+18880000111' }), false);
  process.stdout.write(
    'PASS exact phone allowlist, malformed config, anonymous and disabled rejection\n'
  );
} finally {
  if (previous === undefined) delete process.env.CLOUD_IPHONE_ENABLED;
  else process.env.CLOUD_IPHONE_ENABLED = previous;
}
