/**
 * STATE MACHINE: ExploreActiveToolCarousel
 *
 * INPUT:
 *   items contains active in-progress explore tool calls plus, when present,
 *   a stream metrics item with elapsed time and a live token count.
 *
 * TRANSITION:
 *   New tool call:
 *     first IN_PROGRESS for call_id A -> [TOOL A]
 *     first IN_PROGRESS for call_id B -> debounce to max 1 transition/1.8s -> [TOOL B]
 *
 *   Parallel active tools:
 *     [TOOL A] --1.8s--> [TOOL B] --1.8s--> [TOOL C]
 *     Each canonical item displays at most once; after the last unseen item,
 *     the carousel holds until a new tool or thinking item arrives.
 *
 *   Tool completion:
 *     FINISHED for non-last call_id -> no immediate transition
 *     FINISHED for last active call_id -> immediate [0.0s · ↓ 0 tokens]
 *
 * OUTPUT:
 *   Stable-height inline row:
 *     tool item     → [active tool icon] {active tool title}
 *     thinking item → X.Ys · [down arrow] {spring count} tokens
 */

import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from 'framer-motion';
import { ArrowDown, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ExploreActiveToolCarouselItem {
  key: string;
  text?: string;
  icon?: LucideIcon | null;
  kind?: 'tool' | 'thinking';
  tokenCount?: number;
  startedAtMs?: number;
  pauseMs?: number;
}

const DEFAULT_ROTATION_PAUSE_MS = 1800;
const MIN_TRANSITION_INTERVAL_MS = DEFAULT_ROTATION_PAUSE_MS;

interface ExploreActiveToolCarouselProps {
  items: ExploreActiveToolCarouselItem[];
  iconClassName: string;
  textClassName?: string;
  className?: string;
  pauseMs?: number;
}

function useSpringCounter(targetValue: number, initialValue = targetValue) {
  const [displayValue, setDisplayValue] = useState(initialValue);
  const motionValue = useMotionValue(initialValue);

  useEffect(() => {
    const controls = animate(motionValue, targetValue, {
      type: 'spring',
      stiffness: 170,
      damping: 24,
      mass: 0.55,
      onUpdate: (latest) => setDisplayValue(Math.round(latest)),
    });

    return () => controls.stop();
  }, [motionValue, targetValue]);

  return displayValue;
}

function useElapsedSeconds(startedAtMs?: number) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAtMs) return undefined;

    const interval = window.setInterval(() => setNowMs(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [startedAtMs]);

  if (!startedAtMs) return 0;
  return Math.max(0, (nowMs - startedAtMs) / 1000);
}

function CarouselItemContent({
  item,
  iconClassName,
  textClassName,
  displayStartedAtMs,
  resetCountFromZero,
}: {
  item: ExploreActiveToolCarouselItem;
  iconClassName: string;
  textClassName?: string;
  displayStartedAtMs?: number;
  resetCountFromZero?: boolean;
}) {
  const Icon = item.icon;
  const animatedTokenCount = useSpringCounter(
    item.tokenCount || 0,
    resetCountFromZero ? 0 : undefined,
  );
  const elapsedSeconds = useElapsedSeconds(displayStartedAtMs ?? item.startedAtMs);

  if (item.kind === 'thinking') {
    return (
      <span
        className={cn(
          'flex flex-shrink-0 items-center tabular-nums text-muted-foreground/55',
          textClassName,
        )}
      >
        {elapsedSeconds.toFixed(1)}s<span className="mx-1 text-muted-foreground/35">·</span>
        <ArrowDown
          aria-hidden="true"
          className="mr-0.5 h-2.5 w-2.5 flex-shrink-0 text-muted-foreground/35"
        />
        {animatedTokenCount.toLocaleString()} tokens
      </span>
    );
  }

  return (
    <>
      {Icon && (
        <Icon
          data-testid="explore-active-tool-icon"
          className={cn('flex-shrink-0', iconClassName)}
        />
      )}
      <span className={cn('truncate', textClassName)}>{item.text}</span>
    </>
  );
}

function getCarouselItemIdentity(item: ExploreActiveToolCarouselItem): string {
  if (item.kind === 'thinking') return 'thinking';
  const text = item.text?.replace(/\s+/g, ' ').trim();
  return text ? `tool:${text}` : `key:${item.key}`;
}

function dedupeCarouselItems(
  items: ExploreActiveToolCarouselItem[],
): ExploreActiveToolCarouselItem[] {
  const orderedIdentities: string[] = [];
  const byIdentity = new Map<string, ExploreActiveToolCarouselItem>();

  items.forEach((item) => {
    const identity = getCarouselItemIdentity(item);
    if (!byIdentity.has(identity)) orderedIdentities.push(identity);
    byIdentity.set(identity, { ...item, key: identity });
  });

  return orderedIdentities
    .map((identity) => byIdentity.get(identity))
    .filter((item): item is ExploreActiveToolCarouselItem => item !== undefined);
}

export function ExploreActiveToolCarousel({
  items,
  iconClassName,
  textClassName,
  className,
  pauseMs = DEFAULT_ROTATION_PAUSE_MS,
}: ExploreActiveToolCarouselProps) {
  const reduceMotion = useReducedMotion();
  const displayItems = useMemo(() => dedupeCarouselItems(items), [items]);
  const [activeKey, setActiveKey] = useState<string | null>(() => displayItems[0]?.key ?? null);
  const shownKeysRef = useRef<Set<string>>(new Set(activeKey ? [activeKey] : []));
  const itemSetKey = useMemo(() => displayItems.map((item) => item.key).join('|'), [displayItems]);
  const itemByKey = useMemo(
    () => new Map(displayItems.map((item) => [item.key, item])),
    [displayItems],
  );
  const activeKeyRef = useRef<string | null>(activeKey);
  const displayItemsRef = useRef(displayItems);
  const itemByKeyRef = useRef(itemByKey);
  const lastItemByKeyRef = useRef<Map<string, ExploreActiveToolCarouselItem>>(new Map());
  const previousKeysRef = useRef<Set<string>>(new Set(displayItems.map((item) => item.key)));
  const lastTransitionAtRef = useRef(Date.now());
  const pendingTransitionRef = useRef<number | null>(null);
  const rotationTimeoutRef = useRef<number | null>(null);
  const [thinkingDisplayStartedAtMs, setThinkingDisplayStartedAtMs] = useState<number | undefined>(
    () => (displayItems[0]?.kind === 'thinking' ? Date.now() : undefined),
  );
  const [thinkingResetKey, setThinkingResetKey] = useState(0);
  const current =
    (activeKey ? itemByKey.get(activeKey) || lastItemByKeyRef.current.get(activeKey) : undefined) ||
    displayItems[0];
  const currentKey = current?.key;
  const currentPauseMs = current?.pauseMs ?? pauseMs;

  displayItemsRef.current = displayItems;
  itemByKeyRef.current = itemByKey;
  activeKeyRef.current = activeKey;

  const getKnownItem = useCallback(
    (key: string) => itemByKeyRef.current.get(key) || lastItemByKeyRef.current.get(key),
    [],
  );

  const transitionTo = useCallback(
    (nextKey: string) => {
      const previousKey = activeKeyRef.current;
      if (previousKey === nextKey) return;

      const nextItem = getKnownItem(nextKey);
      const previousItem = previousKey ? getKnownItem(previousKey) : undefined;

      lastTransitionAtRef.current = Date.now();
      if (nextItem?.kind === 'thinking' && previousItem?.kind !== 'thinking') {
        setThinkingDisplayStartedAtMs(Date.now());
        setThinkingResetKey((key) => key + 1);
      }
      shownKeysRef.current.add(nextKey);
      activeKeyRef.current = nextKey;
      setActiveKey(nextKey);
    },
    [getKnownItem],
  );

  const scheduleDebouncedTransition = useCallback(
    (nextKey: string) => {
      if (activeKeyRef.current === nextKey) return;

      if (pendingTransitionRef.current) {
        window.clearTimeout(pendingTransitionRef.current);
        pendingTransitionRef.current = null;
      }
      if (rotationTimeoutRef.current) {
        window.clearTimeout(rotationTimeoutRef.current);
        rotationTimeoutRef.current = null;
      }

      const elapsedMs = Date.now() - lastTransitionAtRef.current;
      const waitMs = Math.max(0, MIN_TRANSITION_INTERVAL_MS - elapsedMs);
      pendingTransitionRef.current = window.setTimeout(() => {
        pendingTransitionRef.current = null;
        transitionTo(nextKey);
      }, waitMs);
    },
    [transitionTo],
  );

  useEffect(() => {
    const previousKeys = previousKeysRef.current;
    const latestItems = displayItemsRef.current;
    const nextKeys = new Set(latestItems.map((item) => item.key));
    const thinkingItem = latestItems.find((item) => item.kind === 'thinking');
    const toolItems = latestItems.filter((item) => item.kind !== 'thinking');
    const firstUnshownItem = latestItems.find((item) => !shownKeysRef.current.has(item.key));
    const newTool = toolItems.find(
      (item) => !previousKeys.has(item.key) && !shownKeysRef.current.has(item.key),
    );
    const active = activeKeyRef.current;

    if (latestItems.length === 0) {
      activeKeyRef.current = null;
      shownKeysRef.current.clear();
      setActiveKey(null);
    } else if (toolItems.length === 0 && thinkingItem) {
      transitionTo(thinkingItem.key);
    } else if (!active) {
      transitionTo(firstUnshownItem?.key ?? latestItems[0].key);
    } else if (newTool) {
      scheduleDebouncedTransition(newTool.key);
    } else if (!nextKeys.has(active)) {
      const nextUnshown = latestItems.find((item) => !shownKeysRef.current.has(item.key));
      if (nextUnshown) transitionTo(nextUnshown.key);
    }

    lastItemByKeyRef.current = new Map(latestItems.map((item) => [item.key, item]));
    previousKeysRef.current = nextKeys;

    return undefined;
  }, [itemSetKey, scheduleDebouncedTransition, transitionTo]);

  useEffect(() => {
    if (displayItems.length <= 1 || !currentKey) return undefined;

    rotationTimeoutRef.current = window.setTimeout(() => {
      rotationTimeoutRef.current = null;
      const latestItems = displayItemsRef.current;
      const latestCurrentKey = activeKeyRef.current;
      const currentIndex = latestItems.findIndex((item) => item.key === latestCurrentKey);
      const searchStart = currentIndex >= 0 ? currentIndex + 1 : 0;
      const next = latestItems
        .slice(searchStart)
        .find((item) => !shownKeysRef.current.has(item.key));
      if (next) transitionTo(next.key);
    }, currentPauseMs);

    return () => {
      if (rotationTimeoutRef.current) {
        window.clearTimeout(rotationTimeoutRef.current);
        rotationTimeoutRef.current = null;
      }
    };
  }, [currentKey, currentPauseMs, displayItems.length, itemSetKey, transitionTo]);

  useEffect(() => {
    return () => {
      if (pendingTransitionRef.current) {
        window.clearTimeout(pendingTransitionRef.current);
      }
      if (rotationTimeoutRef.current) {
        window.clearTimeout(rotationTimeoutRef.current);
      }
    };
  }, []);

  if (!current) return null;

  return (
    <span className={cn('relative flex min-w-0 flex-1 items-center overflow-hidden', className)}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={current.kind === 'thinking' ? `${current.key}:${thinkingResetKey}` : current.key}
          className="flex min-w-0 items-center"
          initial={reduceMotion ? { opacity: 1 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
          transition={{ duration: 0.34, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <CarouselItemContent
            item={current}
            iconClassName={iconClassName}
            textClassName={textClassName}
            displayStartedAtMs={
              current.kind === 'thinking' ? thinkingDisplayStartedAtMs : undefined
            }
            resetCountFromZero={current.kind === 'thinking'}
          />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
