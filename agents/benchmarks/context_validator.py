"""Context well-formedness validators for benchmark smoke tests.

Validates agent message context against Anthropic API rules derived from
claude-code-src's ensureToolResultPairing() and normalizeMessagesForAPI().

These validators run against raw messages from GET /api/agents/:id and simulate
the production LLM pipeline (helpers.llm.build_llm_messages →
transformMessagesForAnthropic) to catch violations before they hit the API.
"""

import json
import uuid
from collections import Counter
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Set


@dataclass
class ContextViolation:
    """A single well-formedness violation."""

    rule: str  # e.g. "unique_tool_use_ids"
    severity: str  # "error" (would cause API 400) or "warning" (suspicious)
    message: str  # Human-readable description
    message_index: Optional[int] = None  # Index in message list where violation was found

    def to_dict(self) -> dict:
        return asdict(self)


def validate_context(messages: List[Dict[str, Any]]) -> List[ContextViolation]:
    """Run all validators against raw API messages. Returns list of violations.

    Args:
        messages: Raw messages from GET /api/agents/:id → .messages[]
                  Each has: role, text, metadata, timestamp, message_id, file_pointer
    """
    violations: List[ContextViolation] = []

    # Unmerged OpenAI view for the role-alternation check — merging consecutive
    # assistants would hide the exact adjacent-assistant corruption rule 2 exists
    # to detect.
    openai_msgs_unmerged = _convert_to_openai_format(messages, merge_assistants=False)

    # Merged OpenAI view drives the tool-use checks (matches real LLM pipeline).
    openai_msgs = _convert_to_openai_format(messages)

    # Convert OpenAI format to Anthropic format (same as Rose completions endpoint)
    anthropic_msgs = _convert_to_anthropic_format(openai_msgs)

    # Run validators on different representations
    violations.extend(_check_unique_tool_use_ids(openai_msgs))
    violations.extend(_check_role_alternation(openai_msgs_unmerged))
    violations.extend(_check_tool_result_pairing(anthropic_msgs))
    violations.extend(_check_no_duplicate_tool_results(anthropic_msgs))
    violations.extend(_check_non_empty_content(anthropic_msgs))
    violations.extend(_check_no_duplicate_messages(messages))
    violations.extend(_check_monotonic_timestamps(messages))

    return violations


# ---------------------------------------------------------------------------
# Format converters (simulate real pipeline)
# ---------------------------------------------------------------------------


def _convert_to_openai_format(messages: List[Dict], merge_assistants: bool = True) -> List[Dict]:
    """Simulate build_llm_messages from helpers/llm.py (the main agent LLM path).

    Converts raw DB messages to OpenAI-formatted messages:
    - SYSTEM → system role
    - USER → user role
    - ASSISTANT → assistant role with tool_calls
    - TOOL → tool role (matched by toolCallId) or system (unmatched)
    - Skips IN_PROGRESS, sub-agent messages
    - Deduplicates TOOL per toolCallId (keeps latest FINISHED, matching build_llm_messages)
    - Sorts by timestamp

    Set merge_assistants=False to skip consecutive-assistant merging so role
    alternation checks can see the unmerged sequence.
    """
    # Sort by timestamp
    sorted_msgs = sorted(messages, key=lambda m: m.get("timestamp", ""))

    # Pre-pass: deduplicate TOOL messages per toolCallId (keep latest terminal message)
    # This matches build_llm_messages behavior in helpers/llm.py
    tool_by_id: Dict[str, Dict] = {}
    deduped_msgs: List[Dict] = []
    for msg in sorted_msgs:
        role = msg.get("role", "")
        metadata = msg.get("metadata") or {}
        if role == "TOOL":
            status = metadata.get("toolStatus")
            tcid = metadata.get("toolCallId")
            if status in ("FINISHED", "ERROR") and tcid:
                tool_by_id[tcid] = msg  # later message wins (sorted by timestamp)
                continue
        deduped_msgs.append(msg)

    # Re-insert deduplicated tool messages at their timestamp position
    for msg in tool_by_id.values():
        deduped_msgs.append(msg)
    sorted_msgs = sorted(deduped_msgs, key=lambda m: m.get("timestamp", ""))

    # First pass: collect declared tool IDs from ASSISTANT messages
    declared_tool_ids: Set[str] = set()
    for msg in sorted_msgs:
        if msg.get("role") == "ASSISTANT":
            metadata = msg.get("metadata") or {}
            for tc in metadata.get("tool_calls", []):
                tc_id = str(tc.get("tool_call_id", ""))
                if tc_id:
                    declared_tool_ids.add(tc_id)

    result: List[Dict] = []
    for msg in sorted_msgs:
        role = msg.get("role", "")
        content = msg.get("text", "")
        metadata = msg.get("metadata") or {}

        # Skip ALL sub-agent internal messages regardless of role
        if metadata.get("subAgentId"):
            continue

        if role == "SYSTEM":
            result.append({"role": "system", "content": content})

        elif role == "USER":
            result.append({"role": "user", "content": content})

        elif role == "ASSISTANT":
            assistant_msg: Dict[str, Any] = {"role": "assistant", "content": content}
            if metadata.get("tool_calls"):
                tool_calls = []
                for tc in metadata["tool_calls"]:
                    tc_id = str(tc.get("tool_call_id", uuid.uuid4()))
                    tool_calls.append({
                        "id": tc_id,
                        "type": "function",
                        "function": {
                            "name": tc.get("tool"),
                            "arguments": json.dumps(
                                {k: v for k, v in tc.items() if k not in ["tool", "tool_call_id"]}
                            ),
                        },
                    })
                assistant_msg["tool_calls"] = tool_calls
            # DAG reasoning output is posted as a standalone ASSISTANT row by
            # dag_executor.py. It's distinct content (not a duplicate turn), so
            # tag it so the role-alternation check can distinguish it from the
            # dual-write bug it's meant to detect.
            if metadata.get("reasoning") or "dagTaskIndex" in metadata:
                assistant_msg["_reasoning"] = True
            # Sub-agent output files are posted as standalone ASSISTANT rows
            # with empty text + file_pointer (see handle_tool_event → AssistantEvent).
            # The real LLM pipeline merges these into the neighbouring assistant
            # turn, so they never reach Anthropic as two messages — not a
            # dual-write bug.
            file_pointer = msg.get("file_pointer") or msg.get("filePointer")
            if file_pointer and not content and not metadata.get("tool_calls"):
                assistant_msg["_file_output"] = True
            result.append(assistant_msg)

        elif role == "TOOL":
            # Skip IN_PROGRESS
            if metadata.get("toolStatus") == "IN_PROGRESS":
                continue
            # Verifier messages → assistant role (tagged so alternation check can skip them)
            if metadata.get("verifierMessage"):
                result.append({"role": "assistant", "content": content, "_verifier": True})
                continue

            tool_call_id = str(metadata.get("toolCallId", ""))
            if tool_call_id and tool_call_id in declared_tool_ids:
                tool_msg: Dict[str, Any] = {
                    "role": "tool",
                    "content": content,
                    "tool_call_id": tool_call_id,
                }
                if metadata.get("toolName"):
                    tool_msg["name"] = metadata["toolName"]
                result.append(tool_msg)
            else:
                # Unmatched TOOL → user message (matches build_llm_messages behavior
                # for DAG-created tool results with no ASSISTANT declaration).
                # Preserve structured payload + attachments so the validator
                # agrees with helpers/llm.py on the same context.
                tool_content = content
                if metadata.get("title"):
                    tool_content = f"{metadata['title']}: {tool_content}"
                if metadata.get("structured_response"):
                    tool_content += (
                        "\n\nStructured Response: "
                        + json.dumps(metadata["structured_response"])
                    )
                file_pointer = msg.get("file_pointer") or msg.get("filePointer")
                if isinstance(file_pointer, dict):
                    fname = (
                        file_pointer.get("filename")
                        or file_pointer.get("storage_path")
                        or "file"
                    )
                    tool_content += f"\n\n[Attached file: {fname}]"
                attachments = metadata.get("attachments")
                if isinstance(attachments, list):
                    for a in attachments:
                        if not isinstance(a, dict):
                            continue
                        fname = a.get("filename") or a.get("storage_path") or "file"
                        tool_content += f"\n\n[Attached file: {fname}]"
                label = metadata.get("toolName") or "tool"
                result.append({"role": "user", "content": f"[{label} result]: {tool_content}"})

    if not merge_assistants:
        return result

    # Merge consecutive assistant messages (matches build_llm_messages post-processing).
    # This happens when the LLM returns bare text (no tool_calls) in one iteration,
    # then tool_calls in the next — both are valid ASSISTANT rows.
    i = 1
    while i < len(result):
        if result[i].get("role") == "assistant" and result[i - 1].get("role") == "assistant":
            prev = result[i - 1]
            curr = result[i]
            merged = (prev.get("content", "") + "\n\n" + curr.get("content", "")).strip()
            prev["content"] = merged
            # Carry forward tool_calls and verifier tag. Mirror llm.py's
            # de-duplication by ID so the validator doesn't manufacture false
            # unique_tool_use_ids errors the real LLM path already normalizes.
            prev_tc = prev.get("tool_calls", [])
            curr_tc = curr.get("tool_calls", [])
            if prev_tc or curr_tc:
                seen_ids: Set[str] = set()
                merged_tc: List[Dict] = []
                for tc in prev_tc + curr_tc:
                    tc_id = tc.get("id")
                    if tc_id and tc_id in seen_ids:
                        continue
                    if tc_id:
                        seen_ids.add(tc_id)
                    merged_tc.append(tc)
                prev["tool_calls"] = merged_tc
            if curr.get("_verifier"):
                prev["_verifier"] = True
            if curr.get("_reasoning"):
                prev["_reasoning"] = True
            result.pop(i)
        else:
            i += 1

    return result


def _convert_to_anthropic_format(openai_msgs: List[Dict]) -> List[Dict]:
    """Simulate transformMessagesForAnthropic from completions/index.ts.

    Converts OpenAI format to Anthropic format:
    - system → extracted to system param (skipped here)
    - assistant with tool_calls → assistant with tool_use content blocks
    - tool → user with tool_result content blocks
    - Bundles consecutive tool_result user messages
    """
    anthropic_msgs: List[Dict] = []

    for msg in openai_msgs:
        role = msg.get("role", "")

        if role == "system":
            # System messages extracted separately in real pipeline; skip
            continue

        if role == "assistant" and msg.get("tool_calls"):
            content_blocks: List[Dict] = []
            text = msg.get("content", "")
            if isinstance(text, str) and text:
                content_blocks.append({"type": "text", "text": text})
            for tc in msg["tool_calls"]:
                tc_id = tc.get("id", "")
                tc_name = tc.get("function", {}).get("name", "")
                raw_args = tc.get("function", {}).get("arguments", "{}")
                try:
                    parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except (json.JSONDecodeError, TypeError):
                    parsed_args = {}
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc_id,
                    "name": tc_name,
                    "input": parsed_args,
                })
            anthropic_msgs.append({
                "role": "assistant",
                "content": content_blocks if content_blocks else [{"type": "text", "text": ""}],
            })
            continue

        if role == "assistant":
            text = msg.get("content", "")
            anthropic_msgs.append({
                "role": "assistant",
                "content": [{"type": "text", "text": text}] if text else [{"type": "text", "text": ""}],
            })
            continue

        if role == "tool":
            tool_call_id = msg.get("tool_call_id", "")
            content = msg.get("content", "")
            anthropic_msgs.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                }],
            })
            continue

        if role == "user":
            content = msg.get("content", "")
            anthropic_msgs.append({
                "role": "user",
                "content": [{"type": "text", "text": content}] if isinstance(content, str) else content,
            })
            continue

    # Bundle consecutive user messages (matches transformMessagesForAnthropic in index.ts).
    # The real endpoint bundles ALL consecutive user messages — text, tool_result, or mixed.
    # This is needed because unmatched TOOL→user conversions can insert text user messages
    # between an assistant tool_use and the matching tool_result user message.
    bundled: List[Dict] = []
    for msg in anthropic_msgs:
        prev = bundled[-1] if bundled else None
        if (
            prev is not None
            and prev.get("role") == "user"
            and msg.get("role") == "user"
            and isinstance(prev.get("content"), list)
            and isinstance(msg.get("content"), list)
        ):
            prev["content"].extend(msg["content"])
        else:
            bundled.append(msg)

    return bundled


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------


def _check_unique_tool_use_ids(openai_msgs: List[Dict]) -> List[ContextViolation]:
    """Rule 1: All tool_use IDs across all assistant messages must be globally unique.

    This is the exact bug that caused Anthropic HTTP 400:
    duplicate ASSISTANT messages → duplicate tool_use blocks with identical IDs.
    """
    violations: List[ContextViolation] = []
    seen_ids: Dict[str, int] = {}  # id → first message index

    for idx, msg in enumerate(openai_msgs):
        if msg.get("role") != "assistant" or not msg.get("tool_calls"):
            continue
        for tc in msg["tool_calls"]:
            tc_id = tc.get("id", "")
            if not tc_id:
                continue
            if tc_id in seen_ids:
                violations.append(ContextViolation(
                    rule="unique_tool_use_ids",
                    severity="error",
                    message=(
                        f"Duplicate tool_use id '{tc_id}' at message {idx} "
                        f"(first seen at message {seen_ids[tc_id]}). "
                        f"Anthropic will reject with 'tool_use ids must be unique'."
                    ),
                    message_index=idx,
                ))
            else:
                seen_ids[tc_id] = idx

    return violations


def _check_role_alternation(openai_msgs: List[Dict]) -> List[ContextViolation]:
    """Rule 2: In OAI format, consecutive assistant messages indicate context corruption.

    OAI format allows consecutive tool/user/system messages (parallel tools, multi-turn),
    but two consecutive assistant messages means the dual-write bug duplicated a turn.

    Exceptions:
    - Verifier TOOL messages converted to assistant role for context.
    - DAG reasoning output posted as a standalone ASSISTANT row by dag_executor.
      A [dag-reasoning→assistant, LLM→assistant] pair is expected, not corruption.
    """
    violations: List[ContextViolation] = []
    prev_role = None
    prev_exempt = False
    prev_idx = 0

    for idx, msg in enumerate(openai_msgs):
        role = msg.get("role")
        if role == "system":
            continue  # system messages don't affect alternation
        is_exempt = (
            msg.get("_verifier", False)
            or msg.get("_reasoning", False)
            or msg.get("_file_output", False)
        )
        if role == "assistant" and prev_role == "assistant":
            # Skip if either message is a known non-dual-write pattern
            if not is_exempt and not prev_exempt:
                violations.append(ContextViolation(
                    rule="role_alternation",
                    severity="error",
                    message=(
                        f"Consecutive assistant messages at OAI indices {prev_idx} and {idx}. "
                        f"This usually indicates context duplication (dual-write bug)."
                    ),
                    message_index=idx,
                ))
        prev_role = role
        prev_exempt = is_exempt
        prev_idx = idx

    return violations


def _check_tool_result_pairing(anthropic_msgs: List[Dict]) -> List[ContextViolation]:
    """Rule 3: Every tool_use must have a matching tool_result, and vice versa.

    - Each tool_use in an assistant message needs a tool_result in the next user message
    - Each tool_result must reference a tool_use from the preceding assistant message
    - No orphaned tool_results (referencing non-existent tool_use)
    """
    violations: List[ContextViolation] = []

    for idx, msg in enumerate(anthropic_msgs):
        if msg.get("role") != "assistant":
            continue

        content = msg.get("content", [])
        if not isinstance(content, list):
            continue

        # Collect tool_use IDs from this assistant message
        tool_use_ids = set()
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                tool_use_ids.add(block.get("id", ""))

        if not tool_use_ids:
            continue

        # Check next message for matching tool_results
        next_idx = idx + 1
        if next_idx >= len(anthropic_msgs):
            violations.append(ContextViolation(
                rule="tool_result_pairing",
                severity="error",
                message=(
                    f"Assistant message {idx} declares tool_use IDs {tool_use_ids} "
                    f"but there is no following message with tool_results."
                ),
                message_index=idx,
            ))
            continue

        next_msg = anthropic_msgs[next_idx]
        next_content = next_msg.get("content", [])
        if not isinstance(next_content, list):
            violations.append(ContextViolation(
                rule="tool_result_pairing",
                severity="error",
                message=(
                    f"Assistant message {idx} declares tool_use IDs {tool_use_ids} "
                    f"but following message {next_idx} has malformed content (not a list)."
                ),
                message_index=idx,
            ))
            continue

        tool_result_ids = set()
        for block in next_content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                tool_result_ids.add(block.get("tool_use_id", ""))

        # Missing results
        missing = tool_use_ids - tool_result_ids
        if missing:
            violations.append(ContextViolation(
                rule="tool_result_pairing",
                severity="error",
                message=(
                    f"tool_use IDs {missing} in assistant message {idx} "
                    f"have no matching tool_result in the next message."
                ),
                message_index=idx,
            ))

        # Orphaned results
        orphaned = tool_result_ids - tool_use_ids
        if orphaned:
            violations.append(ContextViolation(
                rule="tool_result_pairing",
                severity="error",
                message=(
                    f"tool_result IDs {orphaned} in message {next_idx} "
                    f"reference non-existent tool_use IDs from assistant message {idx}."
                ),
                message_index=next_idx,
            ))

    return violations


def _check_no_duplicate_tool_results(anthropic_msgs: List[Dict]) -> List[ContextViolation]:
    """Rule 4: Each tool_use_id should appear in at most one tool_result block."""
    violations: List[ContextViolation] = []
    seen_result_ids: Dict[str, int] = {}  # tool_use_id → first message index

    for idx, msg in enumerate(anthropic_msgs):
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tool_use_id = block.get("tool_use_id", "")
            if not tool_use_id:
                continue
            if tool_use_id in seen_result_ids:
                violations.append(ContextViolation(
                    rule="no_duplicate_tool_results",
                    severity="error",
                    message=(
                        f"Duplicate tool_result for tool_use_id '{tool_use_id}' "
                        f"at message {idx} (first seen at {seen_result_ids[tool_use_id]})."
                    ),
                    message_index=idx,
                ))
            else:
                seen_result_ids[tool_use_id] = idx

    return violations


def _check_non_empty_content(anthropic_msgs: List[Dict]) -> List[ContextViolation]:
    """Rule 5: Non-final assistant messages must have non-empty content.

    Empty content arrays or whitespace-only text blocks are invalid.
    The final assistant message is allowed to be empty (for prefill).
    """
    violations: List[ContextViolation] = []

    for idx, msg in enumerate(anthropic_msgs):
        if msg.get("role") != "assistant":
            continue
        # Skip final message (allowed to be empty)
        if idx == len(anthropic_msgs) - 1:
            continue

        content = msg.get("content", [])
        if not isinstance(content, list):
            continue

        if len(content) == 0:
            violations.append(ContextViolation(
                rule="non_empty_content",
                severity="error",
                message=f"Assistant message {idx} has empty content array.",
                message_index=idx,
            ))
            continue

        # Check if all text blocks are whitespace-only
        all_whitespace = True
        for block in content:
            if not isinstance(block, dict):
                all_whitespace = False
                break
            if block.get("type") != "text":
                all_whitespace = False
                break
            if block.get("text", "").strip():
                all_whitespace = False
                break

        if all_whitespace:
            violations.append(ContextViolation(
                rule="non_empty_content",
                severity="warning",
                message=f"Assistant message {idx} has only whitespace text content.",
                message_index=idx,
            ))

    return violations


def _check_no_duplicate_messages(raw_messages: List[Dict]) -> List[ContextViolation]:
    """Rule 6: No duplicate messages in raw context.

    Same role + same text + same metadata (ignoring message_id, timestamp, file_pointer)
    appearing twice indicates the dual-write dedup failure.
    """
    violations: List[ContextViolation] = []

    def fingerprint(msg: Dict) -> str:
        role = msg.get("role", "")
        text = msg.get("text", "")
        metadata = msg.get("metadata") or {}
        file_pointer = msg.get("file_pointer") or msg.get("filePointer")
        # Normalize metadata: keep only semantic fields
        semantic_meta = {
            k: v for k, v in metadata.items()
            if k not in ("timestamp", "message_id")
        }
        # Include attachment identity so distinct uploads don't collide.
        attachment_fingerprint = None
        if isinstance(file_pointer, dict):
            attachment_fingerprint = file_pointer.get("id") or file_pointer.get("storage_path")
        elif isinstance(semantic_meta.get("attachments"), list):
            attachment_fingerprint = [
                (a.get("id") or a.get("storage_path"))
                for a in semantic_meta["attachments"]
                if isinstance(a, dict)
            ]
        return (
            f"{role}|{text[:500]}|"
            f"{json.dumps(semantic_meta, sort_keys=True)}|"
            f"{json.dumps(attachment_fingerprint, sort_keys=True)}"
        )

    seen: Dict[str, int] = {}  # fingerprint → first index
    for idx, msg in enumerate(raw_messages):
        # Sub-agent messages are filtered from the parent LLM context,
        # so duplicates among them can't cause API errors.
        metadata = msg.get("metadata") or {}
        if metadata.get("subAgentId"):
            continue

        fp = fingerprint(msg)
        if fp in seen:
            role = msg.get("role", "")
            text_preview = (msg.get("text") or "")[:80]
            violations.append(ContextViolation(
                rule="no_duplicate_messages",
                severity="error",
                message=(
                    f"Duplicate {role} message at index {idx} "
                    f"(first at {seen[fp]}): '{text_preview}...'"
                ),
                message_index=idx,
            ))
        else:
            seen[fp] = idx

    return violations


def _check_monotonic_timestamps(raw_messages: List[Dict]) -> List[ContextViolation]:
    """Rule 7: Timestamps should be monotonically increasing.

    Large inversions (>60s) suggest context corruption or out-of-order insertion.
    Small inversions are tolerated for concurrent tool execution.
    """
    violations: List[ContextViolation] = []
    TOLERANCE_SECONDS = 60

    prev_ts: Optional[datetime] = None
    prev_idx = 0

    for idx, msg in enumerate(raw_messages):
        ts_str = msg.get("timestamp", "")
        if not ts_str:
            continue
        try:
            if ts_str.endswith("Z"):
                ts_str = ts_str[:-1] + "+00:00"
            ts = datetime.fromisoformat(ts_str)
        except (ValueError, AttributeError):
            continue

        if prev_ts is not None:
            delta = (prev_ts - ts).total_seconds()
            if delta > TOLERANCE_SECONDS:
                violations.append(ContextViolation(
                    rule="monotonic_timestamps",
                    severity="warning",
                    message=(
                        f"Timestamp inversion of {delta:.0f}s between messages "
                        f"{prev_idx} and {idx}. May indicate context corruption."
                    ),
                    message_index=idx,
                ))
        prev_ts = ts
        prev_idx = idx

    return violations


# ---------------------------------------------------------------------------
# Summary helpers
# ---------------------------------------------------------------------------


def format_violations(violations: List[ContextViolation]) -> str:
    """Format violations into a human-readable summary string."""
    if not violations:
        return "No context violations found."

    errors = [v for v in violations if v.severity == "error"]
    warnings = [v for v in violations if v.severity == "warning"]

    lines = []
    if errors:
        lines.append(f"CONTEXT ERRORS ({len(errors)}):")
        for v in errors:
            lines.append(f"  [{v.rule}] {v.message}")
    if warnings:
        lines.append(f"Context warnings ({len(warnings)}):")
        for v in warnings[:5]:
            lines.append(f"  [{v.rule}] {v.message}")
        if len(warnings) > 5:
            lines.append(f"  ... and {len(warnings) - 5} more warnings")

    return "\n".join(lines)
