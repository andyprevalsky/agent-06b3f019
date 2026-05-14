/**
 * set_plan tool → PlanChip.
 *
 * Calls onTypingComplete immediately (PlanChip does not animate text) so the
 * Terminal message queue is not blocked. Handles ERROR, IN_PROGRESS, and
 * FINISHED statuses by feeding the PlanChip with either the streamed data
 * payload or the fallback error/loading state.
 *
 * STREAMING METRIC:
 * PLAN_STREAM supplies char count plus llm_started_at_ms. PlanChip converts
 * chars to token estimate and renders X.Ys · ↓ X tokens.
 */
import type { Message } from '../../hooks';
import { PlanChip } from '../PlanChip';
import type { PlanTask } from '../../hooks';

interface DependencyGraphEntry {
  task_idx?: string | number;
  depends_on?: Array<string | number>;
}

interface PlanTaskWithDeps extends PlanTask {
  depends_on?: Array<string | number>;
}

interface PlanDataShape {
  title?: string;
  content?: string;
  tasks?: PlanTaskWithDeps[];
  dependencies?: Record<string, string[]> | DependencyGraphEntry[] | null;
  dependencies_graph?: DependencyGraphEntry[] | null;
  join?: 'all' | 'any';
  status?: 'planning' | 'ready' | 'executing' | 'complete' | 'error';
}

interface PlanBubbleProps {
  message: Message;
  shouldType?: boolean;
  onTypingComplete?: () => void;
  planCharCount?: number;
  planStreamStartedAtMs?: number;
}

function normalizeDependencyRecord(value: unknown): Record<string, string[]> | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;

  const normalized: Record<string, string[]> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, deps]) => {
    if (!Array.isArray(deps)) return;
    normalized[String(key)] = deps.map((dep) => String(dep));
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeDependencyGraph(value: unknown): Record<string, string[]> | null {
  if (!Array.isArray(value)) return null;

  const normalized: Record<string, string[]> = {};
  value.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const taskIdx = (entry as DependencyGraphEntry).task_idx;
    const deps = (entry as DependencyGraphEntry).depends_on;
    if (taskIdx === undefined || !Array.isArray(deps)) return;
    normalized[String(taskIdx)] = deps.map((dep) => String(dep));
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function dependenciesFromTasks(
  tasks: PlanTaskWithDeps[] | undefined,
): Record<string, string[]> | null {
  if (!tasks?.length) return null;

  const normalized: Record<string, string[]> = {};
  tasks.forEach((task, index) => {
    if (!Array.isArray(task.depends_on)) return;
    normalized[String(index)] = task.depends_on.map((dep) => String(dep));
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizePlanDependencies(
  planData: PlanDataShape | undefined,
): Record<string, string[]> | null {
  if (!planData) return null;

  return (
    normalizeDependencyRecord(planData.dependencies) ||
    normalizeDependencyGraph(planData.dependencies) ||
    normalizeDependencyGraph(planData.dependencies_graph) ||
    dependenciesFromTasks(planData.tasks) ||
    null
  );
}

export function PlanBubble({
  message,
  shouldType,
  onTypingComplete,
  planCharCount,
  planStreamStartedAtMs,
}: PlanBubbleProps) {
  const toolStatus = message.metadata?.toolStatus as
    | 'IN_PROGRESS'
    | 'FINISHED'
    | 'ERROR'
    | undefined;
  const planData = message.metadata?.data as PlanDataShape | undefined;

  // Unblock the animation queue for all terminal statuses.
  if (
    (toolStatus === 'FINISHED' || toolStatus === 'IN_PROGRESS' || toolStatus === 'ERROR') &&
    shouldType &&
    onTypingComplete
  ) {
    requestAnimationFrame(() => onTypingComplete());
  }

  if (toolStatus === 'ERROR') {
    return (
      <div className="flex gap-3 animate-in fade-in duration-300">
        <div className="flex-1">
          <PlanChip
            plan={{
              title: (message.metadata?.title as string) || 'Plan Failed',
              content: message.text || '',
              tasks: [],
              dependencies: null,
              join: 'all',
              status: 'error',
            }}
            toolStatus="ERROR"
          />
        </div>
      </div>
    );
  }

  const title = planData?.title || (message.metadata?.title as string) || 'Plan';
  const dependencies = normalizePlanDependencies(planData);

  return (
    <div className="flex gap-3 animate-in fade-in duration-300">
      <div className="flex-1">
        <PlanChip
          plan={{
            title,
            content: planData?.content || '',
            tasks: planData?.tasks || [],
            dependencies,
            join: planData?.join || 'all',
            status: planData?.status || 'planning',
          }}
          toolStatus={toolStatus}
          charCount={planCharCount}
          streamStartedAtMs={planStreamStartedAtMs}
        />
      </div>
    </div>
  );
}
