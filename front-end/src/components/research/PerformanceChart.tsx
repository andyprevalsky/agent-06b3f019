import { useMemo } from 'react';

interface ModelData {
  name: string;
  intelligence: number;
  speed: number;
  category: 'best-frontier' | 'fast-frontier' | 'frontier-7-2025' | 'rose' | 'best-open';
}

export default function PerformanceChart() {
  const models: ModelData[] = useMemo(
    () => [
      { name: 'Best Open', intelligence: 35, speed: 65, category: 'best-open' },
      { name: 'Fast Frontier', intelligence: 48, speed: 150, category: 'fast-frontier' },
      { name: 'Frontier 7/2025', intelligence: 52, speed: 45, category: 'frontier-7-2025' },
      { name: 'Rose-1', intelligence: 58, speed: 220, category: 'rose' },
      { name: 'Best Frontier\u2020', intelligence: 62, speed: 30, category: 'best-frontier' },
    ],
    []
  );

  const maxIntelligence = 70;
  const maxSpeed = 250;

  const getBarColor = (category: ModelData['category']) => {
    switch (category) {
      case 'rose':
        return 'from-[#FE7503] via-[#FC585C] to-[#7A6BEC]';
      case 'best-frontier':
        return 'from-gray-300 to-gray-400';
      default:
        return 'from-gray-200 to-gray-300';
    }
  };

  return (
    <section className="rounded-3xl border border-slate-200 bg-slate-50/60 p-8 space-y-8">
      <div className="space-y-3">
        <span className="text-xs font-semibold tracking-[0.3em] uppercase text-slate-400 block">Benchmark 01 — SWE Bench</span>
        <div className="space-y-2">
          <h2 className="text-3xl font-semibold text-slate-900 leading-snug">
            Rose-1 combines frontier intelligence with real-time speed
          </h2>
          <p className="text-sm text-slate-500">
            Mock scores shown for context. Rose-1 plots in the upper-right quadrant, surpassing open models on accuracy while remaining faster
            than fast frontier agents.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
        <div>
          <div className="space-y-4">
            {models.map((model) => (
              <div key={`intel-${model.name}`} className="flex items-center gap-4">
                <div className="w-32 text-sm text-slate-500 text-right flex-shrink-0">{model.name}</div>
                <div className="flex-1 relative h-10">
                  <div
                    className={`h-full bg-gradient-to-r ${getBarColor(model.category)} rounded transition-all duration-500`}
                    style={{ width: `${(model.intelligence / maxIntelligence) * 100}%` }}
                  />
                  {model.category === 'rose' && (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 text-white text-xs font-medium">
                      {model.intelligence}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <div className="text-sm text-slate-600">Intelligence</div>
            <div className="text-xs text-slate-400 mt-1">(Cursor Bench score)</div>
          </div>
          <div className="flex items-center justify-between mt-4 px-32 text-xs text-slate-400">
            <span>0</span>
            <span>20</span>
            <span>40</span>
            <span>60</span>
          </div>
        </div>

        <div>
          <div className="space-y-4">
            {models.map((model) => (
              <div key={`speed-${model.name}`} className="flex items-center gap-4">
                <div className="w-32 text-sm text-slate-500 text-right flex-shrink-0">{model.name}</div>
                <div className="flex-1 relative h-10">
                  <div
                    className={`h-full bg-gradient-to-r ${getBarColor(model.category)} rounded transition-all duration-500`}
                    style={{ width: `${(model.speed / maxSpeed) * 100}%` }}
                  />
                  {model.category === 'rose' && (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 text-white text-xs font-medium">
                      {model.speed}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <div className="text-sm text-slate-600">Speed</div>
            <div className="text-xs text-slate-400 mt-1">(Tokens per Second)</div>
          </div>
          <div className="flex items-center justify-between mt-4 px-32 text-xs text-slate-400">
            <span>0</span>
            <span>100</span>
            <span>200</span>
          </div>
        </div>
      </div>

      <div className="text-center text-xs text-slate-400">\u2020 Best Frontier includes GPT-5 and Sonnet 4.5</div>
    </section>
  );
}
