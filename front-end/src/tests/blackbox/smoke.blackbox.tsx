/**
 * Smoke test to verify blackbox test infrastructure works.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';

describe('Blackbox infrastructure smoke test', () => {
  it('renders a simple component with providers', () => {
    renderWithProviders(<div>Hello blackbox</div>);
    expect(screen.getByText('Hello blackbox')).toBeInTheDocument();
  });
});
