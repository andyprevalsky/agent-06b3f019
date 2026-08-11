#!/usr/bin/env tsx

import assert from 'node:assert';
import {
  createSessionWithContextUsingDependencies,
  type BrowserSessionCreationDependencies,
} from '../../providers/browser';
import { buildPreferredBrowserConfig } from '../../providers/browser/challengeRecovery';
import {
  INVALIDATED_STEEL_PROFILE_SOURCE,
  providerProfileMismatch,
  recordedProviderProfileBinding,
} from '../../providers/browser/profileBinding';
import { reusableSteelRecordedProfileId } from '../../providers/steel/sessionResume';

const location = { country: 'US', state: 'CA', city: 'SAN FRANCISCO' };

function providerSession(provider: 'kernel' | 'steel', sessionId = `${provider}-session`) {
  return {
    provider,
    sessionId,
    debugUrl: `https://${provider}.example/debug`,
    taskId: `${sessionId}-task`,
    wsUrl: `wss://${provider}.example/cdp`,
    proxySource: `${provider}-proxy`,
    proxyLocation: location,
    profileId: null,
    profileSource: 'test',
    validationBrowser: null,
  } as const;
}

function steelSession(sessionId = 'steel-session') {
  const session = providerSession('steel', sessionId);
  return {
    sessionId,
    debugUrl: session.debugUrl,
    taskId: session.taskId,
    wsUrl: session.wsUrl,
    proxySource: session.proxySource,
    proxyLocation: session.proxyLocation,
    steelProfileId: 'steel-auth-profile',
    profileSource: session.profileSource,
    validationBrowser: null,
  };
}

async function requiredProfileOverridesProviderPreference(): Promise<void> {
  const cached = buildPreferredBrowserConfig(
    {
      key: 'kernel_isp',
      provider: 'kernel',
      proxyMode: 'isp_city',
      kernelProxyType: 'isp',
      kernelSpecificity: 'city',
    },
    location
  );
  let kernelCalls = 0;
  const steelOptions: unknown[] = [];
  const dependencies: BrowserSessionCreationDependencies = {
    readPreferredConfig: async () => cached,
    defaultProvider: () => 'kernel',
    createKernel: async () => {
      kernelCalls += 1;
      return providerSession('kernel');
    },
    createSteel: async (_contextId, _agentId, _location, _url, options) => {
      steelOptions.push(options);
      return steelSession();
    },
  };

  const session = await createSessionWithContextUsingDependencies(
    'context-1',
    'agent-1',
    location,
    'https://uber.com/',
    {
      keepValidationConnection: true,
      requiredSteelProfileId: 'steel-auth-profile',
    },
    dependencies
  );

  assert.strictEqual(session.provider, 'steel');
  assert.strictEqual(kernelCalls, 0, 'saved Steel auth must not open an unrelated Kernel profile');
  assert.deepStrictEqual(steelOptions, [
    {
      keepValidationConnection: true,
      requiredSteelProfileId: 'steel-auth-profile',
    },
  ]);
}

async function concurrentSavedSteelSessionsRemainDistinct(): Promise<void> {
  const calls: Array<{ agentId: string; requiredProfileId: string | undefined }> = [];
  let sessionSequence = 0;
  const dependencies: BrowserSessionCreationDependencies = {
    readPreferredConfig: async () => null,
    defaultProvider: () => 'kernel',
    createKernel: async () => {
      throw new Error('saved Steel auth must not fall back to Kernel');
    },
    createSteel: async (_contextId, agentId, _location, _url, options) => {
      calls.push({
        agentId,
        requiredProfileId: options?.requiredSteelProfileId,
      });
      return steelSession(`steel-session-${++sessionSequence}`);
    },
  };

  const [first, second] = await Promise.all(
    ['agent-1', 'agent-2'].map((agentId) =>
      createSessionWithContextUsingDependencies(
        'context-1',
        agentId,
        location,
        'https://uber.com/',
        { requiredSteelProfileId: 'steel-auth-profile' },
        dependencies
      )
    )
  );

  assert.notStrictEqual(first.sessionId, second.sessionId);
  assert.deepStrictEqual(calls, [
    { agentId: 'agent-1', requiredProfileId: 'steel-auth-profile' },
    { agentId: 'agent-2', requiredProfileId: 'steel-auth-profile' },
  ]);
}

function requiredSteelAuthProfileFailsClosedOnMismatch(): void {
  // H-07: an enabled Steel SessionAuth snapshot MUST load exactly; a
  // different/NONE loaded profile id is a fatal mismatch.
  const authBinding = recordedProviderProfileBinding({
    providerProfileId: 'steel-auth-profile',
    providerProfileSource: 'steel_session_auth',
  });
  assert(authBinding !== undefined, 'required Steel auth session must produce a binding');
  assert.strictEqual(authBinding.required, true, 'steel_session_auth binding must be required');
  assert.strictEqual(
    providerProfileMismatch(authBinding, null),
    'loaded profile NONE instead of bound profile steel-auth-profile',
    'required binding must fail closed on a NONE loaded profile'
  );
  assert.strictEqual(
    providerProfileMismatch(authBinding, 'some-other-profile'),
    'loaded profile some-other-profile instead of bound profile steel-auth-profile',
    'required binding must fail closed on a different loaded profile'
  );
  assert.strictEqual(
    providerProfileMismatch(authBinding, 'steel-auth-profile'),
    null,
    'an exact match must never be flagged'
  );

  const readOnlyBinding = recordedProviderProfileBinding({
    providerProfileId: 'steel-auth-profile',
    providerProfileSource: 'steel_session_auth_read_only',
  });
  assert.strictEqual(
    readOnlyBinding?.required,
    true,
    'read-only Steel auth binding must also be required'
  );
}

function kernelManagedProfileDoesNotFailClosed(): void {
  // Kernel manages its own profiles; its create response does not reliably echo
  // the loaded profile id, so a recreate binding (user_persistent) must tolerate
  // a differing/NONE id instead of 500ing the rotate/resume path.
  for (const providerProfileSource of ['user_persistent', 'new_user_persistent', 'session_bound']) {
    const binding = recordedProviderProfileBinding({
      providerProfileId: 'e7cufm4qrkxq3f6jhp2jcm83',
      providerProfileSource,
    });
    assert(binding !== undefined, `${providerProfileSource} session must still produce a binding`);
    assert.strictEqual(
      binding.required,
      false,
      `${providerProfileSource} binding must be best-effort, not required`
    );
    assert.strictEqual(
      providerProfileMismatch(binding, null),
      null,
      `${providerProfileSource} binding must tolerate a NONE loaded profile`
    );
    assert.strictEqual(
      providerProfileMismatch(binding, 'e7cufm4qrkxq3f6jhp2jcm83-other'),
      null,
      `${providerProfileSource} binding must tolerate a different loaded profile`
    );
  }

  assert.strictEqual(
    providerProfileMismatch(undefined, null),
    null,
    'no binding must never flag a mismatch'
  );
  assert.strictEqual(
    recordedProviderProfileBinding({ providerProfileId: null }),
    undefined,
    'an unrecorded profile must not produce a binding'
  );
}

function steelReplacementNeverReusesForeignProviderProfile(): void {
  // Kernel → Steel provider switch (the rotate ladder's 3rd rung): the recorded
  // Kernel profile id is not a Steel UUID and must NOT be passed to Steel, which
  // 400s on a non-UUID profileId. The Steel replacement must ignore it.
  assert.strictEqual(
    reusableSteelRecordedProfileId({
      provider: 'kernel',
      providerProfileId: 'e7cufm4qrkxq3f6jhp2jcm83',
    }),
    null,
    'a Kernel-origin profile must never be reused as a Steel profile'
  );

  // Steel → Steel resume/rotate: the recorded Steel profile is reloaded so
  // cookies/auth survive.
  assert.strictEqual(
    reusableSteelRecordedProfileId({
      provider: 'steel',
      providerProfileId: '11111111-2222-3333-4444-555555555555',
    }),
    '11111111-2222-3333-4444-555555555555',
    'a Steel-origin recorded profile must be reused on resume/rotate'
  );

  for (const providerProfileId of [null, undefined, '']) {
    assert.strictEqual(
      reusableSteelRecordedProfileId({ provider: 'steel', providerProfileId }),
      null,
      'an unrecorded Steel profile must fall back rather than reuse an empty id'
    );
  }
}

function invalidatedSteelProfileIsCompletionOnly(): void {
  const invalidatedSession = {
    provider: 'steel',
    providerProfileId: '11111111-2222-3333-4444-555555555555',
    providerProfileSource: INVALIDATED_STEEL_PROFILE_SOURCE,
  };
  assert.strictEqual(
    reusableSteelRecordedProfileId(invalidatedSession),
    null,
    'an invalidated Steel profile must not be reloaded during resume'
  );
  assert.strictEqual(
    recordedProviderProfileBinding(invalidatedSession),
    undefined,
    'an invalidated Steel profile must not become a provider replacement binding'
  );
}

async function main(): Promise<void> {
  await requiredProfileOverridesProviderPreference();
  await concurrentSavedSteelSessionsRemainDistinct();
  requiredSteelAuthProfileFailsClosedOnMismatch();
  kernelManagedProfileDoesNotFailClosed();
  steelReplacementNeverReusesForeignProviderProfile();
  invalidatedSteelProfileIsCompletionOnly();
  process.stdout.write('PASS browser provider profile binding\n');
}

void main();
