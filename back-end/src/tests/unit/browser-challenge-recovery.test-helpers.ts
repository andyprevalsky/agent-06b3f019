import type { Browser } from 'playwright';
import {
  type BrowserRecoveryConfig,
  type RecoveryCandidateSession,
} from '../../providers/browser/challengeRecovery';
import type { BrowserSessionCreationDependencies } from '../../providers/browser';

export function fakeSession(config: BrowserRecoveryConfig): RecoveryCandidateSession {
  return {
    provider: config.provider,
    sessionId: `session-${config.key}`,
    debugUrl: `https://debug/${config.key}`,
    wsUrl: `wss://cdp/${config.key}`,
    proxySource: config.proxyMode,
    proxyLocation: { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
    profileId: null,
    profileSource: 'challenge_candidate_ephemeral',
    validationBrowser: {} as Browser,
  };
}

export function providerSession(provider: 'kernel' | 'steel') {
  return {
    provider,
    sessionId: `${provider}-session`,
    debugUrl: `https://${provider}.example/debug`,
    taskId: `${provider}-task`,
    wsUrl: `wss://${provider}.example/cdp`,
    proxySource: `${provider}-proxy`,
    proxyLocation: { country: 'US', state: 'CA', city: 'SAN FRANCISCO' },
    profileId: null,
    profileSource: 'test',
    validationBrowser: null,
  } as const;
}

export function steelSession() {
  const session = providerSession('steel');
  return {
    sessionId: session.sessionId,
    debugUrl: session.debugUrl,
    taskId: session.taskId,
    wsUrl: session.wsUrl,
    proxySource: session.proxySource,
    proxyLocation: session.proxyLocation,
    steelProfileId: null,
    profileSource: session.profileSource,
    validationBrowser: null,
  };
}

export type { BrowserSessionCreationDependencies };
