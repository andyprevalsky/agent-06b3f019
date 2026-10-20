"""Inspect-code domain: explore's read-only look inside a code agent's workspace.

    explore ── inspect_code(code_session_id, question)
      └─ inspect_code_activity ── POST /api/claude-code-session/code-sessions/:id/inspect
           backend: newest verified checkpoint → throwaway sandbox → read-only CLI
           → answer + verified file:line citations (the live session is untouched)
"""
