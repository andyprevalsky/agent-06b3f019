#!/usr/bin/env python3
"""Poll and validate a benchmark checkpoint resume.

This validates a resumed checkpoint by running the normal benchmark evaluator
and checking the newly produced root-agent trajectory for reasoning-row jank.
Mass Agent 0 also gets its stricter post-fanout visible-card sequence check.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any, Iterable

AGENTS_ROOT = Path(__file__).resolve().parents[1]
if str(AGENTS_ROOT) not in sys.path:
    sys.path.insert(0, str(AGENTS_ROOT))

from benchmarks.benchmark_tasks import get_task_by_name
from benchmarks.run_benchmark import evaluate_task, get_agent, poll_agent


EXPECTED_VISIBLE_SEQUENCE = [
    "Thought",
    "Thought",
    "Code Agent Succeeded",
    "Thought",
    "Attempt Completion Success",
]


def _load_manifest(path: Path) -> dict[str, Any]:
    with path.open() as f:
        manifest = json.load(f)
    if not manifest.get("agent_id"):
        raise ValueError(f"manifest {path} is missing agent_id")
    if not isinstance(manifest.get("cloned_message_count"), int):
        raise ValueError(f"manifest {path} is missing cloned_message_count")
    return manifest


def _metadata(message: dict[str, Any]) -> dict[str, Any]:
    metadata = message.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _post_checkpoint_messages(data: dict[str, Any], checkpoint_count: int) -> list[dict[str, Any]]:
    messages = data.get("messages") or []
    if checkpoint_count < 0 or checkpoint_count > len(messages):
        raise ValueError(f"checkpoint count {checkpoint_count} is outside message count {len(messages)}")
    return messages[checkpoint_count:]


def _visible_label(message: dict[str, Any]) -> str | None:
    meta = _metadata(message)
    tool_name = meta.get("toolName")
    status = meta.get("toolStatus")
    action_type = meta.get("action_type")

    if message.get("role") == "ASSISTANT" and meta.get("plannedToolName") == "reasoning":
        return "Thought"
    if _is_successful_code_completion(message):
        return "Code Agent Succeeded"
    if tool_name == "attempt_completion" and status == "FINISHED":
        return "Attempt Completion Success"
    return None


def _is_successful_code_completion(message: dict[str, Any]) -> bool:
    meta = _metadata(message)
    if (
        meta.get("toolName") != "spawn_claude_code_agent"
        or meta.get("toolStatus") != "FINISHED"
        or meta.get("action_type") != "task_complete"
    ):
        return False

    title = str(meta.get("title") or message.get("title") or "")
    text = str(message.get("text") or "")
    if title != "✓ Task Completed":
        return False
    if any(marker in f"{title}\n{text}".lower() for marker in ("cancelled", "canceled", "paused", "incomplete")):
        return False
    return True


def _is_subsequence(expected: Iterable[str], actual: Iterable[str]) -> bool:
    remaining = list(expected)
    if not remaining:
        return True
    idx = 0
    for item in actual:
        if item == remaining[idx]:
            idx += 1
            if idx == len(remaining):
                return True
    return False


def _validate_post_checkpoint(
    data: dict[str, Any],
    checkpoint_count: int,
    *,
    expected_visible_sequence: Iterable[str] | None = None,
) -> tuple[bool, str | None, list[str]]:
    messages = _post_checkpoint_messages(data, checkpoint_count)
    visible = [label for msg in messages if (label := _visible_label(msg))]

    raw_reasoning = [
        i
        for i, msg in enumerate(messages, start=checkpoint_count)
        if _metadata(msg).get("toolName") == "reasoning"
    ]
    if raw_reasoning:
        return False, f"raw reasoning tool rows after checkpoint at indices {raw_reasoning}", visible

    duplicate_reasoning = [
        i
        for i, msg in enumerate(messages, start=checkpoint_count)
        if msg.get("role") == "ASSISTANT" and _metadata(msg).get("reasoning") is True
    ]
    if duplicate_reasoning:
        return False, f"assistant metadata.reasoning=true rows after checkpoint at indices {duplicate_reasoning}", visible

    tool_thoughts = [
        i
        for i, msg in enumerate(messages, start=checkpoint_count)
        if _metadata(msg).get("toolName") == "thought"
    ]
    if tool_thoughts:
        return False, f"persisted TOOL thought rows after checkpoint at indices {tool_thoughts}", visible

    code_errors = [
        i
        for i, msg in enumerate(messages, start=checkpoint_count)
        if _metadata(msg).get("toolName") == "spawn_claude_code_agent"
        and _metadata(msg).get("toolStatus") == "ERROR"
    ]
    if code_errors:
        return False, f"code-agent error rows after checkpoint at indices {code_errors}", visible

    code_incomplete = [
        i
        for i, msg in enumerate(messages, start=checkpoint_count)
        if _metadata(msg).get("toolName") == "spawn_claude_code_agent"
        and _metadata(msg).get("toolStatus") == "FINISHED"
        and _metadata(msg).get("action_type") == "task_complete"
        and not _is_successful_code_completion(msg)
    ]
    if code_incomplete:
        return False, f"code-agent incomplete/cancelled rows after checkpoint at indices {code_incomplete}", visible

    expected = list(expected_visible_sequence or [])
    if expected and not _is_subsequence(expected, visible):
        return (
            False,
            f"visible sequence {visible} does not contain expected {expected}",
            visible,
        )

    return True, None, visible


async def _run(args: argparse.Namespace) -> int:
    manifest = _load_manifest(Path(args.manifest)) if args.manifest else {}
    agent_id = args.agent_id or manifest["agent_id"]
    task_name = args.task or manifest.get("task_name") or "test-mass-agent-run-0"
    checkpoint_count = args.checkpoint_count
    if checkpoint_count is None:
        checkpoint_count = manifest.get("cloned_message_count")
    if checkpoint_count is None:
        raise ValueError("--checkpoint-count is required without --manifest")

    task = get_task_by_name(task_name)
    if args.timeout_seconds:
        task._resolved_timeout_seconds = args.timeout_seconds

    print(f"Polling checkpoint agent {agent_id}")
    print(f"Frontend: {args.frontend_url}/?agent-id={agent_id}")
    data, approvals_triggered, _, early_failure = await poll_agent(args.url, agent_id, task)
    if early_failure:
        print(f"FAIL: {early_failure}")
        return 1

    passed, reason = evaluate_task(task, data, approvals_triggered)
    if not passed:
        print(f"FAIL: benchmark evaluator: {reason}")
        return 1

    expected_visible_sequence = EXPECTED_VISIBLE_SEQUENCE if task_name == "test-mass-agent-run-0" else None
    clean, clean_reason, visible = _validate_post_checkpoint(
        data,
        checkpoint_count,
        expected_visible_sequence=expected_visible_sequence,
    )
    print(f"Post-checkpoint visible cards: {' -> '.join(visible)}")
    if not clean:
        print(f"FAIL: {clean_reason}")
        return 1

    print("PASS: checkpoint resumed cleanly")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", help="Checkpoint manifest from create-agent-checkpoint.ts")
    parser.add_argument("--agent-id", help="Agent id when not using --manifest")
    parser.add_argument("--checkpoint-count", type=int, help="Number of pre-checkpoint messages")
    parser.add_argument("--task", help="Benchmark task name. Defaults to manifest task_name when present.")
    parser.add_argument("--url", default="http://localhost:3001", help="Backend URL")
    parser.add_argument("--frontend-url", default="http://localhost:3000")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    args = parser.parse_args()

    if not args.manifest and not args.agent_id:
        parser.error("--manifest or --agent-id is required")
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
