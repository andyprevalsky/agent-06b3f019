import assert from 'node:assert/strict';

// The contact card must carry the number that actually answers this recipient:
// the Linq number when their texts route through Linq, else the Surge number.
async function main(): Promise<void> {
  const saved = { ...process.env };
  try {
    const { rosePhoneFor } = await import('../../domains/vcard/service');
    const linq = '+12054015445';
    const surge = '+14154498072';
    Object.assign(process.env, {
      SMS_PROVIDER: 'linq',
      LINQ_FROM_PHONE: linq,
      LINQ_RECIPIENTS: '+19729777432',
    });
    assert.equal(rosePhoneFor('+19729777432'), linq, 'allowlisted recipient saves the Linq number');
    assert.equal(
      rosePhoneFor('+12025550000'),
      surge,
      'Surge-routed recipient saves the Surge number'
    );
    delete process.env.LINQ_RECIPIENTS;
    assert.equal(
      rosePhoneFor('+12025550000'),
      linq,
      'open rollout: everyone saves the Linq number'
    );
    assert.equal(rosePhoneFor(null), linq);
    process.env.SMS_PROVIDER = 'surge';
    assert.equal(rosePhoneFor('+19729777432'), surge, 'Linq off: Surge number');
    process.env.SMS_PROVIDER = 'linq';
    delete process.env.LINQ_FROM_PHONE;
    assert.equal(rosePhoneFor('+19729777432'), surge, 'no Linq number configured: Surge number');
  } finally {
    process.env = saved;
  }
  process.stdout.write('PASS vCard number follows the recipient routing (Linq vs Surge)\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
