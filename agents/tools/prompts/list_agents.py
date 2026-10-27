"""Prompt for list_agents tool."""

PROMPT = """Browses your agent tree like a table of contents. The result starts with where you are (your path from /root), marks your own line `▶ ... [YOU ARE HERE]`, and lists nearby agents and running background tasks by address, with their relationship to you, type, status and goal.

Large trees are collapsed: a line like `(12 children, 3 active) → list_agents(node="/root/outreach")` or `… more children not shown → list_agents(node=..., cursor=...)` tells you exactly what to call to look deeper. Use `query` to search goals, or `path_prefix` to list one subtree. To read what an agent has done, grep(sources=["agent_network"], trace_path="<its address>")."""
