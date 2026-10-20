"""User tools domain - tools a user's code agent authored in ``rose_user_ui/tools/<name>/``.

System context (docs/plans/active/rose-user-ui.md, "User tools")::

    code agent writes tools/<t>/tool.json + handler → publish (backend /api/user-ui, W1)
            │
    AgentWorkflow.run (root agent, depth 0, real world mode)
            │ resolve_user_tools_activity(agent_id, user_id)           [repo.py]
            │   GET /api/user-ui/active → {versionId, manifest, baseUrl}
            │   GET {baseUrl}tools/<t>/tool.json  → normalize (types.py)
            ▼
    self.user_tools = {version_id, base_url, tools:[spec...]}   ← pinned for the run,
            │                                                     carried across continue_as_new
            │ run_agent(user_tools=...) → native tool decl ``user__<t>`` (sorted, after built-ins)
            ▼
    LLM calls user__<t>(input)
            │ handler.run_user_tool (workflow side)
            │   side_effects: key = sha256(root workflow id, tool call id)
            │   run_user_tool_activity(agent_id, user_id, version_id, name, input, base_url, spec[, key])
            │     validate input against JSON Schema
            │     side_effects: claim key  (backend ToolSideEffect, /api/user-ui/tool-calls)
            │     executor USER_TOOLS_EXECUTOR:
            │       code_session  POST /api/user-ui/tools/run → handler runs in the user's own
            │                     persistent code session sandbox (resumed/leased, W5b)
            │       local         worker subprocess (dev default off Fly)
            │     per-call timeout, 256KB stdout cap, minimal env (no secrets)
            │     side_effects: store the run record before returning (retry → replay)
            │     validate output against JSON Schema
            ▼
    TOOL message (FINISHED | ERROR); metadata.inlineView = {view, versionId, props} when render.view set

Limits: on Fly the executor must be explicit (``code_session`` in production);
sub-agents never get user tools.
"""
