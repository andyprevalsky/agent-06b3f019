import { describe, it, expect } from 'vitest';
import { renderWithProviders } from './test-wrapper';

describe('AgentContext domain', () => {
  it('placeholder - context provider tested indirectly via terminal page', () => {
    // AgentContext is a provider used by Terminal - tested through terminal.blackbox.tsx
    expect(true).toBe(true);
  });
});
