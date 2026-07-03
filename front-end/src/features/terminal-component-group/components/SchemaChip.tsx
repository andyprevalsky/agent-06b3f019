/**
 * SchemaChip — hover-activated chip that displays an output schema via portal tooltip.
 *
 * STATE MACHINE:
 * [IDLE] --> isHovered: false, tooltipStyle: {}
 *     |
 *     | (onMouseEnter → measure trigger rect → compute tooltip style)
 *     v
 * [SHOWING] --> isHovered: true, tooltip rendered via createPortal
 *     |
 *     | (onMouseLeave)
 *     v
 * [IDLE]
 */

import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { FileJson } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type ResponseSchemaField } from '../hooks';
import { formatFieldType } from './claudeCodeChip.utils';

const TOOLTIP_WIDTH = 256;
const TOOLTIP_GAP = 8;

interface SchemaChipProps {
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  /** Populated values keyed by field name (shown next to each field on success). */
  values?: Record<string, unknown> | null;
  size?: 'sm' | 'md';
  tooltipPosition?: 'top' | 'bottom';
}

function computeTooltipStyle(rect: DOMRect, tooltipPosition: 'top' | 'bottom'): CSSProperties {
  const style: CSSProperties = {
    position: 'fixed',
    width: TOOLTIP_WIDTH,
    zIndex: 9999,
  };
  if (tooltipPosition === 'top') {
    style.top = rect.bottom + TOOLTIP_GAP;
    style.left = rect.left;
  } else {
    style.bottom = window.innerHeight - rect.top + TOOLTIP_GAP;
    style.right = window.innerWidth - rect.right;
  }
  return style;
}

function SchemaTooltip({
  style,
  fields,
  values,
}: {
  style: CSSProperties;
  fields: ResponseSchemaField[] | undefined;
  values?: Record<string, unknown> | null;
}) {
  const hasSchema = fields && fields.length > 0;
  const hasValues = !!values && Object.keys(values).length > 0;
  return createPortal(
    <div style={style} className="pointer-events-none">
      <div
        className="rounded-lg border border-border p-3 shadow-lg bg-background/80"
        style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          {hasValues ? 'Output Schema · Result' : 'Output Schema'}
        </div>
        {hasSchema ? (
          <div className="space-y-1.5 max-h-[340px] overflow-y-auto">
            {fields.map((field, idx) => {
              const hasValue = hasValues && values != null && field.name in values;
              const value = hasValue ? values![field.name] : undefined;
              return (
                <div key={idx} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <code className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]">
                      {field.name}
                    </code>
                    <span className="text-muted-foreground text-[10px]">
                      {formatFieldType(field.type)}
                    </span>
                  </div>
                  {field.description && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 pl-0.5">
                      {field.description}
                    </p>
                  )}
                  {hasValue && (
                    <p className="mt-0.5 pl-0.5 text-[10px] break-words">
                      <span className="text-emerald-500">→ </span>
                      <span className="font-mono text-foreground">
                        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No schema defined</p>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function SchemaChip({
  outputSchema,
  values,
  size = 'sm',
  tooltipPosition = 'bottom',
}: SchemaChipProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);

  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const padding = size === 'sm' ? 'p-1' : 'p-1.5';
  const hasSchema = !!outputSchema?.fields && outputSchema.fields.length > 0;

  const handleMouseEnter = useCallback(() => {
    if (triggerRef.current) {
      setTooltipStyle(
        computeTooltipStyle(triggerRef.current.getBoundingClientRect(), tooltipPosition),
      );
    }
    setIsHovered(true);
  }, [tooltipPosition]);

  const handleMouseLeave = useCallback(() => setIsHovered(false), []);

  return (
    <>
      <div
        ref={triggerRef}
        data-testid="schema-chip"
        className="relative flex-shrink-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className={cn(padding, 'rounded hover:bg-muted transition-colors cursor-default')}
        >
          <FileJson
            className={cn(
              iconSize,
              hasSchema ? 'text-muted-foreground' : 'text-muted-foreground/50',
            )}
          />
        </div>
      </div>
      {isHovered && (
        <SchemaTooltip style={tooltipStyle} fields={outputSchema?.fields} values={values} />
      )}
    </>
  );
}
