/**
 * STATE MACHINE: ConnectedLabel
 *
 * [MOUNTED] --> renders the rose-gradient "Connected" text (pure, stateless).
 *
 * System context:
 *   The single source of the connected-state wording and rose gradient, shared by
 *   SectionToggleButton (section headers) and SyncItemButton (rows inside an
 *   expanded section). Both surfaces render the same treatment so a connected row
 *   can never silently lose the label while its header keeps it.
 *
 * Rows sit on a denser line than section headers, so `size` trims the type scale
 * without forking the gradient.
 */

interface ConnectedLabelProps {
  /** `section` for section headers, `row` for the denser rows inside a section. */
  size?: 'section' | 'row';
}

const ROSE_GRADIENT_TEXT =
  'bg-gradient-to-bl from-[#FE7503] via-[#FD5776] to-[#7A6BEC] bg-clip-text font-medium text-transparent';

export default function ConnectedLabel({ size = 'section' }: ConnectedLabelProps) {
  return (
    <span className={`${ROSE_GRADIENT_TEXT} ${size === 'row' ? 'text-[11px]' : 'text-xs'}`}>
      Connected
    </span>
  );
}
