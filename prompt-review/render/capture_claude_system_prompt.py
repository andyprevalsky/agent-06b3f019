#!/usr/bin/env python3
"""Capture Claude Code's actual model-bound system prompt from its SDK request.

The TypeScript source graph is hard to import cleanly because the package is
bundled for the CLI. Instead, run the local CLI with a dummy API key and a
fetch hook that exits after writing the outbound /v1/messages JSON body. No
successful API request is needed.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "prompt-review" / "rendered" / "claude-code-src" / "claude_getSystemPrompt.txt"
TOOL_SCHEMA_OUT = ROOT / "prompt-review" / "rendered" / "claude-code-src" / "claude_tool_schemas.json"
CAPTURE = ROOT / ".context" / "claude-request.json"
HOME = ROOT / ".context" / "claude-home"
HOOK = ROOT / "prompt-review" / "render" / "claude_fetch_capture_hook.mjs"
CLI = ROOT / "claude-code-src" / "cli.js"


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    CAPTURE.parent.mkdir(parents=True, exist_ok=True)
    HOME.mkdir(parents=True, exist_ok=True)
    if CAPTURE.exists():
        CAPTURE.unlink()

    env = {
        **os.environ,
        "ANTHROPIC_API_KEY": "sk-ant-dummy",
        "CLAUDE_CAPTURE_PATH": str(CAPTURE),
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "HOME": str(HOME),
        "NODE_OPTIONS": f"--import={HOOK}",
    }
    cmd = [
        "node",
        str(CLI),
        "-p",
        "--model",
        "claude-sonnet-4-6",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "default",
        "--",
        "hi",
    ]
    subprocess.run(cmd, cwd=ROOT, env=env, check=False, capture_output=True, text=True, timeout=30)
    if not CAPTURE.exists():
        raise SystemExit("Claude request capture did not produce .context/claude-request.json")

    request = json.loads(CAPTURE.read_text())
    blocks = request.get("system")
    if not isinstance(blocks, list):
        raise SystemExit("Captured Claude request has no system block list")
    text_blocks = []
    for block in blocks:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            text_blocks.append(block["text"])
    text = "\n\n".join(text_blocks).strip() + "\n"
    OUT.write_text(text)
    print(f"  captured claude_getSystemPrompt ({len(text)} chars)")

    tools = request.get("tools")
    if isinstance(tools, list):
        tool_schemas = {}
        for tool in tools:
            if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                continue
            schema = tool.get("input_schema")
            if isinstance(schema, dict):
                tool_schemas[tool["name"]] = {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": schema,
                }
        TOOL_SCHEMA_OUT.write_text(json.dumps(tool_schemas, indent=2) + "\n")
        print(f"  captured {len(tool_schemas)} Claude tool schemas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
