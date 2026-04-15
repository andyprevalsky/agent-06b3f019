import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import Download from '@/features/download';

const DOWNLOAD_URL =
  'https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg';

describe('Download page', () => {
  let hrefSetter: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    // Save the real location object and replace with a mock that captures href assignments
    originalLocation = window.location;
    hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: originalLocation.href,
      },
    });
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      set: hrefSetter,
      get: () => originalLocation.href,
    });
  });

  afterEach(() => {
    // Restore original location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  // --- Rendering tests ---

  it('renders the downloading heading', () => {
    renderWithProviders(<Download />);
    const heading = screen.getByRole('heading', { name: /downloading rose for mac/i });
    expect(heading).toBeInTheDocument();
  });

  it('renders fallback link with the correct full download URL', () => {
    renderWithProviders(<Download />);
    const link = screen.getByRole('link', { name: /click here/i });
    expect(link).toHaveAttribute('href', DOWNLOAD_URL);
  });

  it('renders the instructions text about the fallback', () => {
    renderWithProviders(<Download />);
    expect(screen.getByText(/if download doesn.t start/i)).toBeInTheDocument();
  });

  // --- Redirect test ---

  it('sets window.location.href to the download URL on mount', () => {
    renderWithProviders(<Download />);
    expect(hrefSetter).toHaveBeenCalledWith(DOWNLOAD_URL);
  });

  it('triggers the redirect exactly once', () => {
    renderWithProviders(<Download />);
    expect(hrefSetter).toHaveBeenCalledTimes(1);
  });

  // --- Link attribute tests ---

  it('fallback link does not open in a new tab (no target attribute)', () => {
    renderWithProviders(<Download />);
    const link = screen.getByRole('link', { name: /click here/i });
    expect(link).not.toHaveAttribute('target');
  });

  it('fallback link points to a .dmg file', () => {
    renderWithProviders(<Download />);
    const link = screen.getByRole('link', { name: /click here/i });
    expect(link.getAttribute('href')).toMatch(/\.dmg$/);
  });
});
