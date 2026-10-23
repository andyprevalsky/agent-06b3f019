"""Display domain - the ``display`` tool for root and sub-agents (plan row A5 / C12).

System context (docs/plans/active/rose-builds-rose.md, rows A5 and C12)::

    LLM calls display(paths | urls, caption?, placement?, options?, allow_other?)
            │ handler.DisplayManager (workflow side) validates → service.build_request
            │ display_media_activity(payload)                                   [repo.py]
            │   POST /api/agent-tools/:agentId/display  (X-API-Key, X-User-Id)
            │   backend: fetch/sniff/store media once per content hash, then
            │     inline  → ASSISTANT media rows in this agent's trajectory (dedupe by hash)
            │     pinned  → attention row + route: user (pin) | parent (A2A message)
            ▼
    inline: FINISHED tool result "Displayed N item(s)"
    pinned: IN_PROGRESS row carrying the backend-built pin metadata, then wait on
            receive_user_response(request_id) — the user (or the parent agent)
            answers through POST /api/attention-requests/:id/respond — then
            FINISHED with the answer as the tool result.

Code agents reach the same backend route from their sandbox through the
``rose`` CLI / MCP server (back-end/src/assets/rose-tools/rose.cjs).
"""
