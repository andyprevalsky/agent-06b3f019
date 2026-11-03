"""Display domain - the ``display`` tool for root and sub-agents (plan row A5 / C12).

System context (docs/plans/active/rose-builds-rose.md, rows A5 and C12)::

    LLM calls display(paths | urls | html, caption?)
            │ handler.DisplayManager (workflow side) validates → service.build_request
            │ display_media_activity(payload)                                   [repo.py]
            │   POST /api/agent-tools/:agentId/display  (X-API-Key, X-User-Id)
            │   backend: fetch/sniff/store media once per content hash, then
            │     inline → ASSISTANT media rows in this agent's trajectory (dedupe by hash)
            ▼
    FINISHED tool result "Displayed N item(s)"

display never asks a question: placement "pinned" / options / allow_other are
refused here and by the backend.

Code agents reach the same backend route from their sandbox through the
``rose`` CLI / MCP server (back-end/src/assets/rose-tools/rose.cjs).
"""
