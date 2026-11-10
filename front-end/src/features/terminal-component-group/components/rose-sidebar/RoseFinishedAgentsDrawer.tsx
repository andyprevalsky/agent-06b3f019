/**
 * STATE MACHINE: one owner's inactive children, alongside its running children.
 * [HIDDEN: count=0] -> [COLLAPSED: Finished agents (count)]
 * [COLLAPSED] --click--> [EXPANDED: existing rows at the same depth] --click--> [COLLAPSED]
 * Resumed children leave the drawer; collapse of the owner's branch resets it.
 * Closed drawers do not mount rows or create subscriptions.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export default function RoseFinishedAgentsDrawer({
  count,
  depth,
  indented,
  renderChildren,
}: {
  count: number;
  depth: number;
  indented: boolean;
  renderChildren: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const contentsId = useId();
  if (count === 0) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentsId}
        onClick={() => setOpen((value) => !value)}
        style={{ paddingLeft: 22 + (indented ? 12 : 0) + depth * 16 }}
        className="flex h-[30px] w-full items-center gap-3 pr-4 text-left text-[13px] text-muted-foreground hover:text-foreground"
      >
        <span className="inline-grid h-5 w-5 flex-none place-items-center">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="truncate">Finished agents ({count})</span>
      </button>
      <div id={contentsId} hidden={!open}>
        {open && renderChildren()}
      </div>
    </div>
  );
}
