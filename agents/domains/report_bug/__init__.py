"""report_bug domain — the root agent files a Rose bug like the user's Report Bug button.

    LLM (root agent only) calls report_bug(description)
            │ handler.report_bug (workflow side): production Temporal + root + admin owner + real world
            │ report_bug_activity(agent_id, user_id, description)          [service.py]
            │   POST /api/agents/:agentId/report-bug/by-agent  (X-API-Key, X-User-Id) [repo.py]
            │   backend: one frozen claim per run → boxes.dev Bug Report automation
            │     (`--ai--` thread, /goal … /deploy + /rca [agentId] + description)
            ▼
    FINISHED "Bug report filed …" | ERROR with the backend's reason

The tool is exposed only by ``with_report_bug``; the backend re-checks every gate.
"""
