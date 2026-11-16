/** Imported by the existing phone provider unit gate; all model/pricing IO mocked. */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { StructuredOutputAccumulator } from '../../providers/rose/structuredOutput';
import { settingsPurpose } from '../../providers/phoneSetupPurpose';
import { SETUP_TARGETS, requiresGoogleIdentity } from '../../providers/phoneSetupVerification';
import type { CompletionOptions, CompletionChunk } from '../../providers/rose/types';

test('phone setup canonical Rose wrapper purpose, evidence, timeout and actual usage fail closed', async () => {
  let text = '{"identityConfirmed":true}',
    actual = 'actual-identity-model',
    hasUsage = true,
    priced = '';
  let captured: CompletionOptions | undefined;
  let deadline = 0;
  let calls = 0;
  // Per-sample outputs, in call order, before falling back to `text`.
  const queued: string[] = [];
  await mock.module('../../providers/rose', {
    namedExports: {
      StructuredOutputAccumulator,
      createStreamingCompletion: async (options: CompletionOptions) => {
        captured = options;
        calls++;
        const content = queued.shift() ?? text;
        if (content === 'OUTAGE') throw new Error('synthetic sample outage');
        return (async function* () {
          yield {
            choices: [{ delta: { content } }],
            actual_model: actual,
            requested_model: 'rose-labs/rose-1-mini',
            pool_name: 'mini',
            pool_size: 1,
            ...(hasUsage
              ? { usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } }
              : {}),
          } as CompletionChunk;
        })();
      },
    },
  });
  await mock.module('../../providers/modelPricing', {
    namedExports: {
      getModelPricing: async (model: string) => {
        priced = model;
        return { prompt: '0.000002', completion: '0.00001' };
      },
    },
  });
  const { verifyPhoneSetup, PHONE_SETUP_PURPOSE } =
    await import('../../providers/phoneSetupVerifier');
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => {
    deadline = ms;
    return timeout(ms);
  };
  try {
    const input = {
      agentId: 'synthetic-agent',
      expectedAppleIdentity: 'synthetic@example.invalid',
      evidence: [
        { operationId: 'stored-read', cursor: 7, result: { text: 'Actual server observation' } },
      ],
    };
    assert.ok(PHONE_SETUP_PURPOSE.includes('editable sign-in form'));
    assert.ok(PHONE_SETUP_PURPOSE.includes('account suggestions'));
    const result = await verifyPhoneSetup(input);
    assert.equal(result.identityConfirmed, true);
    assert.equal(priced, 'actual-identity-model');
    // Every independent sample is billed: 3 samples x ceil(1 cent), 3 x 1000 prompt tokens.
    assert.equal(calls, 3);
    assert.equal(result.usage.model, 'actual-identity-model');
    assert.equal(result.usage.totalCostCents, 3);
    assert.equal(result.usage.promptTokens, 3000);
    assert.equal(result.usage.totalTokens, 3030);
    assert.equal(deadline, 60000);
    assert.equal(captured?.messages[0].content, PHONE_SETUP_PURPOSE);
    assert.equal(captured?.route_key, input.agentId);
    // Archived in the agent tree's root bundle under the ledger's call site;
    // the root is resolved off the call path from archive_scope.
    assert.deepEqual(captured?.dump_context, {
      call_site: 'phone_setup_identity',
      agent_id: input.agentId,
      archive_scope: { agentId: input.agentId },
    });
    assert.deepEqual(JSON.parse(captured!.messages[1].content as string), {
      expectedAppleIdentity: input.expectedAppleIdentity,
      observations: input.evidence,
    });
    assert.equal(captured?.max_tokens, 128);
    // One outlier sample never decides; two agreeing samples do (negative control).
    queued.push('{"identityConfirmed":true}', '{"identityConfirmed":false}', 'not-json');
    assert.equal(
      (await verifyPhoneSetup(input)).identityConfirmed,
      false,
      'One confirming sample established readiness'
    );
    queued.push(
      '{"identityConfirmed":false}',
      '{"identityConfirmed":true}',
      '{"identityConfirmed":true}'
    );
    assert.equal((await verifyPhoneSetup(input)).identityConfirmed, true);
    const receive = { ...input, verificationTarget: 'receive_address' as const };
    for (const [samples, expected] of [
      [['confirmed', 'unknown', 'disabled'], 'unknown'],
      [['disabled', 'confirmed', 'unknown'], 'unknown'],
      [['unknown', 'disabled', 'disabled'], 'disabled'],
      [['confirmed', 'disabled', 'confirmed'], 'confirmed'],
    ] as const) {
      queued.push(...samples.map((status) => JSON.stringify({ status })));
      assert.equal(
        (await verifyPhoneSetup(receive)).status,
        expected,
        `samples ${samples.join(',')} must verify ${expected}`
      );
    }
    assert.equal(queued.length, 0);
    // One failed sample is not an outage: the two completed samples still need to agree.
    queued.push(
      JSON.stringify({ status: 'disabled' }),
      'OUTAGE',
      JSON.stringify({ status: 'disabled' })
    );
    const partial = await verifyPhoneSetup(receive);
    assert.equal(partial.status, 'disabled');
    assert.equal(partial.usage.samples?.length, 2, 'Only completed samples are billed');
    assert.equal(partial.usage.promptTokens, 2000);
    queued.push(
      JSON.stringify({ status: 'confirmed' }),
      'OUTAGE',
      JSON.stringify({ status: 'unknown' })
    );
    assert.equal((await verifyPhoneSetup(receive)).status, 'unknown');
    queued.push('OUTAGE', JSON.stringify({ status: 'confirmed' }), 'OUTAGE');
    await assert.rejects(verifyPhoneSetup(receive), /synthetic sample outage/);
    // A runtime tuple is one sample's own observation, never assembled across samples.
    const runtime = { ...input, verificationTarget: 'runtime' as const };
    const observed = (sync: string, reason: string) =>
      JSON.stringify({ status: 'confirmed', runtime: { sync, activation: 'active', reason } });
    queued.push(
      observed('paused', 'low_power'),
      observed('paused', 'network'),
      observed('syncing', 'network')
    );
    const mixed = await verifyPhoneSetup(runtime);
    assert.equal(mixed.status, 'unknown', 'Field-wise majorities invented a runtime');
    assert.equal(mixed.runtime, undefined);
    queued.push(
      observed('syncing', 'network'),
      observed('paused', 'low_power'),
      observed('paused', 'low_power')
    );
    assert.deepEqual((await verifyPhoneSetup(runtime)).runtime, {
      sync: 'paused',
      activation: 'active',
      reason: 'low_power',
    });
    // Usage is itemized per sample at the model that actually served it.
    actual = 'served-model-a';
    const itemized = await verifyPhoneSetup(input);
    assert.deepEqual(
      itemized.usage.samples?.map((sample) => [sample.model, sample.promptTokens]),
      [
        ['served-model-a', 1000],
        ['served-model-a', 1000],
        ['served-model-a', 1000],
      ]
    );
    actual = 'actual-identity-model';
    assert.equal(queued.length, 0);
    text = '{"identityConfirmed":false}';
    assert.equal((await verifyPhoneSetup(input)).identityConfirmed, false);
    text = 'not-json';
    assert.equal(
      (await verifyPhoneSetup(input)).identityConfirmed,
      false,
      'Malformed output must not establish readiness'
    );
    text = '{"identityConfirmed":"true"}';
    assert.equal((await verifyPhoneSetup(input)).identityConfirmed, false);
    text = '{"identityConfirmed":true}';
    actual = 'gpt-5.6-luna-foundry';
    assert.equal(
      (await verifyPhoneSetup(input)).usage.totalCostCents,
      0,
      'Canonical funded Foundry user-facing policy must apply'
    );
    for (const verificationTarget of SETUP_TARGETS.filter((target) => target !== 'apple_account')) {
      text = JSON.stringify({
        status: 'confirmed',
        runtime: { sync: 'paused', activation: 'active', reason: 'unknown' },
      });
      const check = await verifyPhoneSetup({
        ...input,
        verificationTarget,
        expectedReceiveAddress: '+19729777432',
        ...(requiresGoogleIdentity(verificationTarget)
          ? { expectedGoogleIdentity: 'google@example.invalid' }
          : {}),
      });
      assert.equal(check.status, 'confirmed');
      assert.equal(captured?.dump_context?.call_site, `phone_setup_${verificationTarget}`);
      assert.deepEqual(captured?.dump_context?.archive_scope, { agentId: input.agentId });
      assert.equal(captured?.messages[0].content, settingsPurpose(verificationTarget));
      assert.deepEqual(JSON.parse(captured!.messages[1].content as string), {
        expectedAppleIdentity: input.expectedAppleIdentity,
        observations: input.evidence,
        expectedReceiveAddress: '+19729777432',
        ...(requiresGoogleIdentity(verificationTarget)
          ? { expectedGoogleIdentity: 'google@example.invalid' }
          : {}),
      });
      assert.ok(
        settingsPurpose(verificationTarget).includes(
          'visual state not explicitly represented must remain unknown'
        )
      );
      if (verificationTarget === 'gmail') {
        assert.ok(settingsPurpose(verificationTarget).includes('remembered or disabled accounts'));
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'unknown without active signed-in Gmail context'
          )
        );
        assert.ok(settingsPurpose(verificationTarget).includes('future Google sign-in challenge'));
        assert.ok(
          settingsPurpose(verificationTarget).includes('per-account Settings screen inside Gmail')
        );
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'A Google Account page alone does not identify the Gmail app'
          )
        );
      }
      if (verificationTarget === 'imessage' || verificationTarget === 'receive_address')
        assert.ok(settingsPurpose(verificationTarget).includes('Caller ID'));
      if (verificationTarget === 'receive_address')
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'inside the You Can Receive iMessages to and Reply From list'
          )
        );
      if (verificationTarget === 'imessage')
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'on that Send and Receive screen clearly naming a different identity is disabled'
          )
        );
      if (verificationTarget === 'imessage')
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'unless any observation shows Waiting for activation'
          )
        );
      assert.ok(
        settingsPurpose(verificationTarget).includes(
          'counts as explicit selection only for that row; switches have no text'
        )
      );
      if (verificationTarget === 'google_passcode_exception') {
        assert.ok(settingsPurpose(verificationTarget).includes('account menu alone'));
        assert.ok(settingsPurpose(verificationTarget).includes('blocking Device Policy Alert'));
        assert.ok(settingsPurpose(verificationTarget).includes('Never infer admin authority'));
      }
      if (verificationTarget === 'icloud_contacts') {
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'contact names, counts, or populated Contacts app do not establish synchronization enabled'
          )
        );
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'Never infer complete contact-history synchronization'
          )
        );
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'services line explicitly listing Contacts establishes iCloud Contacts synchronization On'
          )
        );
      }
      if (verificationTarget === 'portrait_lock') {
        assert.ok(
          settingsPurpose(verificationTarget).includes('Portrait Orientation Lock is enabled or On')
        );
        assert.ok(
          settingsPurpose(verificationTarget).includes(
            'dimensions, current orientation, and a portrait screenshot do not establish lock state'
          )
        );
      }
      if (verificationTarget === 'runtime') assert.equal(check.runtime?.sync, 'paused');
      text = '{"status":"yes","runtime":null}';
      assert.equal((await verifyPhoneSetup({ ...input, verificationTarget })).status, 'unknown');
    }
    actual = 'actual-identity-model';
    hasUsage = false;
    await assert.rejects(verifyPhoneSetup(input));
    hasUsage = true;
    actual = '';
    await assert.rejects(verifyPhoneSetup(input));
  } finally {
    AbortSignal.timeout = timeout;
    mock.restoreAll();
  }
});
