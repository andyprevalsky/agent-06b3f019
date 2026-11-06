/**
 * STATE MACHINE: OpenAppButton (code-agent view, top right; UI ledger rows 10/39)
 *
 * Shown when the session's code_agent carries a cross-origin preview_url (dev cloud
 * sessions) and an AppViewProvider is mounted (Rose Desktop terminal); else null.
 *   [IDLE] --click--> openApp(task) → the full-screen app view for this session
 *
 * The chip frames no live preview (no handoff mint, no observer): only the
 * opened app view reads the preview. 10k agents: a chip costs nothing extra.
 */
import type { CodeAgentProvider } from '../../hooks/codeAgentContract';
import { isCrossOriginHttpUrl } from './appFrame';
import { useAppView } from './appViewState';

export function OpenAppButton({
  taskId,
  previewUrl,
  title,
  provider,
}: {
  taskId: string;
  previewUrl: string;
  title: string | null;
  provider: CodeAgentProvider;
}) {
  const appView = useAppView();
  if (appView === null || !isCrossOriginHttpUrl(previewUrl)) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        appView.openApp({ taskId, title, provider });
      }}
      className="whitespace-nowrap text-xs font-semibold text-[#e8507f] hover:underline"
    >
      Open app
    </button>
  );
}
