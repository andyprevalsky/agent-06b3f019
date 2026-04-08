import { useMemo } from 'react';

interface DataPoint {
  compute: number; // log scale
  score: number;
  label?: string;
}

export default function AccuracyOverTimeChart() {
  const dataPoints: DataPoint[] = useMemo(
    () => [
      { compute: 1, score: 38 },
      { compute: 2, score: 40 },
      { compute: 3, score: 42 },
      { compute: 4, score: 43 },
      { compute: 5, score: 44 },
      { compute: 6, score: 45 },
      { compute: 7, score: 46 },
      { compute: 8, score: 47 },
      { compute: 9, score: 48 },
      { compute: 10, score: 49 },
      { compute: 11, score: 50 },
      { compute: 12, score: 51 },
      { compute: 13, score: 52 },
      { compute: 14, score: 53 },
    ],
    [],
  );

  const minCompute = 0;
  const maxCompute = 15;
  const minScore = 30;
  const maxScore = 60;
  const bestOpenScore = 35;
  const bestFrontierScore = 54;

  const getX = (compute: number) => {
    return ((compute - minCompute) / (maxCompute - minCompute)) * 100;
  };

  const getY = (score: number) => {
    return 100 - ((score - minScore) / (maxScore - minScore)) * 100;
  };

  return (
    <div className="w-full max-w-6xl mx-auto py-16">
      <h2 className="text-4xl font-semibold text-center mb-16 text-gray-900">
        Rose-1's software engineering ability
        <br />
        improves with RL training
      </h2>

      <div className="relative w-full h-96 bg-gradient-to-br from-gray-50 to-white rounded-2xl p-12 border border-gray-200">
        {/* Best frontier model line */}
        <div
          className="absolute left-12 right-12 border-t-2 border-dashed border-gray-300"
          style={{ top: `${12 + getY(bestFrontierScore) * 0.72}px` }}
        >
          <span className="absolute -top-6 right-0 text-xs text-gray-500 bg-white px-2">
            Best frontier model
          </span>
        </div>

        {/* Best open model line */}
        <div
          className="absolute left-12 right-12 border-t-2 border-dashed border-gray-300"
          style={{ top: `${12 + getY(bestOpenScore) * 0.72}px` }}
        >
          <span className="absolute -top-6 left-0 text-xs text-gray-500 bg-white px-2">
            Best open model
          </span>
        </div>

        {/* Data points */}
        {dataPoints.map((point, idx) => (
          <div
            key={idx}
            className="absolute w-3 h-3 rounded-full bg-gradient-to-br from-[#FE7503] to-[#7A6BEC] shadow-lg transition-all duration-300 hover:scale-150"
            style={{
              left: `${12 + getX(point.compute) * 0.88}%`,
              top: `${12 + getY(point.score) * 0.72}px`,
            }}
          />
        ))}

        {/* Trend annotation */}
        <div className="absolute right-16 top-1/2 -translate-y-1/2">
          <div className="bg-gradient-to-r from-[#FE7503] via-[#FC585C] to-[#7A6BEC] text-white px-4 py-2 rounded-lg text-sm font-medium shadow-lg">
            Rose <span className="font-bold italic">increases consistently</span> on our
            <br />
            benchmark with more training compute
          </div>
        </div>

        {/* Axes labels */}
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-sm text-gray-600">
          Training compute (log)
        </div>
        <div className="absolute left-2 top-1/2 -translate-y-1/2 -rotate-90 text-sm text-gray-600 whitespace-nowrap">
          Cursor Bench
          <br />
          60
        </div>

        {/* X-axis ticks */}
        <div className="absolute bottom-8 left-12 right-12 flex justify-between text-xs text-gray-400">
          <span>30</span>
          <span>40</span>
          <span>50</span>
          <span>60</span>
        </div>
      </div>
    </div>
  );
}
