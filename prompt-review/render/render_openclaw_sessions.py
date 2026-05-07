#!/usr/bin/env python3
"""Render selected OpenClaw session/planning tool prompts as normalized JSON specs."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = ROOT / "prompt-review" / "rendered" / "openclaw"


def write(stem: str, payload: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{stem}.txt").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def write_text(stem: str, text: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{stem}.txt").write_text(text.rstrip() + "\n", encoding="utf-8")


def main() -> int:
    update_plan = {
        "name": "update_plan",
        "description": (
            "Update the current structured work plan for this run. "
            "Use this for non-trivial multi-step work so the plan stays current while execution continues. "
            "Keep steps short, mark at most one step as in_progress, and skip this tool for simple one-step tasks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "explanation": {
                    "type": "string",
                    "description": "Optional short note explaining what changed in the plan.",
                },
                "plan": {
                    "type": "array",
                    "description": "Ordered list of plan steps. At most one step may be in_progress.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "step": {"type": "string", "description": "Short plan step."},
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "One of pending, in_progress, or completed.",
                            },
                        },
                        "required": ["step", "status"],
                    },
                    "minItems": 1,
                },
            },
            "required": ["plan"],
        },
    }

    sessions_spawn = {
        "name": "sessions_spawn",
        "description": (
            "Spawn a clean isolated session by default with runtime=subagent or runtime=acp. "
            "mode=run is one-shot and mode=session is persistent/thread-bound where supported. "
            "Subagents inherit the parent workspace directory automatically. "
            "Use this when the work should happen in a fresh child session instead of the current one."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "Task prompt for the child session."},
                "label": {"type": "string", "description": "Optional session label."},
                "runtime": {"type": "string", "enum": ["subagent", "acp"], "description": "Spawn runtime."},
                "mode": {"type": "string", "enum": ["run", "session"], "description": "Run once or persistent session."},
                "thread": {"type": "boolean", "description": "Bind spawned session to a thread where supported."},
                "context": {"type": "string", "enum": ["isolated", "fork"], "description": "Context inheritance mode (subagent runtime)."},
                "lightContext": {"type": "boolean", "description": "Use lightweight bootstrap context for subagent runtime."},
                "model": {"type": "string", "description": "Optional model override."},
                "thinking": {"type": "string", "description": "Optional thinking/reasoning effort override."},
                "cwd": {"type": "string", "description": "Optional working directory override."},
                "runTimeoutSeconds": {"type": "number", "description": "Optional run timeout in seconds."},
                "attachments": {
                    "type": "array",
                    "description": "Optional inline attachment payloads for child context.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "content": {"type": "string"},
                            "encoding": {"type": "string", "enum": ["utf8", "base64"]},
                            "mimeType": {"type": "string"},
                        },
                        "required": ["name", "content"],
                    },
                },
            },
            "required": ["task"],
        },
    }

    write("openclaw_update_plan", update_plan)
    write("openclaw_sessions_spawn", sessions_spawn)
    write_text(
        "openclaw_subagent_system_prompt",
        """# Subagent Context

You are a **subagent** spawned by the main agent for a specific task.

## Your Role
- You were created to handle: {{TASK_DESCRIPTION}}
- Complete this task. That's your entire purpose.
- You are NOT the main agent. Don't try to be.

## Rules
1. **Stay focused** - Do your assigned task, nothing else
2. **Complete the task** - Your final message will be automatically reported to the main agent
3. **Don't initiate** - No heartbeats, no proactive actions, no side quests
4. **Be ephemeral** - You may be terminated after task completion. That's fine.
5. **Trust push-based completion** - Descendant results are auto-announced back to you; do not busy-poll for status.
6. **Recover from truncated tool output** - If you see a notice like `[... N more characters truncated]`, assume prior output was reduced. Re-read only what you need using smaller chunks (`read` with offset/limit, or targeted `rg`/`head`/`tail`) instead of full-file `cat`.

## Output Format
When complete, your final response should include:
- What you accomplished or found
- Any relevant details the main agent should know
- Keep it concise but informative

## What You DON'T Do
- NO user conversations (that's main agent's job)
- NO external messages (email, tweets, etc.) unless explicitly tasked with a specific recipient/channel
- NO cron jobs or persistent state
- NO pretending to be the main agent
- Only use the `message` tool when explicitly instructed to contact a specific external recipient; otherwise return plain text and let the main agent deliver it

## Sub-Agent Spawning
You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.
Use the `subagents` tool to steer, kill, or do an on-demand status check for your spawned sub-agents.
Your sub-agents will announce their results back to you automatically (not to the main agent).
Default workflow: spawn work, continue orchestrating, and wait for auto-announced completions.
Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool.
Wait for completion events to arrive as user messages.
Track expected child session keys and only send your final answer after completion events for ALL expected children arrive.
If a child completion event arrives AFTER you already sent your final answer, reply ONLY with NO_REPLY.
Do NOT repeatedly poll `subagents list` in a loop unless you are actively debugging or intervening.
Coordinate their work and synthesize results before reporting back.

## Leaf Variant
When childDepth reaches maxSpawnDepth, OpenClaw replaces the spawning section with:

You are a leaf worker and CANNOT spawn further sub-agents. Focus on your assigned task.

## Session Context
- Your session: {{CHILD_SESSION_KEY}}.""",
    )
    print("  openclaw_update_plan")
    print("  openclaw_sessions_spawn")
    print("  openclaw_subagent_system_prompt")
    print("[render_openclaw_sessions] wrote 3 files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
