/**
 * STATE MACHINE: Research
 *
 * This component is stateless - displays static research content with charts.
 *
 * [MOUNTED] --> renders charts and content
 */

import { Link } from 'react-router-dom';
import PerformanceChart from '@/components/research/PerformanceChart';
import AccuracyOverTimeChart from '@/components/research/AccuracyOverTimeChart';
import CostComparisonChart from '@/components/research/CostComparisonChart';

export default function Research() {
  return (
    <main className="min-h-screen bg-white text-slate-900" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif' }}>
      <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-slate-500 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <svg className="w-8 h-8" viewBox="21 62 220 222" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="research-logo-gradient" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#FE7503" />
                <stop offset="25%" stopColor="#FC585C" />
                <stop offset="50%" stopColor="#E062CC" />
                <stop offset="75%" stopColor="#A76CED" />
                <stop offset="100%" stopColor="#7A6BEC" />
              </linearGradient>
            </defs>
            <g transform="translate(0,303) scale(0.1,-0.1)" fill="url(#research-logo-gradient)">
              <path d="M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z"/>
            </g>
          </svg>
          <div className="text-slate-700">
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Rose Labs</p>
            <p className="text-base font-semibold text-slate-900">Research</p>
          </div>
        </div>
        <Link to="/terminal" className="text-xs font-semibold tracking-wide uppercase text-slate-500 hover:text-slate-900 transition-colors">
          Back to terminal →
        </Link>
      </div>

      <article className="max-w-4xl mx-auto px-6 pb-32 space-y-16">
        <section className="pt-16 space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold leading-tight text-slate-900">
            Rose-1 for software engineering
          </h1>
          <p className="text-sm text-slate-500">
            July 2025 · Rose Labs × Rose
          </p>
          <p className="text-lg text-slate-600 leading-relaxed">
            Rose-1 is our agentic model for building software in real codebases. This page shows how it performs on the same style
            of benchmarks Cursor uses for Composer: intelligence vs. speed, cost, and accuracy over time.
          </p>
        </section>

        <section className="space-y-5">
          <div className="rounded-3xl border border-slate-200 bg-slate-50/50 p-6">
            <PerformanceChart />
          </div>
          <p className="text-sm text-slate-500">
            Placeholder numbers are representative until the full SWE Bench comparison is published; the relative ordering mirrors screenshot 1
            from the Cursor composer post for early context.
          </p>
        </section>

        <section className="space-y-5">
          <div className="rounded-3xl border border-slate-200 bg-slate-50/50 p-6">
            <CostComparisonChart />
          </div>
          <p className="text-sm text-slate-500">
            Bars reflect current placeholder pricing bands and will update the moment our public API contracts are finalized.
          </p>
        </section>

        <section className="space-y-5">
          <div className="rounded-3xl border border-slate-200 bg-slate-50/50 p-6">
            <AccuracyOverTimeChart />
          </div>
          <p className="text-sm text-slate-500">
            Reference lines show today's best open and best frontier baselines; Rose-1 crosses them as additional data and compute come online.
          </p>
        </section>

        <section className="space-y-4 text-lg text-slate-700 leading-relaxed">
          <p>
            Ready to inspect the system live?{' '}
            <Link to="/terminal" className="underline decoration-slate-300 hover:decoration-slate-600 underline-offset-4">
              Open the Rose terminal
            </Link>{' '}
            to experience Rose-1 in context.
          </p>
        </section>
      </article>
    </main>
  );
}
