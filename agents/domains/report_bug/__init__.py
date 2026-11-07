"""report_bug domain — the root agent files a Rose bug like the user's Report Bug button.

    LLM (root agent only) calls report_bug(description)
            │ handler.report_bug (workflow side): root + admin owner + real world
            │ report_bug_activity(agent_id, user_id, description, record_only)   [service.py]
            │   record_only = not on production Temporal (namespace + queue)
            │   POST /api/agents/:agentId/report-bug/by-agent  (X-API-Key, X-User-Id) [repo.py]
            │   backend: one frozen claim per run; production + not record_only + not benchmark
            │     → boxes.dev Bug Report automation (`--ai--` thread, /goal … /deploy + /rca)
            │     otherwise saved (RECORDED) for /rca: GET …/report-bug/by-agent
            ▼
    FINISHED "Bug report filed/saved …" (metadata keeps the description) | ERROR

The tool is exposed only by ``with_report_bug``; the backend re-checks every gate.
"""
