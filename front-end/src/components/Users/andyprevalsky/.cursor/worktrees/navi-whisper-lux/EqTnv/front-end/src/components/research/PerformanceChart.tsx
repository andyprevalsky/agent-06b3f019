import { useMemo } from 'react';

interface ModelData {
  name: string;
  intelligence: number; // Cursor Bench score
  speed: number; // Tokens per second
  category: 'best-frontier' | 'fast-frontier' | 'frontier-7-2025' | 'rose' | 'best-open';
}

export default function PerformanceChart() {
  const models: ModelData[] = useMemo(
    () => [
      { name: 'Best Open', intelligence: 35, speed: 65, category: 'best-open' },
      { name: 'Fast Frontier', intelligence: 48, speed: 150, category: 'fast-frontier' },
      { name: 'Frontier 7/2025', intelligence: 52, speed: 45, category: 'frontier-7-2025' },
      { name: 'Rose-1', intelligence: 58, speed: 220, category: 'rose' },
      { name: 'Best Frontier†', intelligence: 62, speed: 30, category: 'best-frontier' },
    ],
    [],
  );

  const maxIntelligence = 70;
  const maxSpeed = 250;

  const getBarColor = (category: string) => {
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
    <div className="w-full max-w-6xl mx-auto py-16">
      <h2 className="text-4xl font-semibold text-center mb-4 text-gray-900">
        Rose-1 combines strong coding intelligence
        <br />
        with best-in-class speed
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-12 mt-16">
        {/* Intelligence Chart */}
        <div>
          <div className="space-y-4">
            {models.map((model, idx) => (
              <div key={`intel-${idx}`} className="flex items-center gap-4">
                <div className="w-32 text-sm text-gray-600 text-right flex-shrink-0">
                  {model.name}
                </div>
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
            <div className="text-sm text-gray-500">Intelligence</div>
            <div className="text-xs text-gray-400 mt-1">(Cursor Bench score)</div>
          </div>
          <div className="flex items-center justify-between mt-4 px-32">
            <span className="text-xs text-gray-400">0</span>
            <span className="text-xs text-gray-400">20</span>
            <span className="text-xs text-gray-400">40</span>
            <span className="text-xs text-gray-400">60</span>
          </div>
        </div>

        {/* Speed Chart */}
        <div>
          <div className="space-y-4">
            {models.map((model, idx) => (
              <div key={`speed-${idx}`} className="flex items-center gap-4">
                <div className="w-32 text-sm text-gray-600 text-right flex-shrink-0">
                  {model.name}
                </div>
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
            <div className="text-sm text-gray-500">Speed</div>
            <div className="text-xs text-gray-400 mt-1">(Tokens per Second)</div>
          </div>
          <div className="flex items-center justify-between mt-4 px-32">
            <span className="text-xs text-gray-400">0</span>
            <span className="text-xs text-gray-400">100</span>
            <span className="text-xs text-gray-400">200</span>
          </div>
        </div>
      </div>

      <div className="mt-8 text-center text-xs text-gray-400">
        † Best Frontier includes GPT-5 and Sonnet 4.5
      </div>
    </div>
  );
}
