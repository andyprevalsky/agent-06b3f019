import type { PrivacySection } from './types';

export const PRIVACY_TITLE = 'Privacy Policy';
export const PRIVACY_DESCRIPTION =
  'Rose Labs Privacy Policy — how we collect, use, share, and retain your data.';

export const PRIVACY_LAST_UPDATED = 'May 12, 2026';

export const PRIVACY_CONTACT_EMAIL = 'security@roselabs.ai';

export const PRIVACY_INTRO =
  'Rose Labs operates an AI agent platform. To answer your questions, take actions on your behalf, and connect to services you authorize (such as your bank via Plaid, your email via Google, and your messaging via SMS), we collect, process, and store the data described below. This policy explains what we collect, why, how long we keep it, who else processes it, and how you can delete it.';

export const PRIVACY_CLOSING =
  'You own your data. We retain only what we need to run the product for you, and we never sell it. Email security@roselabs.ai to request a copy or deletion at any time.';

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  {
    number: 1,
    title: 'Information We Collect',
    bullets: [
      {
        text: 'Account information: phone number (used for sign-in via SMS one-time-passcode), and any profile information you choose to provide (name, email, address, time zone).',
      },
      {
        text: "Conversation data: the messages you send to the agent, the agent's responses, attached files or images, and any actions the agent takes on your behalf. This data is stored in our database under your account and is used to provide the service, maintain context across sessions, and improve the product.",
      },
      {
        text: 'Connected-integration data: when you connect a third-party service to Rose Labs (for example, Plaid for bank and financial-account data, Google for Gmail, browser sessions for site automation), we receive and store the data those services return — for Plaid: account balances, transactions, identity, income, investments, liabilities, and bank statements as authorized by you; for Gmail: messages and metadata you authorize us to read; for browser sessions: the cookies, local storage, and credentials you upload to enable the agent to act on your behalf.',
      },
      {
        text: 'Operational data: logs of requests, errors, agent execution traces, and aggregate usage metrics used for debugging, reliability, and abuse prevention.',
      },
      {
        text: 'Payment data: if you subscribe to a paid plan, payment information is collected and processed by Stripe; we do not store full card numbers.',
      },
    ],
  },
  {
    number: 2,
    title: 'How We Use Your Data',
    bullets: [
      {
        text: 'To operate the assistant — your messages and the context required to answer them (which may include data from your connected integrations) are sent to large language model (LLM) providers as part of normal agent operation.',
      },
      {
        text: 'To execute actions you ask for — for example, retrieving transactions, summarizing email, sending messages, or interacting with sites in an authenticated browser session.',
      },
      {
        text: 'To maintain account state, conversation history, and personalization across sessions.',
      },
      {
        text: 'To provide customer support and respond to your requests.',
      },
      {
        text: 'To detect, prevent, and respond to fraud, abuse, and security incidents.',
      },
      {
        text: 'To comply with legal obligations.',
      },
      {
        text: 'We do not use your data to train AI models. We do not sell your data. We do not share your data with advertisers, data brokers, or marketing partners.',
      },
    ],
  },
  {
    number: 3,
    title: 'Plaid and Financial Data',
    bullets: [
      {
        text: "When you connect a financial account via Plaid Link, Plaid acts as an intermediary between your bank and Rose Labs and provides us with the data products you authorize (balances, transactions, identity, income, investments, liabilities, and statements). Plaid's own privacy policy is available at https://plaid.com/legal/.",
      },
      {
        text: 'Plaid-sourced financial data is used solely to provide the personal-finance-management features you request — answering questions about your accounts, summarizing spending, tracking bills and subscriptions, helping with budgeting and savings goals, monitoring investments, retrieving statements for tax preparation, and similar user-initiated tasks.',
      },
      {
        text: 'We do not underwrite loans, extend credit, make credit decisions, sell Plaid-sourced data to third parties, or share it with advertisers.',
      },
      {
        text: 'Plaid access tokens that authorize ongoing access to your accounts are encrypted at the application layer (AES-256-GCM with RSA-OAEP-SHA256 envelope encryption) before storage, in addition to the at-rest encryption provided by our database.',
      },
      {
        text: "You can disconnect a financial account at any time from within Rose Labs. Disconnection revokes the Plaid access token through Plaid's /item/remove endpoint and triggers purge of the associated cached data from our active systems within 7 days.",
      },
    ],
  },
  {
    number: 4,
    title: 'Third-Party Processors',
    bullets: [
      {
        text: 'Infrastructure: Supabase (Postgres database, auth, realtime), Render (backend hosting), Fly.io (agent workers), Vercel (frontend hosting), ClickHouse Cloud (log retention).',
      },
      {
        text: 'Authentication and messaging: Twilio Verify (SMS one-time-passcodes).',
      },
      {
        text: 'Financial data: Plaid (financial account aggregation).',
      },
      {
        text: 'LLM and AI processing: Anthropic, OpenAI, Google (Gemini), Perplexity, and OpenRouter (which routes to additional sub-providers including xAI, Moonshot, and Z.ai). Each provider operates under its published no-training-on-API-traffic policy.',
      },
      {
        text: 'Search and enrichment: Exa.',
      },
      {
        text: 'Browser automation and sandboxed execution: Browserbase, E2B.',
      },
      {
        text: 'Payments: Stripe.',
      },
      {
        text: 'Source control and supply chain: GitHub.',
      },
      {
        text: 'Each processor is selected based on its published security attestations (typically SOC 2 Type II) and processes data only to provide its specified service to Rose Labs.',
      },
    ],
  },
  {
    number: 5,
    title: 'Data Retention and Deletion',
    bullets: [
      {
        text: 'Active account data is retained for the lifetime of your active account.',
      },
      {
        text: 'Plaid access tokens and other integration credentials are retained for the lifetime of the integration; revoked immediately when you disconnect.',
      },
      {
        text: 'Cached Plaid-sourced data is purged within 7 days of disconnection and within 30 days of account deletion.',
      },
      {
        text: 'Application and agent logs are retained for up to 12 months (agent logs in ClickHouse: 7 days).',
      },
      {
        text: 'When you request account deletion (via security@roselabs.ai or the in-app deletion flow when available), we purge your personal data and connected-account data from active production systems within 30 days; encrypted database backups roll off within 90 days.',
      },
      {
        text: 'Records we are required to retain by law (e.g., tax, anti-fraud) are kept for the statutory minimum and then deleted.',
      },
      {
        text: 'Full retention details are published in the Rose Labs Data Retention and Disposal Policy, available on request.',
      },
    ],
  },
  {
    number: 6,
    title: 'Security',
    bullets: [
      {
        text: 'All data in transit is encrypted using TLS 1.2 or higher, with TLS 1.3 negotiated where supported.',
      },
      {
        text: 'All data at rest is encrypted using AES-256 by our managed infrastructure providers.',
      },
      {
        text: 'Sensitive credentials that grant ongoing access to consumer financial data (Plaid access tokens, Claude Code OAuth credentials, uploaded browser-password credentials) are additionally encrypted at the application layer prior to storage.',
      },
      {
        text: 'Application-layer access to your data is enforced by row-level security: each user can only read and write their own data.',
      },
      {
        text: 'For full details, see the Rose Labs Information Security Policy, available on request via security@roselabs.ai.',
      },
    ],
  },
  {
    number: 7,
    title: 'Your Rights and Controls',
    bullets: [
      {
        text: 'You can request a copy of your data, correction of inaccuracies, or deletion of your data at any time by emailing security@roselabs.ai. Verified requests are completed within 30 days.',
      },
      {
        text: 'You can disconnect any third-party integration (Plaid, Google, browser sessions, etc.) at any time from within Rose Labs; doing so triggers revocation of the associated credentials and purge of cached data on the schedule above.',
      },
      {
        text: 'Under the California Consumer Privacy Act (CCPA) and the General Data Protection Regulation (GDPR), you have the rights of access, rectification, erasure, portability, restriction of processing, and objection, where applicable. We honor verified rights requests within the statutory deadlines (45 days for CCPA, 30 days for GDPR).',
      },
      {
        text: 'SMS opt-in data and consent records are never shared with third parties for marketing purposes.',
      },
    ],
  },
  {
    number: 8,
    title: 'Children',
    paragraph:
      'Rose Labs is not directed to children under 13, and we do not knowingly collect personal data from children. If you believe a child has provided us with personal data, contact security@roselabs.ai and we will delete it.',
  },
  {
    number: 9,
    title: 'International Users',
    paragraph:
      'Rose Labs is operated from the United States. By using the service, you consent to the transfer of your data to the United States and to processing by our service providers, some of which may operate globally.',
  },
  {
    number: 10,
    title: 'Policy Updates',
    paragraph:
      'We may update this Privacy Policy from time to time. Material changes will be noted by updating the "Last updated" date at the top of the policy, and where appropriate we will notify you in-app or by email. Continued use of Rose Labs after a material update constitutes acceptance of the revised policy.',
  },
  {
    number: 11,
    title: 'Contact',
  },
] as const;
