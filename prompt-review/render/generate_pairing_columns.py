#!/usr/bin/env python3
"""Generate static exact prompt columns for approved tool/browser pairings."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "prompt-review" / "data.json"
OUT_DIR = ROOT / ".context"
PAIRINGS_TSV = OUT_DIR / "our_tool_pairings_final.tsv"
EXACT_MD = OUT_DIR / "tool_pairing_columns_exact.md"
EXACT_JSON = OUT_DIR / "tool_pairing_columns_exact.json"
GOLD_LISTS = OUT_DIR / "gold_repo_tool_lists.txt"

PAIRING_IDS = [
    "tool_attempt_completion",
    "tool_call_phone_number",
    "tool_grep",
    "tool_message_person",
    "tool_reasoning",
    "tool_send_message_to_user",
    "tool_send_message_to_user_execute",
    "tool_set_plan",
    "tool_spawn_agent",
    "tool_spawn_browser_agent",
    "tool_spawn_code_agent",
    "tool_spawn_explore_agent",
    "tool_spawn_sub_agent",
    "tool_spawn_sub_agent_for_each",
    "tool_wait_for",
    "tool_web_fetch",
    "tool_web_search",
    "browser_tool_observe",
    "browser_tool_extract",
    "browser_tool_click",
    "browser_tool_fill",
    "browser_tool_type",
    "browser_tool_press_key",
    "browser_tool_goto",
    "browser_tool_scroll",
    "browser_tool_wait",
    "browser_tool_attempt_completion",
    "browser_tool_screenshot",
    "browser_tool_aria_tree",
    "browser_tool_navback",
    "browser_tool_click_at_coordinates",
]


def cell(row: dict, key: str) -> tuple[str | None, str]:
    if key == "current":
        entry = row["current"]
    else:
        entry = (row.get(key) or {}).get("entry")
    if not entry:
        return None, "_none_"
    return entry["id"], entry.get("formatted_text") or entry.get("text") or ""


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    data = json.loads(DATA.read_text())
    rows_by_id = {row["id"]: row for row in data["rows"]}
    missing = [row_id for row_id in PAIRING_IDS if row_id not in rows_by_id]
    if missing:
        raise SystemExit(f"Missing pairing rows in data.json: {', '.join(missing)}")

    exact: dict[str, dict] = {}
    md_lines = ["# Exact Column Prompts (Static)", ""]
    tsv_lines = ["our_tool\tclaude\thermes\topenclaw\tcodex\tprime\tkimi"]
    gold: dict[str, set[str]] = {"claude": set(), "hermes": set(), "openclaw": set(), "codex": set(), "prime": set(), "kimi": set()}

    for row_id in PAIRING_IDS:
        row = rows_by_id[row_id]
        ids: dict[str, str] = {}
        texts: dict[str, str] = {}
        for label, key in [
            ("our", "current"),
            ("claude", "claude"),
            ("hermes", "hermes"),
            ("openclaw", "openclaw"),
            ("codex", "codex"),
            ("prime", "prime"),
            ("kimi", "kimi"),
        ]:
            matched_id, formatted = cell(row, key)
            ids[label] = matched_id or "none"
            texts[label] = formatted
            if label in gold and matched_id:
                gold[label].add(matched_id)

        tsv_lines.append(f"{row_id}\t{ids['claude']}\t{ids['hermes']}\t{ids['openclaw']}\t{ids['codex']}\t{ids['prime']}\t{ids['kimi']}")
        exact[row_id] = {"ids": ids, "columns": texts}

        md_lines.extend(
            [
                f"## {row_id}",
                f"- claude: `{ids['claude']}`",
                f"- hermes: `{ids['hermes']}`",
                f"- openclaw: `{ids['openclaw']}`",
                f"- codex: `{ids['codex']}`",
                f"- prime: `{ids['prime']}`",
                f"- kimi: `{ids['kimi']}`",
                "",
                "### Our Tool",
                texts["our"],
                "",
                "### Claude",
                texts["claude"],
                "",
                "### Hermes",
                texts["hermes"],
                "",
                "### OpenClaw",
                texts["openclaw"],
                "",
                "### Codex",
                texts["codex"],
                "",
                "### Prime Agent",
                texts["prime"],
                "",
                "### Kimi Code",
                texts["kimi"],
                "",
            ]
        )

    PAIRINGS_TSV.write_text("\n".join(tsv_lines) + "\n")
    EXACT_MD.write_text("\n".join(md_lines).rstrip() + "\n")
    EXACT_JSON.write_text(json.dumps(exact, indent=2) + "\n")

    gold_lines = ["# Gold Repo Tool Lists", ""]
    for repo in ["claude", "hermes", "openclaw", "codex", "prime", "kimi"]:
        gold_lines.extend([f"## {repo}", *[f"- {x}" for x in sorted(gold[repo])], ""])
    GOLD_LISTS.write_text("\n".join(gold_lines).rstrip() + "\n")

    print(f"[pairing-columns] wrote {PAIRINGS_TSV}")
    print(f"[pairing-columns] wrote {EXACT_MD}")
    print(f"[pairing-columns] wrote {EXACT_JSON}")
    print(f"[pairing-columns] wrote {GOLD_LISTS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
