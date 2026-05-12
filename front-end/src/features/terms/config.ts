import type { TermsSection } from './types';

export const TERMS_TITLE = 'Terms of Service';
export const TERMS_DESCRIPTION =
  'Rose Labs Terms of Service — the agreement governing your use of Rose Labs.';

export const TERMS_LAST_UPDATED = 'May 12, 2026';

export const TERMS_CONTACT_EMAIL = 'security@roselabs.ai';

export const TERMS_CLOSING = 'By using Rose Labs, you agree to these Terms of Service.';

export const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    number: 1,
    title: 'Use of Our Service',
    blocks: [
      {
        kind: 'paragraph',
        text: 'You may use https://roselabs.ai and the Rose Labs application (collectively, the "Service") only for lawful purposes and in accordance with these Terms. You agree not to misuse the Service, attempt to gain unauthorized access, interfere with other users, reverse-engineer or scrape the platform, or use the Service to violate any law or third-party right.',
      },
    ],
  },
  {
    number: 2,
    title: 'Account Registration and Eligibility',
    blocks: [
      {
        kind: 'paragraph',
        text: 'To use the Service, you must (a) be at least 13 years old (and at least 16 if you reside in the European Economic Area), (b) provide accurate registration information including a valid phone number, and (c) complete SMS-based one-time-passcode verification before connecting any third-party integration such as a financial account. You are responsible for safeguarding access to your account. Notify us immediately at security@roselabs.ai if you suspect any unauthorized use of your account.',
      },
      {
        kind: 'paragraph',
        text: 'Rose Labs is an AI agent platform: you interact with our AI agents to ask questions, get information, and have the agents take actions on your behalf using the integrations you authorize. The Service is intended for personal, non-commercial use.',
      },
    ],
  },
  {
    number: 3,
    title: 'Connected Financial Accounts and Plaid',
    blocks: [
      {
        kind: 'paragraph',
        text: 'When you choose to connect a financial account to Rose Labs, you do so through Plaid Inc. ("Plaid"), a third-party financial data aggregator that acts as a service provider to Rose Labs. By connecting an account through Plaid Link, you authorize Plaid to (a) collect your financial institution login credentials, (b) access information from your financial accounts on our behalf (including account balances, transactions, identity, and similar data products you authorize at the time of connection), and (c) share that information with Rose Labs so that we can provide the personal-finance features you request.',
      },
      {
        kind: 'paragraph',
        text: 'Your use of Plaid is also governed by Plaid’s End User Privacy Policy, available at https://plaid.com/legal/end-user-privacy-policy, and Plaid’s End User Services Agreement, available at https://plaid.com/legal. By connecting an account, you acknowledge that you have read and agreed to those terms. Plaid is the data controller of the data it collects on our behalf to the extent required by applicable law.',
      },
      {
        kind: 'paragraph',
        text: 'You may revoke Plaid’s access to your financial accounts at any time, either (a) from within Rose Labs by disconnecting the integration, which triggers revocation of the associated Plaid access token via Plaid’s /item/remove endpoint, or (b) directly through Plaid’s consumer portal at https://my.plaid.com. Rose Labs will purge cached financial data associated with a disconnected account within 7 days of disconnection.',
      },
      {
        kind: 'paragraph',
        text: 'Rose Labs is not a bank, broker-dealer, registered investment adviser, certified financial planner, certified public accountant, lender, or tax preparer. Information provided through the Service is for personal informational purposes only and does not constitute financial, investment, legal, or tax advice. You are solely responsible for financial decisions you make. Financial-account data is provided "as is" and may be delayed, incomplete, or inaccurate; you should not rely on it for time-sensitive decisions without verifying with your financial institution.',
      },
    ],
  },
  {
    number: 4,
    title: 'AI Services Disclaimer',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The Service at https://roselabs.ai uses artificial intelligence, including large language models operated by third-party providers, to answer your questions and take actions on your behalf. AI output can be inaccurate, incomplete, or out of date. You should review and verify any AI output before relying on it, especially for financial, legal, medical, or other consequential decisions. The Service is provided "as is" and "as available," without warranties of any kind, whether express or implied, including warranties of merchantability, fitness for a particular purpose, accuracy, non-infringement, or uninterrupted availability.',
      },
    ],
  },
  {
    number: 5,
    title: 'Limitation of Liability',
    blocks: [
      {
        kind: 'paragraph',
        text: 'To the fullest extent permitted by law, Rose Labs and its officers, employees, contractors, and affiliates are not liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits, revenues, data, goodwill, or other intangible losses, arising out of or related to your use of the Service — including financial-account data accessed through Plaid — even if we have been advised of the possibility of such damages. Our total cumulative liability for any claim arising from or related to the Service will not exceed the greater of one hundred U.S. dollars ($100) or the amount you have paid Rose Labs in the twelve months preceding the event giving rise to the claim.',
      },
    ],
  },
  {
    number: 6,
    title: 'Intellectual Property and Acceptable Use',
    blocks: [
      {
        kind: 'paragraph',
        text: 'All content, software, branding, designs, and trademarks of the Service are owned by Rose Labs or its licensors and are protected by intellectual-property laws. You may not copy, modify, distribute, sell, or lease any part of the Service without our prior written permission. You retain ownership of the content you provide to the Service; you grant Rose Labs a limited license to process that content as necessary to provide the Service to you, as described in our Privacy Policy.',
      },
      {
        kind: 'paragraph',
        text: 'You agree not to use the Service to (a) violate any law or third-party right, (b) submit content you do not have the right to submit, (c) attempt to circumvent security or authentication controls, (d) conduct security testing without prior written authorization, (e) use the Service to make automated decisions about other persons, or (f) use the Service in any manner that could disable, overburden, damage, or impair its operation.',
      },
    ],
  },
  {
    number: 7,
    title: 'Changes to These Terms and Termination',
    blocks: [
      {
        kind: 'paragraph',
        text: 'We may update these Terms from time to time. The latest version will always be posted on this page with the effective date at the top. Material changes will be communicated in-app or by email where appropriate. Continued use of the Service after a change becomes effective constitutes acceptance of the updated Terms.',
      },
      {
        kind: 'paragraph',
        text: 'You may terminate your account at any time by emailing security@roselabs.ai or by using the in-app account-deletion feature when available; termination revokes all connected-integration tokens (including Plaid) and triggers purge of your personal data within 30 days, subject to backup-rotation schedules described in our Privacy Policy. We may suspend or terminate your account if you materially breach these Terms or if your use of the Service exposes Rose Labs to legal, regulatory, or security risk; we will provide notice where reasonably practicable.',
      },
    ],
  },
  {
    number: 8,
    title: 'SMS/Text Messaging',
    blocks: [
      {
        kind: 'paragraph',
        text: 'By providing your phone number and opting in, you consent to receive text messages from Rose Labs. These messages may include:',
      },
      {
        kind: 'bullets',
        items: [
          { text: 'Account verification and authentication codes' },
          { text: 'Service notifications and updates' },
          { text: 'Responses from your AI assistant' },
        ],
      },
      {
        kind: 'paragraph',
        boldPrefix: 'Message frequency varies.',
        text: ' Message and data rates may apply depending on your mobile carrier and plan.',
      },
      {
        kind: 'paragraph',
        boldPrefix: 'Opt-out:',
        text: ' You can stop receiving text messages at any time by replying STOP to any message. To resume messages, text START.',
      },
      {
        kind: 'paragraph',
        boldPrefix: 'Help:',
        text: ' For assistance, reply HELP to any message or contact us at security@roselabs.ai.',
      },
      {
        kind: 'paragraph',
        boldPrefix: 'Carrier liability:',
        text: ' Carriers are not liable for delayed or undelivered messages.',
      },
    ],
  },
  {
    number: 9,
    title: 'Contact',
    blocks: [{ kind: 'paragraph', text: 'Questions about these Terms?' }],
  },
] as const;
