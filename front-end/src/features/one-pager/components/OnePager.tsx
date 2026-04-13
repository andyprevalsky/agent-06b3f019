/**
 * STATE MACHINE: OnePager
 *
 * This component is stateless - displays static investor one-pager content.
 * Only side effect: sets document title and meta tags on mount.
 *
 * [MOUNTED] --> sets meta tags --> renders static content
 */

import { useOnePagerSeo } from '../hooks';
import { PAGE_FONT_FAMILY, PAGE_BACKGROUND } from '../config';

import OnePagerHeader from './OnePagerHeader';
import OnePagerIntro from './OnePagerIntro';
import {
  EvolutionaryLeapSection,
  SuperintelligenceSection,
  WhatWeBuiltSection,
  VisionSection,
  FoundersSection,
  RaiseSection,
  ContactSection,
} from './OnePagerSections';

export default function OnePager() {
  useOnePagerSeo();

  return (
    <main
      className="min-h-screen text-[#1a1a18]"
      style={{
        fontFamily: PAGE_FONT_FAMILY,
        background: PAGE_BACKGROUND,
      }}
    >
      <OnePagerHeader />

      <article className="max-w-3xl mx-auto px-8 pb-24">
        <OnePagerIntro />
        <hr className="border-t border-[#e5e2dc] my-14" />
        <EvolutionaryLeapSection />
        <SuperintelligenceSection />
        <WhatWeBuiltSection />
        <VisionSection />
        <FoundersSection />
        <RaiseSection />
        <hr className="border-t border-[#e5e2dc] my-14" />
        <ContactSection />
      </article>

      <footer className="max-w-3xl mx-auto px-8 py-10 border-t border-[#e5e2dc]">
        <p
          className="text-sm text-[#8a8680] text-center"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          &copy; {new Date().getFullYear()} Rose Labs
        </p>
      </footer>
    </main>
  );
}
