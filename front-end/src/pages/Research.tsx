import { Link } from 'react-router-dom';
import PerformanceChart from '@/components/research/PerformanceChart';
import AccuracyOverTimeChart from '@/components/research/AccuracyOverTimeChart';
import CostComparisonChart from '@/components/research/CostComparisonChart';

export default function Research() {
  return (
    <main className="min-h-screen bg-white text-slate-900" style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif' }}>
      <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between text-sm text-slate-500 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl"
            style={{
              background:
                'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          />
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
            July 2025 · Rose Labs × Navi
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
              Open the Navi terminal
            </Link>{' '}
            to experience Rose-1 in context.
          </p>
        </section>
      </article>
    </main>
  );
}
