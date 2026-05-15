/**
 * STATE MACHINE: Terms
 *
 * This component is stateless - displays static terms of service content.
 *
 * [MOUNTED] --> renders static content (driven by config data)
 */

import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import NaviHeader from '@/components/NaviHeader';
import NaviFooter from '@/components/NaviFooter';

import { useTermsSeo } from '../hooks';
import { TERMS_LAST_UPDATED, TERMS_CONTACT_EMAIL, TERMS_SECTIONS, TERMS_CLOSING } from '../config';
import type { TermsSection, TermsContentBlock } from '../types';

const LINK_CLASSES = 'text-primary hover:text-primary/80 underline transition-colors';
const BULLET_CLASSES = 'w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-foreground';
const DIVIDER_CLASSES = 'w-full h-px bg-gradient-to-r from-transparent via-border to-transparent';

function SectionDivider() {
  return <div className={DIVIDER_CLASSES} />;
}

function SiteLink() {
  return (
    <Link to="/" className={LINK_CLASSES}>
      https://roselabs.ai
    </Link>
  );
}

function EmailLink({ email }: { readonly email: string }) {
  return (
    <a href={`mailto:${email}`} className={LINK_CLASSES}>
      {email}
    </a>
  );
}

function BulletList({ items }: { readonly items: readonly { readonly text: string }[] }) {
  return (
    <ul className="space-y-3 text-muted-foreground mb-4">
      {items.map((item) => (
        <li key={item.text} className="flex items-start space-x-3">
          <div className={BULLET_CLASSES} />
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function ContentBlock({ block }: { readonly block: TermsContentBlock }) {
  if (block.kind === 'bullets' && block.items) {
    return <BulletList items={block.items} />;
  }
  return (
    <p className="text-muted-foreground mb-4">
      {block.boldPrefix ? <strong>{block.boldPrefix}</strong> : null}
      {block.text}
    </p>
  );
}

function IntroCard() {
  return (
    <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-lg p-6">
      <p className="text-lg leading-relaxed">
        Welcome to <SiteLink /> (&quot;Rose Labs&quot;, &quot;we&quot;, &quot;us&quot;, or
        &quot;our&quot;). These Terms of Service govern your access to and use of the Rose Labs
        Service. By creating an account or using the Service, you agree to be bound by these Terms.
        Please read them carefully.
      </p>
    </div>
  );
}

/** Sections 1 and 4 embed a site link inside their paragraph text. */
function LinkedSection({ section }: { readonly section: TermsSection }) {
  const block = section.blocks[0];
  const text = block?.text ?? '';
  const parts = text.split('https://roselabs.ai');

  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">
        {section.number}. {section.title}
      </h2>
      <p className="text-muted-foreground">
        {parts[0]}
        <SiteLink />
        {parts[1]}
      </p>
    </section>
  );
}

function GenericSection({ section }: { readonly section: TermsSection }) {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">
        {section.number}. {section.title}
      </h2>
      {section.blocks.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </section>
  );
}

function SmsHelpBlock() {
  return (
    <p className="text-muted-foreground mb-4">
      <strong>Help:</strong> For assistance, reply HELP to any message or contact us at{' '}
      <EmailLink email={TERMS_CONTACT_EMAIL} />.
    </p>
  );
}

function SmsPrivacyBlock() {
  return (
    <p className="text-muted-foreground">
      For information on how we handle your data, please see our{' '}
      <Link to="/privacy" className={LINK_CLASSES}>
        Privacy Policy
      </Link>
      .
    </p>
  );
}

function SmsSection({ section }: { readonly section: TermsSection }) {
  // Render blocks 0-3 generically, then Help with email link, Carrier, then Privacy link
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">
        {section.number}. {section.title}
      </h2>
      {section.blocks.slice(0, 4).map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
      <SmsHelpBlock />
      <ContentBlock block={section.blocks[5]} />
      <SmsPrivacyBlock />
    </section>
  );
}

function ContactSection({ section }: { readonly section: TermsSection }) {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">
        {section.number}. {section.title}
      </h2>
      <p className="text-muted-foreground mb-2">Questions about these Terms?</p>
      <p className="text-muted-foreground">
        Contact: <EmailLink email={TERMS_CONTACT_EMAIL} />
      </p>
    </section>
  );
}

/** Sections that embed a site link (their text contains "https://roselabs.ai"). */
const LINKED_SECTION_NUMBERS = new Set([1, 4]);

function TermsSection({ section }: { readonly section: TermsSection }) {
  if (section.number === 8) return <SmsSection section={section} />;
  if (section.number === 9) return <ContactSection section={section} />;
  if (LINKED_SECTION_NUMBERS.has(section.number)) return <LinkedSection section={section} />;
  return <GenericSection section={section} />;
}

const Terms = () => {
  useTermsSeo();

  return (
    <div className="min-h-screen bg-background">
      <NaviHeader />

      <main className="pt-24 pb-16">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <h1 className="text-4xl font-light tracking-tight mb-8 text-center">
              <span className="gradient-text">Terms of Service</span>
            </h1>

            <p className="text-muted-foreground text-center mb-12">
              Last updated: {TERMS_LAST_UPDATED}
            </p>

            <div className="space-y-8">
              <IntroCard />

              {TERMS_SECTIONS.map((section) => (
                <Fragment key={section.number}>
                  <SectionDivider />
                  <TermsSection section={section} />
                </Fragment>
              ))}

              <SectionDivider />

              <div className="text-center py-8">
                <p className="text-lg font-medium text-foreground">{TERMS_CLOSING}</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <NaviFooter />
    </div>
  );
};

export default Terms;
