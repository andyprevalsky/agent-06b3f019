#!/usr/bin/env python3
"""Replay the ONE retarded Tokyo LLM decision call.

Prod child 2f7323fb… (parent 1df52bf3…, spawn-sub-agents 20260903-060415):
explore FINISHED with Tokyo population prose → model called wait_for
("Confirming completed official research") instead of attempt_completion.

This does NOT patch the harness / force-completion. It only:
  1) rebuilds that decision-turn call from the cemented fixture
  2) optionally hits a live LLM so you can watch the tool choice

  cd agents && source venv/bin/activate
  python benchmarks/repro/replay_tokyo_wait_for_llm_call.py --bare
  python benchmarks/repro/replay_tokyo_wait_for_llm_call.py --live --trials 5
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

AGENTS_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AGENTS_ROOT))
load_dotenv(AGENTS_ROOT / ".env", override=False)

from tools.prompts.wait_for import PROMPT as WAIT_FOR_TOOL_PROMPT  # noqa: E402
from utils.tool_schemas import TOOL_MODELS  # noqa: E402

FIXTURE = (
    AGENTS_ROOT
    / "tests"
    / "blackbox"
    / "fixtures"
    / "spawn_sub_agents_tokyo_wait_for_input.json"
)

TOOL_ORDER = [
    "spawn_agent",
    "wait_for",
    "attempt_completion",
    "web_search",
    "web_fetch",
]


def _openai_tools() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name in TOOL_ORDER:
        model = TOOL_MODELS[name]
        schema = model.model_json_schema()
        schema.pop("title", None)
        desc = (model.__doc__ or "").strip()
        if name == "wait_for":
            desc = WAIT_FOR_TOOL_PROMPT.strip()
        out.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc or name,
                    "parameters": schema,
                },
            }
        )
    return out


def build_messages(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    """Rebuild the decision turn from cemented USER → spawn → explore FINISHED."""
    system = (
        "You are an execute-phase agent with tools: spawn_agent, wait_for, "
        "attempt_completion, web_search, web_fetch.\n"
        "Goal requires returning only the integer Tokyo population via "
        "attempt_completion when you have it.\n"
        "wait_for pauses until a future timestamp or condition — do not use it "
        "to 'confirm' work that already finished."
    )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for turn in fixture["context_at_bad_turn"]:
        role = turn["role"].upper()
        text = turn.get("text") or ""
        meta = turn.get("metadata") or {}
        if role == "USER":
            messages.append({"role": "user", "content": text})
        elif role == "ASSISTANT":
            tool_calls = meta.get("tool_calls") or []
            if tool_calls:
                openai_calls = []
                for i, tc in enumerate(tool_calls):
                    args = {
                        k: v
                        for k, v in tc.items()
                        if k not in {"tool", "tool_call_id"}
                    }
                    openai_calls.append(
                        {
                            "id": tc.get("tool_call_id") or f"call_spawn_{i}",
                            "type": "function",
                            "function": {
                                "name": tc["tool"],
                                "arguments": json.dumps(args),
                            },
                        }
                    )
                messages.append(
                    {
                        "role": "assistant",
                        "content": text or None,
                        "tool_calls": openai_calls,
                    }
                )
            else:
                messages.append({"role": "assistant", "content": text})
        elif role == "TOOL":
            tool_call_id = (
                meta.get("toolCallId")
                or meta.get("tool_call_id")
                or "call_spawn_0"
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": (
                        f"[spawn_agent FINISHED type={meta.get('agentType')}] "
                        f"title={meta.get('title')}\n\n{text}"
                    ),
                }
            )
        else:
            raise ValueError(f"unexpected role {role!r}")
    return messages


def summarize_choice(message: Any) -> dict[str, Any]:
    tool_calls = getattr(message, "tool_calls", None) or []
    if not tool_calls:
        return {
            "kind": "text",
            "content": (getattr(message, "content", None) or "")[:500],
        }
    first = tool_calls[0]
    name = first.function.name
    try:
        args = json.loads(first.function.arguments or "{}")
    except json.JSONDecodeError:
        args = {"_raw": first.function.arguments}
    return {"kind": "tool", "name": name, "arguments": args}


def live_call(messages: list[dict[str, Any]], model: str) -> dict[str, Any]:
    from openai import OpenAI

    openrouter = os.environ.get("OPENROUTER_API_KEY")
    if openrouter:
        client = OpenAI(api_key=openrouter, base_url="https://openrouter.ai/api/v1")
        if "/" not in model:
            model = f"openai/{model}"
    else:
        api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("GPT_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Need OPENROUTER_API_KEY or OPENAI_API_KEY/GPT_API_KEY in agents/.env"
            )
        client = OpenAI(api_key=api_key)

    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=_openai_tools(),
        tool_choice="auto",
        temperature=0,
    )
    choice = summarize_choice(resp.choices[0].message)
    return {
        "model": model,
        "finish_reason": resp.choices[0].finish_reason,
        "choice": choice,
        "is_wait_for": choice.get("name") == "wait_for",
        "is_attempt_completion": choice.get("name") == "attempt_completion",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bare", action="store_true", help="Print rebuilt call only")
    parser.add_argument("--live", action="store_true", help="Hit live chat+tools")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--model", default="gpt-4.1-mini")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    if not args.bare and not args.live:
        args.bare = True

    fixture = json.loads(FIXTURE.read_text())
    messages = build_messages(fixture)
    tools = _openai_tools()
    bad = fixture["observed_bad_model_output"]
    tc0 = bad["tool_calls"][0]

    payload: dict[str, Any] = {
        "repro_id": fixture["repro_id"],
        "source_agent_id": fixture["source_agent_id"],
        "source_parent_agent_id": fixture["source_parent_agent_id"],
        "source_run": fixture["source_run"],
        "prod_path": fixture["model_fingerprint"]["path"],
        "prod_bad_output": {
            "tool": tc0["tool"],
            "description": tc0.get("description"),
            "until_timestamp": tc0.get("until_timestamp"),
            "check_interval_seconds": tc0.get("check_interval_seconds"),
            "error": bad.get("error"),
            "tool_call_id": tc0.get("tool_call_id"),
        },
        "expected": fixture["expected_correct_output"],
        "wait_for_prompt_leak_example": fixture.get(
            "wait_for_prompt_example_that_leaked_into_args"
        ),
        "explore_finished_excerpt": next(
            (
                t["text"][:240]
                for t in fixture["context_at_bad_turn"]
                if t["role"] == "TOOL"
            ),
            "",
        ),
        "replay_messages": messages,
        "replay_tool_names": [t["function"]["name"] for t in tools],
        "note": (
            "Prod path was rose_gpt_auth_codex. Live replay uses OpenAI "
            "chat.completions + product tool schemas as a decision-turn proxy. "
            "This script does not force-completion."
        ),
    }

    if args.live:
        results = []
        for i in range(args.trials):
            try:
                results.append({"trial": i + 1, **live_call(messages, args.model)})
            except Exception as exc:  # surface live failures in the artifact
                results.append({"trial": i + 1, "error": str(exc)})
        payload["live_results"] = results
        wait_n = sum(1 for r in results if r.get("is_wait_for"))
        done_n = sum(1 for r in results if r.get("is_attempt_completion"))
        payload["live_summary"] = {
            "trials": args.trials,
            "wait_for": wait_n,
            "attempt_completion": done_n,
            "other_or_error": args.trials - wait_n - done_n,
        }

    text = json.dumps(payload, indent=2, default=str)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text)
        print(f"wrote {args.out}", file=sys.stderr)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
