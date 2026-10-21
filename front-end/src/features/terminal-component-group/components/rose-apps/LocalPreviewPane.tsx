/** Only the open Local mode reads readiness; no allocations, polling or paused-session wake. */
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RotateCw } from 'lucide-react';
import {
  fetchRootPreview,
  matchesRootPreview,
  rootPreviewPath,
  type RootPreviewView,
} from '@/lib/api/rootPreview';
import { CodePreviewApiError } from '@/lib/api/codePreview';
import { PREVIEW_FRAME_SANDBOX, isCrossOriginHttpUrl } from '../app-view/appFrame';
import { usePreviewFrameSrc } from '../app-view/useAppPreview';

function PreviewFrame({ view }: { view: RootPreviewView }) {
  const enabled =
    view.status === 'running' && !!view.task_id && isCrossOriginHttpUrl(view.preview_url);
  const frame = usePreviewFrameSrc(view.task_id ?? '', enabled);
  if (view.status === 'paused')
    return <p>Local preview is paused. Resume the code session to view it.</p>;
  if (!enabled) return <p>No running local preview yet for this root agent.</p>;
  if (frame.kind === 'hidden') return <p>Sign in with your main account to open this preview.</p>;
  if (frame.kind === 'error') return <p role="alert">Could not open the local preview.</p>;
  if (frame.kind !== 'ready') return <p>Opening local preview…</p>;
  if (!matchesRootPreview(view.preview_url, frame.src))
    return <p role="alert">Local preview changed. Refresh to load the current root workspace.</p>;
  return (
    <iframe
      title="Local root preview"
      data-testid="local-root-preview-frame"
      src={frame.src}
      sandbox={PREVIEW_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}

export function LocalPreviewPane({ agentId }: { agentId: string | null }) {
  const query = useQuery({
    queryKey: ['root-local-preview', agentId],
    queryFn: () => fetchRootPreview(agentId ?? ''),
    enabled: agentId !== null,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  // Never retain a previous agent's preview while a new request is in flight.
  const view = query.data?.agent_id === agentId ? query.data : undefined;
  if (agentId === null) {
    return (
      <section aria-label="Local code preview" className="p-4 text-sm text-muted-foreground">
        <p>Select an agent to view its local code preview.</p>
      </section>
    );
  }
  return (
    <section
      aria-label="Local code preview"
      className="flex min-h-0 flex-1 flex-col gap-3 p-4 text-sm text-muted-foreground"
    >
      <div className="flex flex-none items-center justify-between gap-3">
        <span>Root agent workspace</span>
        <div className="flex items-center gap-3">
          {view && (
            <a
              href={rootPreviewPath(view.root_agent_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-foreground"
            >
              Stable link <ExternalLink size={14} />
            </a>
          )}
          <button
            type="button"
            aria-label="Refresh local preview"
            onClick={() => void query.refetch()}
          >
            <RotateCw size={15} />
          </button>
        </div>
      </div>
      {query.isPending ? (
        <p>Loading local preview…</p>
      ) : query.isError ? (
        <p role="alert">
          {query.error instanceof CodePreviewApiError && query.error.status === 403
            ? 'Local preview is not available for this account.'
            : 'Could not load the local preview.'}
        </p>
      ) : view ? (
        <PreviewFrame
          key={`${agentId}:${view.code_session_id}:${view.task_id}:${query.dataUpdatedAt}`}
          view={view}
        />
      ) : null}
    </section>
  );
}
