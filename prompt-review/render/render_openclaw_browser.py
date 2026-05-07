#!/usr/bin/env python3
"""Render OpenClaw browser tool prompt variants for dashboard pairings.

These are extracted from:
- openclaw/extensions/browser/src/browser-tool.ts (tool description)
- openclaw/extensions/browser/src/browser-tool.schema.ts (action/kind enums)

Output: prompt-review/rendered/openclaw/openclaw_browser_*.txt
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
TOOL_TS = ROOT / "openclaw" / "extensions" / "browser" / "src" / "browser-tool.ts"
SCHEMA_TS = ROOT / "openclaw" / "extensions" / "browser" / "src" / "browser-tool.schema.ts"
OUT_DIR = ROOT / "prompt-review" / "rendered" / "openclaw"


def _extract_ts_string_array(src: str, const_name: str) -> list[str]:
    m = re.search(rf"const\s+{re.escape(const_name)}\s*=\s*\[(.*?)\]\s+as\s+const;", src, re.S)
    if not m:
        return []
    body = m.group(1)
    vals = re.findall(r'"((?:[^"\\]|\\.)*)"', body)
    return [bytes(v, "utf-8").decode("unicode_escape") for v in vals]


def _extract_tool_description(src: str) -> str:
    m = re.search(r'description:\s*\[(.*?)\]\.join\(" "\)', src, re.S)
    if not m:
        return "OpenClaw browser control tool."
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
    parts = [bytes(p, "utf-8").decode("unicode_escape") for p in parts]
    return " ".join(p.strip() for p in parts if p.strip())


def _write(stem: str, payload: dict) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    p = OUT_DIR / f"{stem}.txt"
    p.write_text(text, encoding="utf-8")
    return len(text)


def _base_payload(desc: str, actions: list[str], kinds: list[str], targets: list[str]) -> dict:
    return {
        "name": "browser",
        "description": desc,
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": actions,
                    "description": "Browser command family.",
                },
                "target": {
                    "type": "string",
                    "enum": targets,
                    "description": "Where to run browser control.",
                },
                "profile": {
                    "type": "string",
                    "description": "Browser profile (e.g., openclaw, user).",
                },
                "targetUrl": {
                    "type": "string",
                    "description": "URL for open/navigate actions.",
                },
                "targetId": {
                    "type": "string",
                    "description": "Tab target identifier.",
                },
                "snapshotFormat": {
                    "type": "string",
                    "enum": ["aria", "ai"],
                    "description": "Snapshot output format.",
                },
                "request": {
                    "type": "object",
                    "description": "Action request for action='act'.",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": kinds,
                            "description": "Act action kind.",
                        },
                        "ref": {"type": "string", "description": "Element ref for ref-based actions."},
                        "text": {"type": "string", "description": "Input text for type/fill actions."},
                        "key": {"type": "string", "description": "Key for press action."},
                        "x": {"type": "number", "description": "X coordinate for clickCoords."},
                        "y": {"type": "number", "description": "Y coordinate for clickCoords."},
                        "timeMs": {"type": "number", "description": "Wait duration for kind='wait'."},
                    },
                },
            },
            "required": ["action"],
        },
    }


def main() -> int:
    tool_src = TOOL_TS.read_text(encoding="utf-8", errors="replace")
    schema_src = SCHEMA_TS.read_text(encoding="utf-8", errors="replace")

    actions = _extract_ts_string_array(schema_src, "BROWSER_TOOL_ACTIONS")
    kinds = _extract_ts_string_array(schema_src, "BROWSER_ACT_KINDS")
    targets = _extract_ts_string_array(schema_src, "BROWSER_TARGETS")
    desc = _extract_tool_description(tool_src)

    base = _base_payload(desc, actions, kinds, targets)

    variants = {
        "openclaw_browser_action_snapshot": {
            "description": "Focus: browser(action='snapshot'). For ARIA-tree equivalents use snapshotFormat='aria'.",
            "fixed": {"action": "snapshot"},
        },
        "openclaw_browser_action_snapshot_aria": {
            "description": "Focus: browser(action='snapshot', snapshotFormat='aria').",
            "fixed": {"action": "snapshot", "snapshotFormat": "aria"},
        },
        "openclaw_browser_action_screenshot": {
            "description": "Focus: browser(action='screenshot').",
            "fixed": {"action": "screenshot"},
        },
        "openclaw_browser_action_navigate": {
            "description": "Focus: browser(action='navigate') with targetUrl/url.",
            "fixed": {"action": "navigate"},
        },
        "openclaw_browser_action_act_click": {
            "description": "Focus: browser(action='act', request.kind='click').",
            "fixed": {"action": "act", "request": {"kind": "click"}},
        },
        "openclaw_browser_action_act_fill": {
            "description": "Focus: browser(action='act', request.kind='fill').",
            "fixed": {"action": "act", "request": {"kind": "fill"}},
        },
        "openclaw_browser_action_act_type": {
            "description": "Focus: browser(action='act', request.kind='type').",
            "fixed": {"action": "act", "request": {"kind": "type"}},
        },
        "openclaw_browser_action_act_press": {
            "description": "Focus: browser(action='act', request.kind='press').",
            "fixed": {"action": "act", "request": {"kind": "press"}},
        },
        "openclaw_browser_action_act_wait": {
            "description": "Focus: browser(action='act', request.kind='wait').",
            "fixed": {"action": "act", "request": {"kind": "wait"}},
        },
        "openclaw_browser_action_act_clickCoords": {
            "description": "Focus: browser(action='act', request.kind='clickCoords').",
            "fixed": {"action": "act", "request": {"kind": "clickCoords"}},
        },
    }

    total = 0
    for stem, meta in variants.items():
        payload = json.loads(json.dumps(base))
        payload["description"] = f"{payload['description']}\n\n{meta['description']}"
        payload["fixed_example"] = meta["fixed"]
        size = _write(stem, payload)
        total += size
        print(f"  {stem:<44} {size:>7d} chars")

    print(f"[render_openclaw_browser] wrote {len(variants)} files, {total} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
