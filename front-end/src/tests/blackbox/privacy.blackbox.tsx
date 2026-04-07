import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import Privacy from '@/pages/Privacy';

describe('Privacy page', () => {
  // --- Rendering ---

  it('renders the Privacy Policy heading', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByRole('heading', { name: /privacy policy/i, level: 1 })).toBeInTheDocument();
  });

  it('renders the last updated date', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/last updated: february 1, 2026/i)).toBeInTheDocument();
  });

  it('renders all 7 section headings', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByRole('heading', { name: /1\. information we collect/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /2\. how our assistant operates/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /3\. third-party processing/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /4\. security/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /5\. your control/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /6\. policy updates/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /7\. contact/i })).toBeInTheDocument();
  });

  it('renders the intro commitment message and closing commitment message', () => {
    renderWithProviders(<Privacy />);
    // Both the intro paragraph and the closing statement contain this phrase
    const commitmentTexts = screen.getAllByText(/your privacy is our top priority/i);
    expect(commitmentTexts).toHaveLength(2);
  });

  it('renders the closing statement about helping not watching', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we're here to help, not to watch/i)).toBeInTheDocument();
  });

  // --- Section 1: Information We Collect ---

  it('renders section 1 content about not storing data', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we do not store, record, or retain any conversations or personal data/i)).toBeInTheDocument();
  });

  it('renders section 1 content about real-time processing', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/all interactions are processed in real time and discarded immediately/i)).toBeInTheDocument();
  });

  it('renders section 1 content about no cookies or tracking', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we do not use cookies, tracking pixels, or analytics scripts/i)).toBeInTheDocument();
  });

  // --- Section 2: How Our Assistant Operates ---

  it('renders section 2 content about pass-through to AI providers', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/our assistant serves as a pass-through to frontier ai model providers/i)).toBeInTheDocument();
  });

  it('renders section 2 content about no data remaining after interaction', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/after your interaction ends, no data remains with us/i)).toBeInTheDocument();
  });

  it('renders section 2 content about no advertising or profiling', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we do not use your interaction data for advertising, marketing, or profiling/i)).toBeInTheDocument();
  });

  // --- Section 3: Third-Party Processing ---

  it('renders section 3 content about secure anonymous streaming', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/data is securely and anonymously streamed to leading ai model providers/i)).toBeInTheDocument();
  });

  it('renders section 3 content about not selling data', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we do not sell, rent, or share any user data/i)).toBeInTheDocument();
  });

  it('renders section 3 content about AI provider privacy practices', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/our ai provider partners must adhere to strict privacy and security practices/i)).toBeInTheDocument();
  });

  it('renders section 3 content about text messaging opt-in exclusion', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/text messaging originator opt-in data and consent/i)).toBeInTheDocument();
  });

  // --- Section 4: Security ---

  it('renders section 4 content about encryption and no voice data storage', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/all data in transit is encrypted using industry-standard protocols/i)).toBeInTheDocument();
    expect(screen.getByText(/no voice data is ever stored on our infrastructure/i)).toBeInTheDocument();
  });

  // --- Section 5: Your Control ---

  it('renders section 5 content about user control', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/you are in full control of when and how you interact/i)).toBeInTheDocument();
  });

  it('renders section 5 content about contact details not retained', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we use your contact details only to respond and do not retain them/i)).toBeInTheDocument();
  });

  // --- Section 6: Policy Updates ---

  it('renders section 6 content about amending the policy', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/we may amend this privacy policy occasionally/i)).toBeInTheDocument();
  });

  // --- Section 7: Contact ---

  it('renders the contact prompt', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/have questions or concerns\? reach out anytime/i)).toBeInTheDocument();
  });

  it('renders the contact email link with correct mailto href', () => {
    renderWithProviders(<Privacy />);
    const emailLink = screen.getByRole('link', { name: /andy@roselabs\.ai/i });
    expect(emailLink).toBeInTheDocument();
    expect(emailLink).toHaveAttribute('href', 'mailto:andy@roselabs.ai');
  });

  // --- Navigation ---

  it('renders homepage links in the intro and policy updates sections', () => {
    renderWithProviders(<Privacy />);
    const homepageLinks = screen.getAllByRole('link', { name: /www\.roselabs\.ai/i });
    expect(homepageLinks).toHaveLength(2);
    homepageLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', '/');
    });
  });

  it('renders header navigation links for Research and About', () => {
    renderWithProviders(<Privacy />);
    const researchLink = screen.getByRole('link', { name: /research/i });
    expect(researchLink).toHaveAttribute('href', '/research');
    // About appears in both header nav and footer company links
    const aboutLinks = screen.getAllByRole('link', { name: /^about$/i });
    expect(aboutLinks.length).toBeGreaterThanOrEqual(1);
    expect(aboutLinks[0]).toHaveAttribute('href', '/about');
  });

  it('renders the header Rose logo link', () => {
    renderWithProviders(<Privacy />);
    // Header has an <a> with the text "Rose"
    const roseLink = screen.getByRole('link', { name: /^rose$/i });
    expect(roseLink).toHaveAttribute('href', '/');
  });

  it('renders footer with Rose Labs branding and company links', () => {
    renderWithProviders(<Privacy />);
    // Footer has "Rose Labs" link
    const roseLabsLink = screen.getByRole('link', { name: /rose labs/i });
    expect(roseLabsLink).toHaveAttribute('href', '/');
    // Footer company links
    const privacyLinks = screen.getAllByRole('link', { name: /^privacy$/i });
    expect(privacyLinks.length).toBeGreaterThan(0);
    const termsLink = screen.getByRole('link', { name: /^terms$/i });
    expect(termsLink).toHaveAttribute('href', '/terms');
  });

  it('renders footer copyright notice', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/© 2026 rose labs\. all rights reserved\./i)).toBeInTheDocument();
  });

  it('renders footer Privacy Policy and Terms of Service links', () => {
    renderWithProviders(<Privacy />);
    const privacyPolicyLinks = screen.getAllByRole('link', { name: /privacy policy/i });
    expect(privacyPolicyLinks.length).toBeGreaterThan(0);
    expect(privacyPolicyLinks[0]).toHaveAttribute('href', '/privacy');
    const tosLinks = screen.getAllByRole('link', { name: /terms of service/i });
    expect(tosLinks.length).toBeGreaterThan(0);
    expect(tosLinks[0]).toHaveAttribute('href', '/terms');
  });
});
