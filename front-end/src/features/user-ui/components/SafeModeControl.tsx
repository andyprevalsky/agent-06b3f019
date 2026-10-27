/**
 * STATE MACHINE: SafeModeControl
 *
 *   no active user UI, not in safe mode → hidden
 *   shell active (not safe)             → "Safe mode" button (enters safe mode)
 *   safe mode with a published UI       → "Exit safe mode" button
 *   inline views only (not safe)        → hidden (Cmd/Ctrl+Shift+. still works)
 *
 * Host DOM at the maximum z-index, outside every sandboxed frame: a shell
 * covering the viewport cannot draw over it or swallow its clicks.
 */
import { useUserUi } from '../hooks';

export function SafeModeControl() {
  const { active, safeMode, setSafeMode, shellUrl } = useUserUi();
  const visible = safeMode ? active !== null : shellUrl !== null;
  if (!visible) return null;
  return (
    <button
      type="button"
      data-testid="user-ui-safe-mode-control"
      onClick={() => setSafeMode(!safeMode)}
      className="fixed bottom-3 right-3 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-900 shadow-md"
      style={{ zIndex: 2147483647 }}
      title="Cmd/Ctrl + Shift + ."
    >
      {safeMode ? 'Exit safe mode' : 'Safe mode'}
    </button>
  );
}
