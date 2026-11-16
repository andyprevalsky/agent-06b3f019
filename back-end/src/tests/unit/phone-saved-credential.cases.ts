import assert from 'node:assert/strict';
import { test } from 'node:test';
import semanticFixture from './phone-saved-credential.semantic-fixture.json';
import googleFixture from './phone-saved-credential.google-semantic-fixture.json';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import type { CompletionOptions, CompletionChunk } from '../../providers/rose/types';
test('saved phone credential binding uses fixed actual-evidence Rose purpose and actual usage', async (t) => {
  const mock = t.mock;
  let captured: CompletionOptions | undefined;
  let actual = 'saved-binding-model';
  let response: {
    allowed: boolean;
    x: number;
    y: number;
    credentialRealm?: string;
    passcodeStage?: string;
  } = {
    allowed: true,
    x: 50,
    y: 70,
  };
  await mock.module('../../providers/rose', {
    namedExports: {
      StructuredOutputAccumulator,
      createStreamingCompletion: async (options: CompletionOptions) => {
        captured = options;
        return (async function* () {
          yield {
            choices: [{ delta: { content: JSON.stringify(response) } }],
            actual_model: actual,
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          } as CompletionChunk;
        })();
      },
    },
  });
  await mock.module('../../providers/modelPricing', {
    namedExports: {
      getModelPricing: async (model: string) =>
        model.endsWith('-foundry') ? null : { prompt: '0.000001', completion: '0.00001' },
    },
  });
  const { verifyPhoneCredential, PHONE_CREDENTIAL_PURPOSE, PHONE_MULTI_CREDENTIAL_PURPOSE } =
    await import('../../providers/phoneCredentialVerifier');
  const input = {
    agentId: 'fixture-agent',
    expectedAppleIdentity: 'fixture@example.invalid',
    evidence: [
      { operationId: 'stored-observation', cursor: 4, result: { text: 'Actual observed form' } },
    ],
    bounds: { x: 0, y: 0, w: 390, h: 844 },
  };
  assert.ok(PHONE_CREDENTIAL_PURPOSE.includes('NOT proof the account is already signed in'));
  assert.ok(PHONE_CREDENTIAL_PURPOSE.includes('absent onscreen keyboard'));
  const result = await verifyPhoneCredential(input);
  assert.equal(result.allowed, true);
  assert.equal(result.x, 50);
  assert.equal(result.usage?.model, 'saved-binding-model');
  assert.equal(result.usage?.totalCostCents, 1);
  assert.equal(captured?.messages[0].content, PHONE_CREDENTIAL_PURPOSE);
  // The archive record is labelled with the call site the ledger bills it under.
  assert.equal(captured?.dump_context?.call_site, 'phone_saved_credential_binding');
  assert.ok(PHONE_CREDENTIAL_PURPOSE.includes('Other apps'));
  assert.deepEqual(JSON.parse(captured!.messages[1].content as string), {
    expectedAppleIdentity: input.expectedAppleIdentity,
    observations: input.evidence,
    bounds: input.bounds,
  });
  assert.equal(captured?.route_key, input.agentId);
  assert.ok(captured?.abort_signal instanceof AbortSignal);
  assert.equal(PHONE_CREDENTIAL_PURPOSE, semanticFixture.recordedPurpose);
  for (const fixture of semanticFixture.cases) {
    response = {
      allowed: fixture.recorded.allowed,
      x: fixture.recorded.x ?? 0,
      y: fixture.recorded.y ?? 0,
    };
    const replay = await verifyPhoneCredential(fixture.input);
    assert.equal(replay.allowed, fixture.name === 'positive', fixture.name);
    assert.deepEqual(
      JSON.parse(captured!.messages[1].content as string),
      {
        expectedAppleIdentity: fixture.input.expectedAppleIdentity,
        observations: fixture.input.evidence,
        bounds: fixture.input.bounds,
      },
      fixture.name
    );
    if (fixture.name === 'positive') {
      assert.equal(replay.x, fixture.recorded.x);
      assert.equal(replay.y, fixture.recorded.y);
    } else {
      assert.equal(replay.x, undefined);
      assert.equal(replay.y, undefined);
    }
  }
  // Prod 2026-11-14: account suggestions covering the Google password field must not bind,
  // even with its floated label still visible (synthetic variant);
  // visible unfocused and focused (floated-label) fields bind to a point on that field.
  assert.equal(PHONE_MULTI_CREDENTIAL_PURPOSE, googleFixture.recordedPurpose);
  for (const fixture of googleFixture.cases) {
    const recorded = fixture.recorded as { allowed: boolean; x?: number; y?: number };
    response = {
      allowed: recorded.allowed,
      credentialRealm: recorded.allowed ? 'google' : 'unknown',
      x: recorded.x ?? 0,
      y: recorded.y ?? 0,
    };
    const replay = await verifyPhoneCredential(fixture.input);
    assert.equal(captured?.messages[0].content, PHONE_MULTI_CREDENTIAL_PURPOSE);
    const covered = ['occluded-by-suggestions', 'covered-with-visible-label'].includes(
      fixture.name
    );
    assert.equal(replay.allowed, !covered, fixture.name);
    if (!replay.allowed) continue;
    assert.equal(replay.credentialRealm, 'google');
    const items = fixture.input.evidence[0].result as { text: string; y: number; h: number }[];
    const account = items.find((item) => item.text === 'google@example.invalid')!;
    const show = items.find((item) => item.text === 'Show password')!;
    assert.ok(
      replay.y! > account.y + account.h / 2 && replay.y! < show.y - show.h / 2,
      `${fixture.name} bound outside the password field`
    );
  }
  response = { allowed: true, x: 50, y: 70, passcodeStage: 'create' };
  const passcodeInput = {
    ...input,
    purpose: 'device_passcode' as const,
    permittedPasscodeStage: 'create' as const,
  };
  const passcode = await verifyPhoneCredential(passcodeInput);
  assert.equal(passcode.allowed, true);
  assert.equal(passcode.passcodeStage, 'create');
  assert.equal(passcode.credentialRealm, undefined);
  assert.equal(captured?.dump_context?.call_site, 'phone_device_passcode_binding');
  assert.ok(String(captured?.messages[0].content).includes('MDM restrictions'));
  assert.ok(!JSON.stringify(captured?.messages).includes('1234'));
  assert.equal(
    JSON.parse(captured!.messages[1].content as string).expectedAppleIdentity,
    undefined
  );
  response = { allowed: true, x: 50, y: 70, passcodeStage: 'acknowledge' };
  assert.equal(
    (
      await verifyPhoneCredential({
        ...passcodeInput,
        permittedPasscodeStage: 'confirm_or_acknowledge',
      })
    ).allowed,
    true
  );
  assert.equal(
    (await verifyPhoneCredential({ ...passcodeInput, permittedPasscodeStage: 'confirm' })).allowed,
    false
  );
  response = { allowed: true, x: 50, y: 70, passcodeStage: 'confirm' };
  assert.equal((await verifyPhoneCredential(passcodeInput)).allowed, false);
  response = { allowed: false, x: 0, y: 0, passcodeStage: 'unknown' };
  assert.equal((await verifyPhoneCredential(passcodeInput)).allowed, false);
  response = { allowed: true, x: 50, y: 70, credentialRealm: 'google' };
  const google = await verifyPhoneCredential({
    ...input,
    expectedGoogleIdentity: 'google@example.invalid',
  });
  assert.equal(google.credentialRealm, 'google');
  assert.equal(
    JSON.parse(captured!.messages[1].content as string).expectedGoogleIdentity,
    'google@example.invalid'
  );
  assert.equal(
    (await verifyPhoneCredential(input)).allowed,
    false,
    'Google realm cannot use missing Google profile or Apple identity'
  );
  response = { allowed: true, x: 50, y: 70, credentialRealm: 'apple' };
  assert.equal(
    (await verifyPhoneCredential({ ...input, expectedGoogleIdentity: 'google@example.invalid' }))
      .credentialRealm,
    'apple'
  );
  response = { allowed: true, x: 50, y: 70, credentialRealm: 'unknown' };
  assert.equal(
    (await verifyPhoneCredential({ ...input, expectedGoogleIdentity: 'google@example.invalid' }))
      .allowed,
    false,
    'Ambiguous realm must not select a credential'
  );
  response = { allowed: true, x: 50, y: 70 };
  actual = 'gpt-5.6-luna-foundry';
  const foundry = await verifyPhoneCredential(input);
  assert.equal(foundry.allowed, true);
  assert.equal(foundry.usage?.model, actual);
  assert.equal(foundry.usage?.promptTokens, 100);
  assert.equal(
    foundry.usage?.totalCostCents,
    0,
    'Canonical Foundry user-facing pricing must retain actual usage without unknown-model lookup'
  );
});
