import type { PrivacySection } from './types';

export const PRIVACY_TITLE = 'Privacy Policy';
export const PRIVACY_DESCRIPTION =
  'Rose Labs Privacy Policy — learn how we protect your data and respect your privacy.';

export const PRIVACY_LAST_UPDATED = 'February 1, 2026';

export const PRIVACY_CONTACT_EMAIL = 'andy@roselabs.ai';

export const PRIVACY_INTRO =
  'Your privacy is our top priority at Rose Labs. This policy explains what we do not collect, how our assistant works, and our commitment to your privacy.';

export const PRIVACY_CLOSING =
  "Your privacy is our top priority at Rose Labs. We're here to help, not to watch.";

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  {
    number: 1,
    title: 'Information We Collect',
    bullets: [
      {
        text: 'We do not store, record, or retain any conversations or personal data on our servers.',
      },
      { text: 'All interactions are processed in real time and discarded immediately.' },
      {
        text: 'We do not use cookies, tracking pixels, or analytics scripts to monitor your activity on our website.',
      },
    ],
  },
  {
    number: 2,
    title: 'How Our Assistant Operates',
    bullets: [
      {
        text: 'Your input is never stored or processed by us. Our assistant serves as a pass-through to frontier AI model providers, exclusively during your active session.',
      },
      { text: 'After your interaction ends, no data remains with us.' },
      {
        text: 'We do not use your interaction data for advertising, marketing, or profiling.',
      },
    ],
  },
  {
    number: 3,
    title: 'Third-Party Processing',
    bullets: [
      {
        text: 'Data is securely and anonymously streamed to leading AI model providers strictly to generate your requested response.',
      },
      {
        text: 'We do not sell, rent, or share any user data with advertisers, data brokers, or third parties.',
      },
      {
        text: 'Our AI provider partners must adhere to strict privacy and security practices.',
      },
      {
        text: 'All the above categories exclude text messaging originator opt-in data and consent; this information will not be shared with any third parties.',
      },
    ],
  },
  {
    number: 4,
    title: 'Security',
    paragraph:
      'All data in transit is encrypted using industry-standard protocols. No voice data is ever stored on our infrastructure.',
  },
  {
    number: 5,
    title: 'Your Control',
    bullets: [
      {
        text: 'You are in full control of when and how you interact with our assistant.',
      },
      {
        text: 'If you contact us via email or form, we use your contact details only to respond and do not retain them.',
      },
    ],
  },
  {
    number: 6,
    title: 'Policy Updates',
    paragraph: 'We may amend this Privacy Policy occasionally.',
  },
  {
    number: 7,
    title: 'Contact',
  },
] as const;
