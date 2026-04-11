/**
 * STATE MACHINE: OnePagerSections
 *
 * Stateless - renders the core content sections of the one-pager:
 *   MANs Evolutionary Leap, MANs Lead to Superintelligence, What We Built,
 *   Vision, Founders, and Raise.
 *
 * [MOUNTED] --> renders static content
 */

import { SECTION_HEADING_STYLE } from '../config';

function SectionHeading({ children }: { readonly children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-medium mb-6 text-[#1a1a18]" style={SECTION_HEADING_STYLE}>
      {children}
    </h2>
  );
}

function Bullet({ children }: { readonly children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="text-[#c9c5be] select-none">&bull;</span>
      <span>{children}</span>
    </li>
  );
}

export function EvolutionaryLeapSection() {
  return (
    <section className="mb-14">
      <SectionHeading>Why Mass Agent Networks Are the Evolutionary Leap</SectionHeading>
      <p className="text-lg text-[#3d3a36] mb-4">
        Today's AI systems resemble unicellular organisms. They are large, monolithic, indivisible
        blocks of compute that cannot parallelize well. Scaling increases parameter count but not
        organizational intelligence.
      </p>
      <p className="text-lg text-[#3d3a36] mb-6">
        Mass Agent Networks are a massive leap in the seemingly obvious direction these systems are
        headed, the transition from unicellular &rarr; multicellular.
      </p>
      <p className="text-lg text-[#3d3a36] mb-4">
        Instead of one large model doing everything, MANs are societies of specialized agents that:
      </p>
      <ul className="space-y-4 text-lg text-[#3d3a36]">
        <Bullet>divide complex tasks into small tractable components</Bullet>
        <Bullet>keep context small where models perform best</Bullet>
        <Bullet>run thousands of reasoning paths in parallel</Bullet>
        <Bullet>cross verify each other's work to avoid error and drift</Bullet>
        <Bullet>self organize into higher order structures over time</Bullet>
      </ul>
      <p className="text-lg text-[#3d3a36] mt-6">
        Just as multicellular organisms outcompete unicellular ones, agent societies outperform
        monolithic models, especially in real world action.
      </p>
    </section>
  );
}

export function SuperintelligenceSection() {
  return (
    <section className="mb-14">
      <SectionHeading>Why MANs Lead to Superintelligence</SectionHeading>
      <p className="text-lg text-[#3d3a36] mb-4">
        Superintelligence is not the ability to one shot every problem. It is the ability to
        efficiently explore, iterate, and adapt.
      </p>
      <ul className="space-y-4 text-lg text-[#3d3a36] mb-6">
        <Bullet>Small agent networks explore too slowly.</Bullet>
        <Bullet>Monolithic models explore too shallowly.</Bullet>
      </ul>
      <p className="text-lg text-[#3d3a36] mb-4">
        Mass Agent Networks explore at ecosystem scale. They generate and evaluate thousands of
        hypotheses in parallel, recombine strategies, and improve through specialization and
        cooperation.
      </p>
      <p className="text-lg text-[#3d3a36]">
        Future AI systems will run orders of magnitude more agents than anything that exists today.
        The shift is from single reasoning passes to evolving intelligent societies.
      </p>
    </section>
  );
}

export function WhatWeBuiltSection() {
  return (
    <section className="mb-14">
      <SectionHeading>What We Built in Less Than 60 Days</SectionHeading>
      <ul className="space-y-8 text-lg text-[#3d3a36]">
        <li className="flex gap-3">
          <span className="text-[#c9c5be] select-none text-xl font-light">1.</span>
          <div>
            <strong className="block mb-2">
              A{' '}
              <a
                href="https://roselabs.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline underline-offset-2 transition-colors"
              >
                full stack product
              </a>{' '}
              and desktop app implementing early MANs
            </strong>
            <p className="text-[#6b6860]">
              Built from scratch. A working beta where real agent societies coordinate reasoning and
              action in real time. Rose Labs agents can live forever, are fault tolerant, and made
              to reach convergence over time through relentless exploration.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="text-[#c9c5be] select-none text-xl font-light">2.</span>
          <div>
            <strong className="block mb-2">A new model competitive with major labs</strong>
            <p className="text-[#6b6860]">
              A custom architecture performing on par with leading frontier models across general
              tasks using MAN driven methods.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="text-[#c9c5be] select-none text-xl font-light">3.</span>
          <div>
            <strong className="block mb-2">Foundational research breakthroughs</strong>
            <p className="text-[#6b6860]">
              Including Prompt Braiding, a technique for maximizing genetic diversity and
              exploration across large agent populations, resulting in stronger generality and self
              improving reasoning loops.
            </p>
          </div>
        </li>
      </ul>
    </section>
  );
}

export function VisionSection() {
  return (
    <section className="mb-14">
      <SectionHeading>Vision</SectionHeading>
      <p className="text-lg text-[#3d3a36] mb-4">Within a decade:</p>
      <ul className="space-y-4 text-lg text-[#3d3a36] mb-6">
        <Bullet>
          We will have AI systems that have as many agents as current models have parameters. Rose
          Labs will create the first billion / trillion agent systems.
        </Bullet>
        <Bullet>
          Pre-training &amp; post-training will be saturated and all the big labs will be spending
          most of their resources in designing mass agent architectures.
        </Bullet>
        <Bullet>
          Mass Agent Networks will be the dominant architecture for consumer superintelligence. If
          you don't have an agentic army at your disposal then you will be completely left behind.
        </Bullet>
      </ul>
      <p className="text-lg text-[#3d3a36]">
        Rose Labs is building the foundation for this architecture.
      </p>
    </section>
  );
}

export function FoundersSection() {
  return (
    <section className="mb-14">
      <SectionHeading>Founders</SectionHeading>
      <ul className="space-y-4 text-lg text-[#3d3a36]">
        <Bullet>
          <strong>Andy Prevalsky</strong>
        </Bullet>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>
            Built Hotplate from zero to PMF, the company is now highly profitable and doing 5M ARR
          </span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>
            Sole engineer at Hotplate for the first three years while also leading strategy &amp;
            distribution.
          </span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>
            10 years of machine learning experience from building high frequency trading models with
            RNNs, LSTMs, and Markov Chains in 2018 to developing a full ML pipeline at Hotplate in
            2021 that measured every potential customer in the market and identified the highest
            value ones driving 95 percent of user acquisition
          </span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Ex Google and Meta AI</span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Previously backed by Michael Seibel, Connie Chan at A16Z, and YC</span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Mentored for six years by Michael Seibel</span>
        </li>
        <li className="flex gap-3 mt-6">
          <span className="text-[#c9c5be] select-none">&bull;</span>
          <span>
            <strong>Aaditya Shidham</strong>
          </span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Previously invested at a16z, focused on infra</span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Built the MPC web3 wallet at Coinbase from 0 to 1</span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Product Lead at Protocol Labs, scaled FVM to 635K users and $280M TVL</span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Stanford CS undergrad and graduate</span>
        </li>
        <li className="flex gap-3 ml-6">
          <span className="text-[#c9c5be] select-none">-</span>
          <span>Thiel Fellow Finalist</span>
        </li>
      </ul>
    </section>
  );
}

export function RaiseSection() {
  return (
    <section className="mb-14">
      <SectionHeading>Raise</SectionHeading>
      <ul className="space-y-4 text-lg text-[#3d3a36]">
        <Bullet>$3M</Bullet>
        <Bullet>Hire engineers, acquire GPUs.</Bullet>
        <Bullet>
          We want investors that:
          <ul className="mt-2 ml-6 space-y-2">
            <li>- Will connect us with customers.</li>
            <li>- Help us hire top talent.</li>
            <li>- Have deep expertise in AI, infra, and/or security.</li>
          </ul>
        </Bullet>
      </ul>
    </section>
  );
}

export function ContactSection() {
  return (
    <section className="text-center">
      <SectionHeading>Contact</SectionHeading>
      <p className="text-lg text-[#6b6860]">
        <a
          href="mailto:andy@roselabs.ai"
          className="underline decoration-[#c9c5be] hover:decoration-[#1a1a18] underline-offset-4 transition-colors"
        >
          andy@roselabs.ai
        </a>
      </p>
    </section>
  );
}
