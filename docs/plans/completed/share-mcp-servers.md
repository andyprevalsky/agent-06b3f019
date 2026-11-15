# Share MCP servers with teams

This closes the gap left by the share-all-integrations goal (Andy, 2026-11-15): "make sure all are shareable except for iPhone, browser cookies, passwords, and Pebble Index 01". MCP servers (PR #2130) are a connectable Integrations row, but `SHAREABLE_PROVIDERS` did not list them. See [the share-all-integrations plan](share-all-integrations.md).

Shipped in PR #2259. `team-daily-shared-mcp` passed as a REAL run on the cloud fleet (run 20261115-225038-502015).

## System fit

```
Owner's Integrations page ── MCP server row ── "Share" caption ──PUT /api/teams/:id/integrations/:integrationId
                                                                  TeamIntegrationShare {provider 'mcp', accountId = server URL}

Teammate's code agent (Claude Code / Codex)
  ~/.rose/bin/rose mcp (stdio)
    tools/list ─► GET  /api/agent-tools/:agent/mcp
                    own CONNECTED servers + servers teammates currently share (resolveTeamDataAccess)
                    shared slugs never collide with the reader's own
    tools/call ─► POST /api/agent-tools/:agent/mcp/:integrationId/call
                    own row, else a live 'mcp' grant for that exact integration
                    ─► backend opens the session with the OWNER's headers / OAuth token
                       (refresh under the owner's row lock); nothing leaves the backend
```

Unsharing, disconnecting, a removed server, an invited-only reader or an owner leaving the team ends access on the next list or call. Reads stay per agent: one grant query and one indexed read, with no polling and no fan-in.

## Verification

- Backend blackbox (`mcp-servers.blackbox.ts`, team case):
  - the owner shares a server;
  - the teammate's agent lists it and calls a tool, and the owner's header reaches the remote server;
  - the secret is never returned;
  - unsharing ends both list and call;
  - an outsider is refused.
- `teams-shareable-providers` lists `mcp`.
- Front-end: the MCP row shows the Share caption.
- Real agent run: the cloud-fleet task `team-daily-shared-mcp` has a teammate's code agent call a team-shared Context7 server.
