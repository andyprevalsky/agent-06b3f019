#!/usr/bin/env python3
"""Render selected OpenClaw session/planning tool prompts from live source.

sessions_spawn + subagent system prompt are extracted via bun (TypeScript).
update_plan stays a normalized JSON spec transcribed from the planning tool.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = ROOT / "prompt-review" / "rendered" / "openclaw"
OPENCLAW = ROOT / "openclaw"


def write(stem: str, payload: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{stem}.txt").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def write_text(stem: str, text: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{stem}.txt").write_text(text.rstrip() + "\n", encoding="utf-8")


def _bun_extract_sessions() -> dict:
    """Import OpenClaw spawn/prompt modules and dump runtime strings."""
    script = r"""
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../openclaw/src");
const spawn = await import(`${root}/agents/tools/sessions-spawn-tool.ts`);
const placement = await import(`${root}/agents/tools/sessions-placement-tool-contract.ts`);
const sub = await import(`${root}/agents/subagents/spawn/subagent-system-prompt.ts`);

const tool = spawn.createSessionsSpawnTool({
  // Representative parent messaging session: ACP available, no worker placement.
});
const envelope = sub.buildSubagentSpawnEnvelope({
  completionMode: "announce",
  spawnMode: "run",
  task: "{{TASK_DESCRIPTION}}",
  requesterSessionKey: "agent:main:telegram:demo",
  requesterOrigin: { channel: "telegram" },
  childSessionKey: "agent:main:subagent:demo-child",
  label: "demo-child",
  acpEnabled: true,
  childDepth: 1,
  maxSpawnDepth: 2,
});

const out = {
  sessions_spawn: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
  placed_sessions_spawn_description: placement.PLACED_SESSIONS_SPAWN_DESCRIPTION,
  subagent_system_prompt: envelope.systemPrompt,
  subagent_task_message: envelope.message,
};
process.stdout.write(JSON.stringify(out, null, 2));
"""
    result = subprocess.run(
        ["bun", "-e", script],
        cwd=str(ROOT / "prompt-review" / "render"),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"bun sessions extract failed:\n{result.stderr or result.stdout}"
        )
    return json.loads(result.stdout)


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
                            "step": {"type": "string", "description": "Short step description."},
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "Current status for this step.",
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
    write("openclaw_update_plan", update_plan)

    live = _bun_extract_sessions()
    write("openclaw_sessions_spawn", live["sessions_spawn"])
    # Combine system prompt + representative task message so the golden matches
    # what the child LLM sees after spawn (system + first user message).
    write_text(
        "openclaw_subagent_system_prompt",
        live["subagent_system_prompt"].rstrip()
        + "\n\n---\n\n"
        + live["subagent_task_message"].rstrip()
        + "\n",
    )

    print("  openclaw_update_plan")
    print("  openclaw_sessions_spawn")
    print("  openclaw_subagent_system_prompt")
    print("[render_openclaw_sessions] wrote 3 files")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[render_openclaw_sessions] FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
