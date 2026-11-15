# MCP server integrations

Users connect remote MCP servers on the Integrations page. Their agents get the
servers' tools in every later run. Authenticated servers sign in with OAuth or
use an API-key header. The CLIs section (for example the Y Combinator `yc` CLI)
keeps its setup-agent flow and is restyled to match the other integrations.

```
Integrations page (web + desktop)
  ├─ CLIs        "e.g. YC CLI" ─► POST /api/integrations/cli ─► setup agent ─► per-user template
  └─ MCP servers URL [+ header] ─► POST /api/integrations/mcp
                                     │ probe (Streamable HTTP, public hosts only)
                                     ├─ 200 ─► Integration{name:'mcp', CONNECTED, tools cached}
                                     └─ 401 ─► OAuth (RFC 9728/8414/7591 + PKCE) ─► authorize_url
                                               browser ─► /integrations/mcp/callback
                                               ─► POST /api/integrations/mcp/oauth/complete ─► CONNECTED
Every code-agent run (Claude Code / Codex)
  ~/.rose/bin/rose mcp (stdio, written fresh at session start)
    tools/list ─► GET  /api/agent-tools/:agent/mcp              (connected servers + schemas)
    tools/call ─► POST /api/agent-tools/:agent/mcp/:id/call ─► backend ─► remote MCP server
                  (headers / OAuth tokens stay server-side; refresh under a row lock)
```

Persistence: the servers live in the user's Integration rows, and CLIs live in
the user's template. A new agent run reads both again, so nothing depends on the
run that added them.

## Verification

- Backend blackbox `mcp-servers.blackbox.ts`:
  - no-auth connect, header auth, OAuth connect;
  - agent list and call;
  - token refresh;
  - SSRF refusal;
  - owner isolation.
- rose CLI MCP proxy case (tools/list + tools/call against the agent routes).
- Front-end blackbox for the MCP section, the OAuth callback and the restyled CLIs section.
- Live:
  - connect Context7 (`https://mcp.context7.com/mcp`, no auth) and Context7 OAuth
    (`https://mcp.context7.com/mcp/oauth`);
  - two separate code-agent runs call `context7__resolve-library-id`;
  - the `yc` CLI is added through the CLIs section and is visible in a later run.
