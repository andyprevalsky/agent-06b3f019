import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import Terms from '@/features/terms';

describe('Terms page', () => {
  // --- Rendering ---

  it('renders terms of service heading', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByRole('heading', { name: /terms of service/i })).toBeInTheDocument();
  });

  it('renders last updated date', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/last updated: may 12, 2026/i)).toBeInTheDocument();
  });

  it('renders all 9 section headings', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByRole('heading', { name: /1\. use of our service/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /2\. account registration and eligibility/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /3\. connected financial accounts and plaid/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /4\. ai services disclaimer/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /5\. limitation of liability/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /6\. intellectual property and acceptable use/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /7\. changes to these terms and termination/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /8\. sms\/text messaging/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /9\. contact/i })).toBeInTheDocument();
  });

  it('renders agreement statement at the bottom', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/by using rose labs, you agree to these terms of service/i),
    ).toBeInTheDocument();
  });

  // --- Section Content ---

  it('renders welcome/intro content with agreement language', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/by creating an account or using the service, you agree to be bound/i),
    ).toBeInTheDocument();
  });

  it('renders section 1 - Use of Our Service content', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/you may use.*only for lawful purposes/i)).toBeInTheDocument();
  });

  it('renders section 2 - account registration eligibility (13+, OTP before integrations)', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/at least 13 years old/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /complete sms-based one-time-passcode verification before connecting any third-party integration/i,
      ),
    ).toBeInTheDocument();
  });

  it('renders section 3 - Plaid passthrough (Plaid as service provider, end-user policy)', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/plaid inc\. \("plaid"\), a third-party financial data aggregator/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/plaid['’]s end user privacy policy/i)).toBeInTheDocument();
  });

  it('renders section 3 - revocation via Plaid disconnect or my.plaid.com', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/you may revoke plaid['’]s access to your financial accounts/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/my\.plaid\.com/i)).toBeInTheDocument();
  });

  it('renders section 3 - not an advisor disclaimer', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(
        /not a bank, broker-dealer, registered investment adviser.*certified public accountant/i,
      ),
    ).toBeInTheDocument();
  });

  it('renders section 4 - AI services disclaimer', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/ai output can be inaccurate, incomplete, or out of date/i),
    ).toBeInTheDocument();
  });

  it('renders section 5 - Limitation of Liability with $100 cap', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/one hundred u\.s\. dollars/i)).toBeInTheDocument();
  });

  it('renders section 6 - IP + acceptable use', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/all content, software, branding, designs, and trademarks/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/circumvent security or authentication controls/i)).toBeInTheDocument();
  });

  it('renders section 7 - changes + termination (revokes Plaid)', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/we may update these terms from time to time/i)).toBeInTheDocument();
    expect(
      screen.getByText(/termination revokes all connected-integration tokens \(including plaid\)/i),
    ).toBeInTheDocument();
  });

  it('renders section 8 - SMS/Text Messaging content', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/by providing your phone number and opting in/i)).toBeInTheDocument();
  });

  it('renders SMS message types list', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/account verification and authentication codes/i)).toBeInTheDocument();
    expect(screen.getByText(/service notifications and updates/i)).toBeInTheDocument();
    expect(screen.getByText(/responses from your ai assistant/i)).toBeInTheDocument();
  });

  it('renders SMS opt-out and help instructions', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/message frequency varies/i)).toBeInTheDocument();
    expect(
      screen.getByText(/you can stop receiving text messages at any time by replying stop/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/for assistance, reply help to any message/i)).toBeInTheDocument();
  });

  it('renders carrier liability disclaimer', () => {
    renderWithProviders(<Terms />);
    expect(
      screen.getByText(/carriers are not liable for delayed or undelivered messages/i),
    ).toBeInTheDocument();
  });

  it('renders section 9 - Contact content', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/questions about these terms\?/i)).toBeInTheDocument();
  });

  // --- Navigation Links ---

  it('renders homepage links (roselabs.ai) throughout the page', () => {
    renderWithProviders(<Terms />);
    const homepageLinks = screen.getAllByRole('link', { name: /https:\/\/roselabs\.ai/i });
    // Appears in intro, section 1, and section 4
    expect(homepageLinks.length).toBe(3);
    homepageLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', '/');
    });
  });

  it('renders privacy policy links (SMS section and footer)', () => {
    renderWithProviders(<Terms />);
    const privacyLinks = screen.getAllByRole('link', { name: /privacy policy/i });
    // One in SMS section (inline), one in footer bottom bar
    expect(privacyLinks.length).toBe(2);
    privacyLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', '/privacy');
    });
  });

  it('renders footer privacy link', () => {
    renderWithProviders(<Terms />);
    // Footer has "Privacy Policy" link in the bottom bar
    const footerPrivacyLinks = screen.getAllByText(/privacy/i);
    expect(footerPrivacyLinks.length).toBeGreaterThan(0);
  });

  // --- Contact Email ---

  it('renders email links to security@roselabs.ai', () => {
    renderWithProviders(<Terms />);
    const emailLinks = screen.getAllByRole('link', { name: /security@roselabs\.ai/i });
    // Appears in section 8 (SMS help) and section 9 (Contact)
    expect(emailLinks.length).toBe(2);
    emailLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', 'mailto:security@roselabs.ai');
    });
  });

  // --- Header and Footer ---

  it('renders the header with Rose branding', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText('Rose')).toBeInTheDocument();
  });

  it('renders header navigation links without an About page link', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByRole('link', { name: /research/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^about$/i })).not.toBeInTheDocument();
  });

  it('renders footer with copyright', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/© 2026 rose labs\. all rights reserved\./i)).toBeInTheDocument();
  });

  it('renders footer company links', () => {
    renderWithProviders(<Terms />);
    // Footer has About, Privacy, Terms, Contact in the Company section
    const termsLinks = screen.getAllByText(/terms/i);
    // "Terms of Service" heading + footer "Terms" link + footer "Terms of Service" link
    expect(termsLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('renders footer tagline', () => {
    renderWithProviders(<Terms />);
    expect(screen.getByText(/your personal superintelligence/i)).toBeInTheDocument();
  });
});
