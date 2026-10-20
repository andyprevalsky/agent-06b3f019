import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { sealPhoneValue, openPhoneValue } from '../../providers/phoneHarnessCredentials';
import { internalPhoneObservation, privateResult } from '../../providers/phoneInputPrivacy';
test('internal configured-identity projection preserves public masking and bounded private-value authority', () => {
  const prior = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(privateKey).toString('base64');
  try {
    const identity = 'configured@example.invalid',
      secret = 'unregistered-private-secret';
    const value = { text: `Google ${identity}; ${secret}`, png_b64: 'private-media' };
    const vault = sealPhoneValue({ version: 1, active: false, values: [identity, secret] });
    const command = { operation: 'screen.text', actor: 'agent', state: 'SUCCEEDED' };
    const projected = internalPhoneObservation(command, value, vault, {
      expectedGoogleIdentity: identity,
    });
    assert.ok(JSON.stringify(projected).includes(identity));
    assert.ok(!JSON.stringify(projected).includes(secret));
    assert.ok(!JSON.stringify(projected).includes('private-media'));
    assert.ok(!JSON.stringify(privateResult(command, projected, vault)).includes(identity));
    assert.deepEqual(
      openPhoneValue(vault),
      { version: 1, active: false, values: [identity, secret] },
      'Projection mutated durable vault'
    );
    assert.deepEqual(
      internalPhoneObservation(command, { text: 'Google [private]' }, vault, {
        expectedGoogleIdentity: identity,
      }),
      { text: 'Google [private]' },
      'Historical masking was guessed into identity'
    );
    assert.ok(
      !JSON.stringify(
        internalPhoneObservation(command, value, vault, {
          expectedGoogleIdentity: 'other@example.invalid',
        })
      ).includes(identity)
    );
    for (const changed of [
      { ...command, state: 'FAILED' },
      { ...command, actor: 'user' },
      { ...command, operation: 'input.tap' },
    ])
      assert.deepEqual(
        internalPhoneObservation(changed, value, vault, { expectedGoogleIdentity: identity }),
        privateResult(changed, value, vault)
      );
    const active = sealPhoneValue({ version: 1, active: true, values: [identity, secret] });
    assert.deepEqual(
      internalPhoneObservation(command, value, active, { expectedGoogleIdentity: identity }),
      { private: true }
    );
    const longer = `${identity}#private-suffix`;
    const overlapping = sealPhoneValue({
      version: 1,
      active: false,
      values: [identity, longer, 'configured'],
    });
    const masked = JSON.stringify(
      internalPhoneObservation(command, { text: `${longer} ${identity}` }, overlapping, {
        expectedGoogleIdentity: identity,
      })
    );
    assert.ok(!masked.includes('private-suffix'));
    assert.ok(!masked.includes(identity), 'Other overlapping private fragments were exempted');
    // An exact password/identifier collision is already the literal supplied separately to this verifier.
    // It grants no authority over any other value; public results still mask that literal.
    assert.ok(JSON.stringify(projected).includes(identity));
    assert.ok(!JSON.stringify(privateResult(command, projected, vault)).includes(identity));
    assert.ok(!JSON.stringify(projected).includes(secret));
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
    else process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = prior;
  }
});
