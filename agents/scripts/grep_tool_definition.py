"""Generate the one grep tool definition every surface shares.

The explore agent's native grep tool (``utils.tool_schemas.GrepTool`` with the
``utils.grep_tool_contract`` description) is the source. This writes exactly
what that tool sends the model, ``{name, description, parameters}``, to
``back-end/src/providers/grepTool/grepToolDefinition.json``, which the SMS
supervisor and web chat load. ``tests/blackbox/grep.blackbox.py`` fails when
the checked-in file differs from a fresh build.

Usage (from agents/, venv active):
    python scripts/grep_tool_definition.py --write   # regenerate after a contract change
    python scripts/grep_tool_definition.py --check   # exit 1 on drift
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

AGENTS_DIR = Path(__file__).resolve().parents[1]
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

DEFINITION_PATH = AGENTS_DIR.parent / "back-end" / "src" / "providers" / "grepTool" / "grepToolDefinition.json"


def build_grep_tool_definition() -> Dict[str, Any]:
    """The explore agent's native grep tool, as the model receives it."""
    from providers.rose.schema import build_anthropic_tools_from_response_model
    from utils.tool_schemas import GrepTool, create_agent_action_model

    (tool,) = build_anthropic_tools_from_response_model(
        create_agent_action_model(["grep"], tool_registry={"grep": GrepTool})
    )
    return {"name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"]}


def render_grep_tool_definition() -> str:
    return json.dumps(build_grep_tool_definition(), indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="write the generated definition")
    mode.add_argument("--check", action="store_true", help="fail when the checked-in definition drifted")
    args = parser.parse_args()
    rendered = render_grep_tool_definition()
    if args.write:
        DEFINITION_PATH.parent.mkdir(parents=True, exist_ok=True)
        DEFINITION_PATH.write_text(rendered, encoding="utf-8")
        print(f"wrote {DEFINITION_PATH}")
        return 0
    current = DEFINITION_PATH.read_text(encoding="utf-8") if DEFINITION_PATH.exists() else ""
    if current != rendered:
        print(
            f"{DEFINITION_PATH} is out of date; run `python scripts/grep_tool_definition.py --write` from agents/.",
            file=sys.stderr,
        )
        return 1
    print("grep tool definition is current")
    return 0


if __name__ == "__main__":
    sys.exit(main())
