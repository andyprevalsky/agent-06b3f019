import type { RecordingSegment } from './recordingSegments';

/** Numbered controls for every recording segment. Video segments advance on
 * their own; screenshot (HTML) parts cannot signal their end, so "Next part"
 * keeps the rest of the run one click away. */
export function RecordingSegmentStrip({
  segments,
  activeIndex,
  onSelect,
}: {
  segments: RecordingSegment[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const hasNext = activeIndex + 1 < segments.length;
  return (
    <div
      data-testid="recording-segments"
      className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <p>
        Now showing{' '}
        <span className="font-medium text-foreground">{segments[activeIndex]?.label}</span> (
        {activeIndex + 1} of {segments.length})
      </p>
      <div className="flex gap-1">
        {segments.map((segment, i) => (
          <button
            key={segment.key}
            type="button"
            aria-label={`Play recording part ${i + 1} of ${segments.length}`}
            aria-current={i === activeIndex ? 'step' : undefined}
            onClick={() => onSelect(i)}
            className={`min-w-6 rounded px-1.5 py-0.5 ${
              i === activeIndex
                ? 'bg-foreground/80 text-background'
                : 'bg-muted text-foreground hover:bg-foreground/20'
            }`}
          >
            {i + 1}
          </button>
        ))}
      </div>
      {hasNext && (
        <button
          type="button"
          onClick={() => onSelect(activeIndex + 1)}
          className="rounded bg-muted px-2 py-0.5 font-medium text-foreground hover:bg-foreground/20"
        >
          Next part ›
        </button>
      )}
    </div>
  );
}
