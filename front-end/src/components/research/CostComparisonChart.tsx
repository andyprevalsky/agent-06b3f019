/**
 * STATE MACHINE: CostComparisonChart
 *
 * This component is stateless - renders data visualization from static data.
 * Uses useMemo for computed values but no useState.
 *
 * [MOUNTED] --> renders SVG chart with bar graph
 */

import { useMemo } from "react";

interface CostData {
  model: string;
  costPer1M: number;
  category: "rose" | "other";
}

export default function CostComparisonChart() {
  const costData: CostData[] = useMemo(
    () => [
      { model: "GPT-5", costPer1M: 15, category: "other" },
      { model: "Claude Sonnet 4.5", costPer1M: 12, category: "other" },
      { model: "Gemini Flash 2.5", costPer1M: 8, category: "other" },
      { model: "Rose-1", costPer1M: 3, category: "rose" },
    ],
    []
  );

  const maxCost = 20;

  return (
    <div className="w-full max-w-4xl mx-auto py-16">
      <div className="space-y-3 mb-12">
        <span className="text-xs font-semibold tracking-[0.3em] uppercase text-slate-400 block text-center">Benchmark 02 — Cost Surface</span>
        <h2 className="text-3xl font-semibold text-center text-gray-900">
          Rose-1 delivers frontier performance
          <br />
          at a fraction of the cost
        </h2>
      </div>

      <div className="space-y-6">
        {costData.map((item, idx) => (
          <div key={idx} className="flex items-center gap-6">
            <div className="w-48 text-right text-sm text-gray-700 font-medium">{item.model}</div>
            <div className="flex-1 relative h-12">
              <div
                className={`h-full rounded-lg transition-all duration-500 ${
                  item.category === "rose"
                    ? "bg-gradient-to-r from-[#FE7503] via-[#FC585C] to-[#7A6BEC]"
                    : "bg-gradient-to-r from-gray-200 to-gray-300"
                }`}
                style={{ width: `${(item.costPer1M / maxCost) * 100}%` }}
              >
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold flex items-baseline gap-1">
                  <span className={item.category === "rose" ? "text-white" : "text-gray-700"}>${item.costPer1M}</span>
                  <span className={`text-xs ${item.category === "rose" ? "text-white/80" : "text-gray-600"}`}>
                    / 1M tokens
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-12 text-center">
        <p className="text-sm text-gray-500 max-w-2xl mx-auto">
          Rose-1 achieves competitive performance with leading frontier models while maintaining significantly lower
          inference costs, making advanced AI capabilities more accessible.
        </p>
      </div>
    </div>
  );
}
