/**
 * STATE MACHINE: Privacy
 *
 * This component is stateless - displays static privacy policy content.
 *
 * [MOUNTED] --> renders static content
 */

import { Fragment } from 'react';

import NaviHeader from '@/components/NaviHeader';
import NaviFooter from '@/components/NaviFooter';

import { usePrivacySeo } from '../hooks';
import {
  PRIVACY_LAST_UPDATED,
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_INTRO,
  PRIVACY_CLOSING,
  PRIVACY_SECTIONS,
} from '../config';
import type { PrivacySection } from '../types';

const LINK_CLASSES = 'text-primary hover:text-primary/80 underline transition-colors';
const BULLET_CLASSES = 'w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-foreground';
const DIVIDER_CLASSES = 'w-full h-px bg-gradient-to-r from-transparent via-border to-transparent';

function SectionDivider() {
  return <div className={DIVIDER_CLASSES} />;
}

function BulletList({ items }: { readonly items: readonly { readonly text: string }[] }) {
  return (
    <ul className="space-y-3 text-muted-foreground">
      {items.map((item) => (
        <li key={item.text} className="flex items-start space-x-3">
          <div className={BULLET_CLASSES} />
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function PolicySection({ section }: { readonly section: PrivacySection }) {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">
        {section.number}. {section.title}
      </h2>
      {section.bullets ? <BulletList items={section.bullets} /> : null}
      {section.paragraph ? <p className="text-muted-foreground">{section.paragraph}</p> : null}
    </section>
  );
}

function PolicyUpdatesSection() {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">6. Policy Updates</h2>
      <p className="text-muted-foreground">
        We may amend this Privacy Policy occasionally. The latest version will always be available
        at{' '}
        <a href="/" className={LINK_CLASSES}>
          www.roselabs.ai
        </a>{' '}
        with the date of last revision.
      </p>
    </section>
  );
}

function ContactSection() {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4 text-foreground">7. Contact</h2>
      <p className="text-muted-foreground mb-2">Have questions or concerns? Reach out anytime:</p>
      <p className="text-muted-foreground">
        Email:{' '}
        <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`} className={LINK_CLASSES}>
          {PRIVACY_CONTACT_EMAIL}
        </a>
      </p>
    </section>
  );
}

const Privacy = () => {
  usePrivacySeo();

  return (
    <div className="min-h-screen bg-background">
      <NaviHeader />

      <main className="pt-24 pb-16">
        <div className="container mx-auto px-6 max-w-4xl">
          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <h1 className="text-4xl font-light tracking-tight mb-8 text-center">
              <span className="gradient-text">Privacy Policy</span>
            </h1>

            <p className="text-muted-foreground text-center mb-12">
              Last updated: {PRIVACY_LAST_UPDATED}
            </p>

            <div className="space-y-8">
              <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-lg p-6">
                <p className="text-lg leading-relaxed">{PRIVACY_INTRO}</p>
                <p className="mt-4 text-muted-foreground">
                  Visit{' '}
                  <a href="/" className={LINK_CLASSES}>
                    www.roselabs.ai
                  </a>{' '}
                  to learn more about our service.
                </p>
              </div>

              {PRIVACY_SECTIONS.slice(0, 5).map((section) => (
                <Fragment key={section.number}>
                  <SectionDivider />
                  <PolicySection section={section} />
                </Fragment>
              ))}

              <SectionDivider />
              <PolicyUpdatesSection />

              <SectionDivider />
              <ContactSection />

              <SectionDivider />

              <div className="text-center py-8">
                <p className="text-lg font-medium text-foreground">{PRIVACY_CLOSING}</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <NaviFooter />
    </div>
  );
};

export default Privacy;
