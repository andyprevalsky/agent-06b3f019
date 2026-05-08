import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from '@/components/ErrorBoundary';

function BrokenChild() {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary name="Widget">
        <div>working</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('working')).toBeInTheDocument();
  });

  it('renders a provided fallback when a child throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary name="Widget" fallback={<div>fallback rendered</div>}>
        <BrokenChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText('fallback rendered')).toBeInTheDocument();
  });

  it('renders default error details when no fallback is provided', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary name="Widget">
        <BrokenChild />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: /error in widget/i })).toBeInTheDocument();
    expect(screen.getByText(/show error details/i)).toBeInTheDocument();
    expect(screen.getByText(/error: boom/i)).toBeInTheDocument();
  });
});
