import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithProviders } from './test-wrapper';
import NotFound from '@/features/not-found';

describe('NotFound page', () => {
  // ── Rendering ──────────────────────────────────────────────────────

  it('renders 404 heading', () => {
    renderWithProviders(<NotFound />);
    expect(screen.getByRole('heading', { name: '404' })).toBeInTheDocument();
  });

  it('renders error message text', () => {
    renderWithProviders(<NotFound />);
    expect(screen.getByText('Oops! Page not found')).toBeInTheDocument();
  });

  it('renders return home link', () => {
    renderWithProviders(<NotFound />);
    const link = screen.getByRole('link', { name: /return to home/i });
    expect(link).toBeInTheDocument();
  });

  // ── Navigation ─────────────────────────────────────────────────────

  it('home link points to /', () => {
    renderWithProviders(<NotFound />);
    const link = screen.getByRole('link', { name: /return to home/i });
    expect(link).toHaveAttribute('href', '/');
  });

  // ── Console logging ────────────────────────────────────────────────

  it('logs 404 error with pathname on mount', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithProviders(<NotFound />, { route: '/bogus-path' });

    expect(consoleSpy).toHaveBeenCalledWith(
      '404 Error: User attempted to access non-existent route:',
      '/bogus-path',
    );

    consoleSpy.mockRestore();
  });

  it('logs the default pathname when no route option is given', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderWithProviders(<NotFound />);

    expect(consoleSpy).toHaveBeenCalledWith(
      '404 Error: User attempted to access non-existent route:',
      '/',
    );

    consoleSpy.mockRestore();
  });

  // ── Route integration ──────────────────────────────────────────────

  it('renders when navigated to a non-existent route via Routes catch-all', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/does-not-exist']}>
            <Routes>
              <Route path="/" element={<div>Home</div>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: '404' })).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
  });

  it('does not render NotFound when the route matches a defined path', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<div>Home</div>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '404' })).not.toBeInTheDocument();
  });
});
