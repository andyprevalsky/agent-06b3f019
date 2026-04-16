import type { TermsSection } from './types';

export const TERMS_TITLE = 'Terms of Service';
export const TERMS_DESCRIPTION =
  'Rose Labs Terms of Service — review the terms and conditions for using our platform.';

export const TERMS_LAST_UPDATED = 'February 1, 2026';

export const TERMS_CONTACT_EMAIL = 'andy@roselabs.ai';

export const TERMS_CLOSING = 'By using this website, you agree to these Terms of Service.';

export const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    number: 1,
    title: 'Use of Our Website',
    blocks: [
      {
        kind: 'paragraph',
        text: 'You may use https://roselabs.ai only for lawful purposes. You agree not to misuse the website, attempt to gain unauthorized access, or disrupt the site\u2019s functionality.',
      },
    ],
  },
  {
    number: 2,
    title: 'Waitlist Sign-Up',
    blocks: [
      {
        kind: 'paragraph',
        text: 'If you join our waitlist, you agree to provide accurate information. By signing up, you consent to us contacting you by email about Rose Labs updates and news. You can unsubscribe at any time.',
      },
    ],
  },
  {
    number: 3,
    title: 'Intellectual Property',
    blocks: [
      {
        kind: 'paragraph',
        text: 'All content on this site\u2014including text, branding, images, and design\u2014is owned by Rose Labs and may not be used without our permission.',
      },
    ],
  },
  {
    number: 4,
    title: 'No Warranties',
    blocks: [
      {
        kind: 'paragraph',
        text: 'https://roselabs.ai is provided "as is." We make no guarantees about the accuracy, reliability, or availability of our website or information on it.',
      },
    ],
  },
  {
    number: 5,
    title: 'Limitation of Liability',
    blocks: [
      {
        kind: 'paragraph',
        text: 'To the fullest extent permitted by law, Rose Labs is not liable for any damages or losses arising from your use of this site.',
      },
    ],
  },
  {
    number: 6,
    title: 'Links to Other Sites',
    blocks: [
      {
        kind: 'paragraph',
        text: 'Our website may link to third-party sites. We are not responsible for their content or privacy practices.',
      },
    ],
  },
  {
    number: 7,
    title: 'Changes to These Terms',
    blocks: [
      {
        kind: 'paragraph',
        text: 'We may update these Terms from time to time. The latest version will always be posted on this page with the effective date.',
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
        text: ' For assistance, reply HELP to any message or contact us at andy@roselabs.ai.',
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
