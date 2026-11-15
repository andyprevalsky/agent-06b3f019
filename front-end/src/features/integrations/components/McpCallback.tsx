/**
 * STATE MACHINE: McpCallback (route /integrations/mcp/callback)
 *
 *   [MOUNTED, reads ?code&state or ?error]
 *     |
 *     +--error / missing params--> [ERROR] --button--> back to Rose
 *     |
 *     +--code+state-------------> [COMPLETING] (POST /integrations/mcp/oauth/complete
 *                                   with this user's own session)
 *                                     |
 *                                     +--ok--> [DONE] --> back to the page that
 *                                     |                   started sign-in
 *                                     +--refused / not signed in--> [ERROR]
 *
 * The MCP server's OAuth sign-in redirects the browser here. Finishing requires
 * the Rose session of the user who started it.
 */

import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { useMcpCallback } from '../hooks/useMcpCallback';

export default function McpCallback(): JSX.Element {
  const { state, message } = useMcpCallback();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        {state === 'completing' && (
          <>
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Connecting MCP server…</p>
          </>
        )}
        {state === 'done' && (
          <p className="text-sm text-muted-foreground">MCP server connected. Redirecting…</p>
        )}
        {state === 'error' && (
          <>
            <h1 className="text-lg font-semibold">Couldn&apos;t connect the MCP server</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
            <Button onClick={() => window.location.replace('/')}>Back to Rose</Button>
          </>
        )}
      </div>
    </div>
  );
}
