// Blackbox: runGateConnectAction dispatches a Gate's primary "link" action to
// the correct connect surface, reusing the Integrations connect paths instead
// of opening a stale pre-minted URL.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startGmailOAuthApi = vi.fn();
vi.mock('@/features/integrations/api', () => ({
  startGmailOAuthApi: (returnUrl?: string) => startGmailOAuthApi(returnUrl),
}));

const startSubscriptionCheckoutApi = vi.fn();
vi.mock('@/features/billing/api', () => ({
  startSubscriptionCheckoutApi: (returnUrl?: string) => startSubscriptionCheckoutApi(returnUrl),
}));

import { runGateConnectAction } from '@/features/terminal-component-group/components/attention-inbox/gateConnect';
import type { GateMetadata } from '@/features/terminal-component-group/components/attention-inbox/types';

function sourceGate(sourceKey: string): GateMetadata {
  return {
    gateKey: `source_connect:${sourceKey}`,
    type: 'source_connect',
    presentation: { title: `Connect ${sourceKey}`, reason: 'need it', cta: `Connect ${sourceKey}` },
    action: { kind: 'link', url: `https://roselabs.ai/connect/${sourceKey}?stale=1` },
  };
}

// jsdom's window.location.assign is non-configurable, so replace the whole
// location object with a spyable stub for each test.
const realLocation = window.location;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'location');
  (window as unknown as { location: unknown }).location = {
    href: 'https://app.roselabs.ai/?agent-id=agent-7',
    assign,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  startGmailOAuthApi.mockReset();
  startSubscriptionCheckoutApi.mockReset();
  delete (window as unknown as { api?: unknown }).api;
  (window as unknown as { location: unknown }).location = realLocation;
});

describe('runGateConnectAction', () => {
  it('mints a FRESH Gmail OAuth url on click and navigates to it (not the stale gate url)', async () => {
    startGmailOAuthApi.mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/fresh' });

    await runGateConnectAction(sourceGate('gmail'), { requestId: 'req-1' });

    expect(startGmailOAuthApi).toHaveBeenCalledWith('https://app.roselabs.ai/?agent-id=agent-7');
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/fresh');
    expect(assign).not.toHaveBeenCalledWith(expect.stringContaining('stale=1'));
  });

  it('opens the Gmail url through the Mac-app bridge, returning via the app deep link', async () => {
    startGmailOAuthApi.mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/fresh' });
    const openExternal = vi.fn();
    (window as unknown as { api?: unknown }).api = { openExternal };

    await runGateConnectAction(sourceGate('email'), { requestId: 'req-1' });

    expect(startGmailOAuthApi).toHaveBeenCalledWith('roselabs://oauth-complete');
    expect(openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/fresh');
  });

  it('deep-links Mac-app-only sources to roselabs://connect-source', async () => {
    await runGateConnectAction(sourceGate('imessage'), { requestId: 'req-9', agentId: 'agent-7' });

    const url = assign.mock.calls[0]?.[0] as string;
    expect(url.startsWith('roselabs://connect-source?')).toBe(true);
    expect(url).toContain('source=imessage');
    expect(url).toContain('gateId=req-9');
    expect(url).toContain('agentId=agent-7');
    expect(startGmailOAuthApi).not.toHaveBeenCalled();
  });

  it('maps legacy source_connect:sms gates to the iMessage Mac-app deep link', async () => {
    await runGateConnectAction(sourceGate('sms'), { requestId: 'req-sms', agentId: 'agent-7' });

    const url = assign.mock.calls[0]?.[0] as string;
    expect(url).toContain('source=imessage');
    expect(url).not.toContain('source=sms');
    expect(startGmailOAuthApi).not.toHaveBeenCalled();
  });

  it('mints a FRESH subscription checkout url on click and opens it (not the stale gate url)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    startSubscriptionCheckoutApi.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/fresh-subscription',
    });
    const gate: GateMetadata = {
      gateKey: 'subscription',
      type: 'subscription',
      presentation: { title: 'Subscribe', reason: 'x', cta: 'Subscribe · $30/mo' },
      action: { kind: 'link', url: 'https://checkout.stripe.com/c/stale' },
    };

    await runGateConnectAction(gate, { requestId: 'req-2' });

    expect(startSubscriptionCheckoutApi).toHaveBeenCalledWith(
      'https://app.roselabs.ai/?agent-id=agent-7',
    );
    expect(open).toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/fresh-subscription',
      '_blank',
      'noopener,noreferrer',
    );
    expect(open).not.toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/stale',
      expect.anything(),
      expect.anything(),
    );
    expect(startGmailOAuthApi).not.toHaveBeenCalled();
  });

  it('opens kyc checkout links in a new tab using the carried url', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const gate: GateMetadata = {
      gateKey: 'kyc',
      type: 'kyc',
      presentation: { title: 'Verify', reason: 'x', cta: 'Verify identity' },
      action: { kind: 'link', url: 'https://checkout.stripe.com/c/kyc-session' },
    };

    await runGateConnectAction(gate, { requestId: 'req-kyc' });

    expect(startSubscriptionCheckoutApi).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/kyc-session',
      '_blank',
      'noopener,noreferrer',
    );
    expect(startGmailOAuthApi).not.toHaveBeenCalled();
  });

  it('falls back to the carried subscription url if the fresh mint fails', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    startSubscriptionCheckoutApi.mockRejectedValue(new Error('checkout down'));
    const gate: GateMetadata = {
      gateKey: 'subscription',
      type: 'subscription',
      presentation: { title: 'Subscribe', reason: 'x', cta: 'Subscribe · $30/mo' },
      action: { kind: 'link', url: 'https://checkout.stripe.com/c/stale' },
    };

    await runGateConnectAction(gate, { requestId: 'req-sub-fallback' });

    expect(open).toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/stale',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens subscription links through the Mac-app bridge when embedded', async () => {
    const openExternal = vi.fn();
    (window as unknown as { api?: unknown }).api = { openExternal };
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    startSubscriptionCheckoutApi.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/fresh-subscription',
    });
    const gate: GateMetadata = {
      gateKey: 'subscription',
      type: 'subscription',
      presentation: { title: 'Subscribe', reason: 'x', cta: 'Subscribe · $30/mo' },
      action: { kind: 'link', url: 'https://checkout.stripe.com/c/session' },
    };

    await runGateConnectAction(gate, { requestId: 'req-2' });

    expect(startSubscriptionCheckoutApi).toHaveBeenCalledWith(undefined);
    expect(openExternal).toHaveBeenCalledWith('https://checkout.stripe.com/c/fresh-subscription');
    expect(open).not.toHaveBeenCalled();
  });

  it('falls back to the carried url if the fresh Gmail mint fails', async () => {
    startGmailOAuthApi.mockRejectedValue(new Error('oauth down'));

    await runGateConnectAction(sourceGate('gmail'), { requestId: 'req-3' });

    expect(assign).toHaveBeenCalledWith(expect.stringContaining('stale=1'));
  });
});
