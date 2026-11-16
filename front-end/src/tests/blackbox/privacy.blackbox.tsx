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
    expect(screen.getByText(/last updated: september 30, 2026/i)).toBeInTheDocument();
  });

  it('renders all 11 section headings', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByRole('heading', { name: /1\. information we collect/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /2\. how we use your data/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /3\. plaid and financial data/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /4\. third-party processors/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /5\. data retention and deletion/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /6\. security/i })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /7\. your rights and controls/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /8\. children/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /9\. international users/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /10\. policy updates/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /11\. contact/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^google user data$/i })).toBeInTheDocument();
  });

  it('discloses Google permissions, limited use, revocation and retention', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/gmail \(to search, read, summarize, draft, send, label, and archive/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /we do not use google user data to develop, improve, or train generalized ai/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/we remove the stored credential, request revocation of its oauth token/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/openai may retain content.*up to 30 days/i)).toBeInTheDocument();
    // Calendar and Drive are synced into the searchable store, so the policy
    // must say that copies are kept, not only that content is fetched on demand.
    expect(
      screen.getByText(
        /copies of your synced email, your google calendar events, and your google drive file names and document text are stored/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /google api services user data policy/i }),
    ).toHaveAttribute('href', 'https://developers.google.com/terms/api-services-user-data-policy');
  });

  it('renders the intro disclosure that we collect and store data', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/rose labs operates an ai agent platform/i)).toBeInTheDocument();
  });

  it('renders the closing statement about user control and deletion', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/you own your data/i)).toBeInTheDocument();
  });

  // --- Section 1: Information We Collect ---

  it('discloses collection of account information (phone, profile)', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/account information: phone number/i)).toBeInTheDocument();
  });

  it('discloses storage of conversation data', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(
        /conversation data: the messages you send to the agent.*stored in our database/i,
      ),
    ).toBeInTheDocument();
  });

  it('discloses collection of connected-integration data including Plaid', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/connected-integration data.*plaid for bank and financial-account data/i),
    ).toBeInTheDocument();
  });

  it('discloses collection of operational and payment data', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/operational data: logs of requests/i)).toBeInTheDocument();
    expect(screen.getByText(/payment data.*processed by stripe/i)).toBeInTheDocument();
  });

  // --- Section 2: How We Use Your Data ---

  it('discloses that messages and context are sent to LLM providers', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(
        /sent to large language model.*providers as part of normal agent operation/i,
      ),
    ).toBeInTheDocument();
  });

  it('discloses that data is not used to train AI, sold, or shared with advertisers', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(
        /we do not use your data to train ai models\. we do not sell your data\. we do not share your data with advertisers/i,
      ),
    ).toBeInTheDocument();
  });

  // --- Section 3: Plaid and Financial Data ---

  it('discloses Plaid integration purpose (PFM, not underwriting)', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/we do not underwrite loans, extend credit, make credit decisions/i),
    ).toBeInTheDocument();
  });

  it('discloses Plaid token application-layer encryption', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(
        /plaid access tokens that authorize ongoing access.*encrypted at the application layer/i,
      ),
    ).toBeInTheDocument();
  });

  it('discloses Plaid disconnection and 7-day data purge', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/disconnection revokes the plaid access token.*purge.*within 7 days/i),
    ).toBeInTheDocument();
  });

  // --- Section 4: Third-Party Processors ---

  it('discloses infrastructure processors (Supabase, Render, Fly.io, Vercel)', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/supabase.*render.*fly\.io.*vercel/i)).toBeInTheDocument();
  });

  it('discloses LLM/AI processors (Anthropic, OpenAI, Google, Perplexity, OpenRouter)', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/anthropic.*openai.*google.*perplexity.*openrouter/i),
    ).toBeInTheDocument();
  });

  it('discloses payments processor (Stripe)', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/^payments: stripe\.$/i)).toBeInTheDocument();
  });

  // --- Section 5: Data Retention and Deletion ---

  it('discloses retention period for active account data', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/active account data is retained for the lifetime of your active account/i),
    ).toBeInTheDocument();
  });

  it('discloses 30-day deletion SLA and 90-day backup rollover', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(
        /purge your personal data.*within 30 days.*encrypted database backups roll off within 90 days/i,
      ),
    ).toBeInTheDocument();
  });

  // --- Section 6: Security ---

  it('discloses TLS 1.2+ in transit and AES-256 at rest', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/tls 1\.2 or higher.*tls 1\.3 negotiated where supported/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/aes-256 by our managed infrastructure providers/i),
    ).toBeInTheDocument();
  });

  it('discloses row-level security isolation', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/row-level security: each user can only read and write their own data/i),
    ).toBeInTheDocument();
  });

  // --- Section 7: Your Rights and Controls ---

  it('discloses CCPA and GDPR rights with statutory deadlines', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/45 days for ccpa, 30 days for gdpr/i)).toBeInTheDocument();
  });

  it('discloses integration-disconnection rights', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/you can disconnect any third-party integration/i)).toBeInTheDocument();
  });

  // --- Section 8: Children ---

  it('renders children policy', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/rose labs is not directed to children under 13/i)).toBeInTheDocument();
  });

  // --- Section 9: International Users ---

  it('renders international users policy', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/rose labs is operated from the united states/i)).toBeInTheDocument();
  });

  // --- Section 10: Policy Updates ---

  it('renders policy updates section', () => {
    renderWithProviders(<Privacy />);
    expect(
      screen.getByText(/we may update this privacy policy from time to time/i),
    ).toBeInTheDocument();
  });

  // --- Section 11: Contact ---

  it('renders the contact prompt', () => {
    renderWithProviders(<Privacy />);
    expect(screen.getByText(/have questions or concerns\? reach out anytime/i)).toBeInTheDocument();
  });

  it('renders the contact email link with correct mailto href', () => {
    renderWithProviders(<Privacy />);
    const emailLink = screen.getByRole('link', { name: /security@roselabs\.ai/i });
    expect(emailLink).toBeInTheDocument();
    expect(emailLink).toHaveAttribute('href', 'mailto:security@roselabs.ai');
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

  it('renders the Research header link and no About page link', () => {
    renderWithProviders(<Privacy />);
    const researchLink = screen.getByRole('link', { name: /research/i });
    expect(researchLink).toHaveAttribute('href', '/research');
    expect(screen.queryByRole('link', { name: /^about$/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/about"]')).toBeNull();
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
