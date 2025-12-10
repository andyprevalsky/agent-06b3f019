import { Link } from 'react-router-dom';
import { useEffect } from 'react';

export default function OnePager() {
  useEffect(() => {
    document.title = 'Rose Labs One Pager';
    
    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    ensureMeta('description', 'Rose Labs investor one pager - Frontier Research for Agentic Superintelligence.');
  }, []);

  return (
    <main
      className="min-h-screen text-[#1a1a18]"
      style={{
        fontFamily: "'Crimson Pro', Georgia, Cambria, 'Times New Roman', Times, serif",
        background: 'linear-gradient(180deg, #fdfcfa 0%, #f9f7f3 100%)',
      }}
    >
      {/* Header */}
      <header className="max-w-3xl mx-auto px-8 py-10 flex items-center justify-between">
        <Link
          to="/"
          className="text-sm tracking-wide text-[#8a8680] hover:text-[#1a1a18] transition-colors"
          style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.04em' }}
        >
          ← Back to terminal
        </Link>
      </header>

      {/* Main Content */}
      <article className="max-w-3xl mx-auto px-8 pb-24">
        {/* Title Block */}
        <div className="mb-16 flex items-start gap-8">
          <div
            className="w-16 h-16 rounded-2xl shadow-lg shrink-0"
            style={{
              background: 'linear-gradient(135deg, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          />
          <div>
            <h1
              className="text-5xl md:text-6xl font-light tracking-tight mb-4"
              style={{ letterSpacing: '-0.02em' }}
            >
              Rose Labs
            </h1>
            <p
              className="text-lg text-[#6b6860]"
              style={{ fontFamily: "'DM Sans', sans-serif" }}
            >
              Frontier Research for Agentic Superintelligence
            </p>
          </div>
        </div>

        {/* Intro */}
        <section className="mb-14">
          <p className="text-xl leading-relaxed text-[#3d3a36] mb-6">
            Hi, I’m <a href="https://linkedin.com/in/andyprevalsky" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline underline-offset-2 transition-colors">Andy</a>, and I’m building Rose Labs, a frontier AI research company in San Francisco.
          </p>
          <p className="text-xl leading-relaxed text-[#3d3a36]">
            Rose Labs is pioneering <strong>Mass Agent Networks (MANs)</strong> which we believe is the architecture that will produce the first real superintelligence.
          </p>
        </section>

        {/* Horizontal Rule */}
        <hr className="border-t border-[#e5e2dc] my-14" />

        {/* Why Mass Agent Networks Are the Evolutionary Leap */}
        <section className="mb-14">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            Why Mass Agent Networks Are the Evolutionary Leap
          </h2>
          <p className="text-lg text-[#3d3a36] mb-4">
            Today’s AI systems resemble unicellular organisms. They are large, monolithic, indivisible blocks of compute that cannot parallelize well. Scaling increases parameter count but not organizational intelligence.
          </p>
          <p className="text-lg text-[#3d3a36] mb-6">
            Mass Agent Networks are a massive leap in the seemingly obvious direction these systems are headed, the transition from unicellular → multicellular.
          </p>
          <p className="text-lg text-[#3d3a36] mb-4">
            Instead of one large model doing everything, MANs are societies of specialized agents that:
          </p>
          <ul className="space-y-4 text-lg text-[#3d3a36]">
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>divide complex tasks into small tractable components</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>keep context small where models perform best</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>run thousands of reasoning paths in parallel</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>cross verify each other’s work to avoid error and drift</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>self organize into higher order structures over time</span>
            </li>
          </ul>
          <p className="text-lg text-[#3d3a36] mt-6">
            Just as multicellular organisms outcompete unicellular ones, agent societies outperform monolithic models, especially in real world action.
          </p>
        </section>

        {/* Why MANs Lead to Superintelligence */}
        <section className="mb-14">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            Why MANs Lead to Superintelligence
          </h2>
          <p className="text-lg text-[#3d3a36] mb-4">
            Superintelligence is not the ability to one shot every problem. It is the ability to efficiently explore, iterate, and adapt.
          </p>
          <ul className="space-y-4 text-lg text-[#3d3a36] mb-6">
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>Small agent networks explore too slowly.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>Monolithic models explore too shallowly.</span>
            </li>
          </ul>
          <p className="text-lg text-[#3d3a36] mb-4">
            Mass Agent Networks explore at ecosystem scale. They generate and evaluate thousands of hypotheses in parallel, recombine strategies, and improve through specialization and cooperation.
          </p>
          <p className="text-lg text-[#3d3a36]">
            Future AI systems will run orders of magnitude more agents than anything that exists today. The shift is from single reasoning passes to evolving intelligent societies.
          </p>
        </section>

        {/* What We Built in Less Than 60 Days */}
        <section className="mb-14">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            What We Built in Less Than 60 Days
          </h2>
          <ul className="space-y-8 text-lg text-[#3d3a36]">
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none text-xl font-light">1.</span>
              <div>
                <strong className="block mb-2">A <a href="https://roselabs.ai" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 underline underline-offset-2 transition-colors">full stack product</a> and desktop app implementing early MANs</strong>
                <p className="text-[#6b6860]">Built from scratch. A working beta where real agent societies coordinate reasoning and action in real time. Rose Labs agents can live forever, are fault tolerant, and made to reach convergence over time through relentless exploration.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none text-xl font-light">2.</span>
              <div>
                <strong className="block mb-2">A new model competitive with major labs</strong>
                <p className="text-[#6b6860]">A custom architecture performing on par with leading frontier models across general tasks using MAN driven methods.</p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none text-xl font-light">3.</span>
              <div>
                <strong className="block mb-2">Foundational research breakthroughs</strong>
                <p className="text-[#6b6860]">Including Prompt Braiding, a technique for maximizing genetic diversity and exploration across large agent populations, resulting in stronger generality and self improving reasoning loops.</p>
              </div>
            </li>
          </ul>
        </section>

        {/* Vision */}
        <section className="mb-14">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            Vision
          </h2>
          <p className="text-lg text-[#3d3a36] mb-4">Within a decade:</p>
          <ul className="space-y-4 text-lg text-[#3d3a36] mb-6">
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>We will have AI systems that have as many agents as current models have parameters. Rose Labs will create the first billion / trillion agent systems.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>Pre-training & post-training will be saturated and all the big labs will be spending most of their resources in designing mass agent architectures.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>Mass Agent Networks will be the dominant architecture for consumer superintelligence. If you don't have an agentic army at your disposal then you will be completely left behind.</span>
            </li>
          </ul>
          <p className="text-lg text-[#3d3a36]">
            Rose Labs is building the foundation for this architecture.
          </p>
        </section>

        {/* Founder */}
        <section className="mb-14">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            Founder
          </h2>
          <ul className="space-y-4 text-lg text-[#3d3a36]">
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>
                <strong>Andy Prevalsky</strong>
              </span>
            </li>
            <li className="flex gap-3 ml-6">
              <span className="text-[#c9c5be] select-none">-</span>
              <span>
                Built Hotplate from zero to PMF, the company is now highly profitable and doing 5M ARR
              </span>
            </li>
            <li className="flex gap-3 ml-6">
              <span className="text-[#c9c5be] select-none">-</span>
              <span>
                Sole engineer for the first three years across full stack, infrastructure, growth, and distribution
              </span>
            </li>
            <li className="flex gap-3 ml-6">
              <span className="text-[#c9c5be] select-none">-</span>
              <span>
                10 years of machine learning experience from building high frequency trading models with RNNs, LSTMs, and Markov Chains in 2018 to developing a full ML pipeline at Hotplate in 2021 that measured every potential customer in the market and identified the highest value ones driving 95 percent of user acquisition
              </span>
            </li>
            <li className="flex gap-3 ml-6">
              <span className="text-[#c9c5be] select-none">-</span>
              <span>
                Ex Google and Meta AI
              </span>
            </li>
            <li className="flex gap-3 ml-6">
              <span className="text-[#c9c5be] select-none">-</span>
              <span>
                Previously backed by Michael Seibel, Connie Chan at A16Z, and YC
              </span>
            </li>
            <li className="flex gap-3 ml-6">
              <span className="text-[#c9c5be] select-none">-</span>
              <span>
                Mentored for six years by Michael Seibel
              </span>
            </li>
          </ul>
        </section>

        {/* Raise */}
        <section className="mb-14">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            Raise
          </h2>
          <ul className="space-y-4 text-lg text-[#3d3a36]">
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>$3M</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>Hire engineers, acquire GPUs.</span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#c9c5be] select-none">•</span>
              <span>
                We want investors that:
                <ul className="mt-2 ml-6 space-y-2">
                  <li>- Will connect us with customers.</li>
                  <li>- Help us hire top talent.</li>
                  <li>- Have deep expertise in AI, infra, and/or security.</li>
                </ul>
              </span>
            </li>
          </ul>
        </section>

        {/* Horizontal Rule */}
        <hr className="border-t border-[#e5e2dc] my-14" />

        {/* Contact */}
        <section className="text-center">
          <h2
            className="text-2xl font-medium mb-6 text-[#1a1a18]"
            style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.01em' }}
          >
            Contact
          </h2>
          <p className="text-lg text-[#6b6860]">
            <a
              href="mailto:andy@roselabs.ai"
              className="underline decoration-[#c9c5be] hover:decoration-[#1a1a18] underline-offset-4 transition-colors"
            >
              andy@roselabs.ai
            </a>
          </p>
        </section>
      </article>

      {/* Footer */}
      <footer className="max-w-3xl mx-auto px-8 py-10 border-t border-[#e5e2dc]">
        <p
          className="text-sm text-[#8a8680] text-center"
          style={{ fontFamily: "'DM Sans', sans-serif" }}
        >
          © {new Date().getFullYear()} Rose Labs
        </p>
      </footer>
    </main>
  );
}
