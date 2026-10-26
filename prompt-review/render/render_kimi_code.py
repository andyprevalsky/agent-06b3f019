#!/usr/bin/env python3
"""Render Kimi Code CLI (MoonshotAI/kimi-code) prompts to
prompt-review/rendered/kimi-code/<id>.txt.

Kimi Code keeps every system prompt, overlay, injected reminder and tool
description as a markdown file imported with Vite's `?raw` suffix (template
variables stay as `${name}` placeholders). This renderer copies those files
verbatim.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
KIMI = ROOT / "kimi-code"
OUT = ROOT / "prompt-review" / "rendered" / "kimi-code"

SRC = "packages/agent-core-v2/src"

# (id, relative path under kimi-code/)
MARKDOWN_SPECS: list[tuple[str, str]] = [
    ("kimi_system_prompt", f"{SRC}/app/agentProfileCatalog/system.md"),
    ("kimi_explore_overlay", f"{SRC}/session/agentLifecycle/profile/explore-overlay.md"),
    ("kimi_tower_worker_overlay", f"{SRC}/features/tower/tower-worker-overlay.md"),
    ("kimi_session_init", f"{SRC}/features/sessionInit/profile/init.md"),
    ("kimi_compaction_instruction", f"{SRC}/agent/fullCompaction/compaction-instruction.md"),
    ("kimi_context_recovery_footer", f"{SRC}/agent/fullCompaction/context-recovery-footer.md"),
    ("kimi_plan_mode_full_reminder", f"{SRC}/features/plan/injection/plan-mode-full-reminder.md"),
    ("kimi_goal_active_reminder", f"{SRC}/features/goal/injection/goal-active-reminder.md"),
    ("kimi_tool_agent", f"{SRC}/agent/tools/agent/agent.md"),
    ("kimi_tool_agent_swarm", f"{SRC}/features/swarm/tools/agent-swarm/agent-swarm.md"),
    ("kimi_tool_task_wait", f"{SRC}/agent/tools/task/task-wait/task-wait.md"),
    ("kimi_tool_bash", f"{SRC}/agent/tools/os/bash/bash.md"),
    ("kimi_tool_grep", f"{SRC}/agent/tools/os/grep/grep.md"),
    ("kimi_tool_read", f"{SRC}/agent/tools/os/read/read.md"),
    ("kimi_tool_edit", f"{SRC}/agent/tools/edit/edit.md"),
    ("kimi_tool_web_search", f"{SRC}/agent/tools/web-search/web-search.md"),
    ("kimi_tool_fetch_url", f"{SRC}/agent/tools/fetch-url/fetch-url.md"),
    ("kimi_tool_ask_user", f"{SRC}/agent/tools/ask-user-question/ask-user.md"),
    ("kimi_tool_notify_user", f"{SRC}/features/notify/tools/notify-user/notify-user.md"),
    ("kimi_tool_todo_list", f"{SRC}/features/todo/tools/todo-list/todo-list.md"),
    ("kimi_tool_exit_plan_mode", f"{SRC}/features/plan/tools/exit-plan-mode/exit-plan-mode.md"),
    ("kimi_tool_update_goal", f"{SRC}/features/goal/tools/update-goal/update-goal.md"),
    ("kimi_tool_skill", f"{SRC}/features/skill/tools/skill.md"),
    ("kimi_tool_cron_create", f"{SRC}/features/cron/tools/cron-create/cron-create.md"),
]


def write(stem: str, content: str) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    text = content.rstrip() + "\n"
    (OUT / f"{stem}.txt").write_text(text, encoding="utf-8")
    return len(text)


def read(rel: str) -> str:
    path = KIMI / rel
    if not path.exists():
        raise SystemExit(f"[render_kimi_code] missing {rel}")
    return path.read_text(encoding="utf-8")


def main() -> int:
    if not KIMI.is_dir():
        raise SystemExit(
            f"[render_kimi_code] missing {KIMI} — run: bash scripts/sync-reference-repos.sh"
        )

    results = [(stem, write(stem, read(rel))) for stem, rel in MARKDOWN_SPECS]

    print("Rendered Kimi Code prompts:")
    for stem, size in results:
        print(f"  {stem:<45s} {size:>7d} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
