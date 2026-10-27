/**
 * STATE MACHINE: PinnedTools (stateless layout, Rose Desktop only)
 *
 * The two controls the Rose Desktop query box keeps from the old in-box
 * toolbar row (UI ledger row 75), pinned top-left inside the box and always
 * visible (no reveal state):
 *
 *   [RoseToolSetChip (wrench)] [SimulatorToggle]  <-- showSimulator (admin)
 *   [RoseToolSetChip (wrench)]                    <-- !showSimulator
 *
 * Each control owns its own state (tool-list popover open/closed, simulator
 * OFF <-> ON). Both keep their exact stock styling and look identical in
 * light and dark mode: the chip's theme border is fixed to its light value and
 * neither control has dark: variants. Everything else from the old row lives
 * on the nub tab (NubToolbar).
 */

import RoseToolSetChip from '../RoseToolSetChip';
import SimulatorToggle from '../SimulatorToggle';
import type { TopBarProps } from './TopBar';

export function PinnedTools({
  showSimulator = false,
  simulatorMode = false,
  onSimulatorModeChange,
}: Pick<TopBarProps, 'showSimulator' | 'simulatorMode' | 'onSimulatorModeChange'>) {
  return (
    <div data-testid="query-pinned-tools" className="flex items-center justify-start gap-2 px-3">
      <RoseToolSetChip variant="pinned" />
      {showSimulator && (
        <SimulatorToggle enabled={simulatorMode} onChange={onSimulatorModeChange ?? (() => {})} />
      )}
    </div>
  );
}
