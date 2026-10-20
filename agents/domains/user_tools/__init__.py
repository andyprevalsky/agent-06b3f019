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
            │   run_user_tool_activity(agent_id, user_id, version_id, name, input, base_url, spec)
            │     download handler files for the pinned version (worker disk cache by version)
            │     subprocess (node|python), temp cwd, minimal env, timeout, 256KB stdout cap
            │     validate input/output against JSON Schema
            ▼
    TOOL message (FINISHED | ERROR); metadata.inlineView = {view, versionId, props} when render.view set

v1 limits: executor ``local`` only (worker subprocess, disabled on Fly unless
``USER_TOOLS_EXECUTOR=local``); ``side_effects: true`` tools are rejected because no
backend idempotency record exists yet; sub-agents never get user tools.
"""
