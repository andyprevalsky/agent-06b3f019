import { useMutation } from '@tanstack/react-query';
import {
  navigateBrowserSession,
  takeBrowserControl,
  type BrowserNavigationAction,
} from '@/lib/api/browser-session';

/** Commands are bound to the clicked task; a late result never changes another tab. */
export function useBrowserNavigation(taskId: string | null, pageUrl: string | null) {
  const mutation = useMutation({
    mutationFn: async (request: {
      taskId: string;
      action: BrowserNavigationAction;
      sourceUrl: string | null;
    }) => {
      await takeBrowserControl(request.taskId);
      window.dispatchEvent(
        new CustomEvent('rose-browser-control-changed', { detail: { taskId: request.taskId } }),
      );
      const result = await navigateBrowserSession(request.taskId, request.action);
      return { taskId: request.taskId, sourceUrl: request.sourceUrl, ...result };
    },
  });
  const current = mutation.variables?.taskId === taskId;
  return {
    navigate: (action: BrowserNavigationAction) => {
      if (taskId !== null && !mutation.isPending)
        mutation.mutate({ taskId, action, sourceUrl: pageUrl });
    },
    pending: mutation.isPending,
    url:
      mutation.data?.taskId === taskId && mutation.data.sourceUrl === pageUrl
        ? mutation.data.url
        : null,
    error: current && mutation.isError ? 'Couldn’t navigate. Try again.' : null,
  };
}
