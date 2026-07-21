import { describe, expect, it } from 'vitest';

import { shouldUsePrivateRealtimeChannels } from '../../lib/realtimeConfig';

describe('shouldUsePrivateRealtimeChannels', () => {
  it('defaults production builds to private channels', () => {
    expect(shouldUsePrivateRealtimeChannels(undefined, false)).toBe(true);
  });

  it('defaults development builds to public channels', () => {
    expect(shouldUsePrivateRealtimeChannels(undefined, true)).toBe(false);
  });

  it('allows a bundled local build to explicitly use public channels', () => {
    expect(shouldUsePrivateRealtimeChannels('false', false)).toBe(false);
  });

  it('allows an explicit private override in development', () => {
    expect(shouldUsePrivateRealtimeChannels('true', true)).toBe(true);
  });
});
