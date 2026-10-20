"""Polar-bench evaluator — Odysseys-faithful per-rubric trajectory judge.

ISOLATION CONTRACT
------------------
This module is the *only* place that implements ``method: "polar"``. It must not
import or call:
  - ``helpers.llm.check_progress`` / declared single-turn or agentic judges
  - ``benchmarks.semantic_evaluator_evidence``
  - ecommerce / rose-bench judge prompt templates

Other evaluator methods must not import this module. The sole production call
site is the ``method == "polar"`` branch in
``run_benchmark._run_declared_evaluators``.

SPEC (mirrors Odysseys ``run_full_trajectory_per_rubric.py``)
------------------------------------------------------------
Per rubric item, one multimodal LLM call receives:
  1. user task (context only)
  2. ONE rubric (id + requirement + verification)
  3. full action history (one line per step)
  4. every screenshot from the trajectory, chronological (``max_images=0`` → all)

System prompt and Thoughts:/Status: response format are copied from Odysseys.
Score is binary per rubric (1/0). Task passes only when every rubric succeeds
(``pass_threshold`` default 1.0 → perfect).
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Optional

# ---------------------------------------------------------------------------
# Odysseys-exact judge contract (do not paraphrase).
# Source: https://github.com/ljang0/Odysseys
#   scripts/python/run_full_trajectory_per_rubric.py
# ---------------------------------------------------------------------------

POLAR_METHOD = "polar"

FULL_TRAJ_JUDGMENT_SYSTEM = """You are an expert evaluator of web-navigation agent trajectories.

You will receive:
- The user task (for context).
- ONE specific rubric item with a requirement and a verification description.
- The agent's full action history (one line per step).
- Every screenshot from the trajectory, in chronological order.

Your goal is to decide whether this single rubric item is satisfied by the trajectory.

Evaluation rules:
- Judge ONLY the one rubric item you are given; ignore all other implicit requirements.
- Ground your judgment in what the screenshots and actions actually show. Do not invent state.
- Filtering / sorting / form requirements must be applied and confirmed to count as satisfied.
- If the agent was blocked (captcha, access denied, etc.) and therefore could not satisfy the rubric, report failure.

Respond in exactly this format:

Thoughts: <your reasoning, citing specific steps/screenshots>
Status: "success" or "failure"
"""

FINAL_JUDGMENT_MAX_COMPLETION_TOKENS = 8192
DEFAULT_MAX_IMAGES = 0  # 0 = unlimited (Odysseys default)

# Vision-capable Rose pool for the multimodal judge call. Protocol matches
# Odysseys; model identity is harness-local (Odysseys uses gemini-3.1-flash-lite).
POLAR_JUDGE_MODEL = "rose-labs/rose-1-ultra"

_STATUS_RE = re.compile(r'Status:\s*["\']?(success|failure)["\']?', re.IGNORECASE)
_THOUGHTS_RE = re.compile(r"Thoughts:\s*(.+?)(?:Status:|$)", re.DOTALL)

JudgeFn = Callable[..., Awaitable[str]]


def parse_polar_rubrics(evaluator: dict[str, Any]) -> list[dict[str, str]]:
    """Return Odysseys-shaped rubrics from a declared polar evaluator.

    Prefers ``evaluator["rubrics"]`` (``{id, requirement, verification}``).
    Falls back to synthesizing one rubric per ``criteria`` string so BU Bench
    entries (criteria-only) still go through the same per-item judge loop.
    """
    raw = evaluator.get("rubrics")
    rubrics: list[dict[str, str]] = []
    if isinstance(raw, list):
        for index, item in enumerate(raw):
            if not isinstance(item, dict):
                continue
            rubric_id = str(item.get("id") or f"R{index + 1}").strip()
            requirement = str(item.get("requirement") or "").strip()
            verification = str(item.get("verification") or "").strip()
            if rubric_id and requirement and verification:
                rubrics.append(
                    {
                        "id": rubric_id,
                        "requirement": requirement,
                        "verification": verification,
                    }
                )
    if rubrics:
        return rubrics

    criteria = evaluator.get("criteria") or []
    synthesized: list[dict[str, str]] = []
    for index, criterion in enumerate(criteria):
        text = str(criterion).strip()
        if not text:
            continue
        synthesized.append(
            {
                "id": f"C{index + 1}",
                "requirement": text,
                "verification": (
                    "Grader confirms the requirement from the trajectory's action "
                    "history and screenshots."
                ),
            }
        )
    return synthesized


def criteria_from_rubrics(rubrics: list[dict[str, Any]]) -> list[str]:
    """Catalog display criteria mirroring Odysseys rubrics (API still wants criteria[])."""
    out: list[str] = []
    for rubric in rubrics:
        if not isinstance(rubric, dict):
            continue
        rubric_id = str(rubric.get("id") or "").strip()
        requirement = str(rubric.get("requirement") or "").strip()
        verification = str(rubric.get("verification") or "").strip()
        if rubric_id and requirement and verification:
            out.append(f"{rubric_id}: {requirement} (verify: {verification})")
    return out


def _message_text(message: dict[str, Any]) -> str:
    for key in ("text", "message", "content"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            parts: list[str] = []
            for block in value:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(block, str):
                    parts.append(block)
            joined = "\n".join(parts).strip()
            if joined:
                return joined
    return ""


def _message_metadata(message: dict[str, Any]) -> dict[str, Any]:
    metadata = message.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _completion_card_text(metadata: dict[str, Any]) -> str:
    """Final answer of a finished ``completion_summary`` card, as the FE shows it.

    The workflow posts the user's final answer with empty message text and the
    content in ``metadata.completionSummary``; ``CompletionSummaryCard`` renders
    its ``summary`` and ``outputs``. Odysseys judges the agent's own response
    text per step, so this card is the final step's response.
    """
    card = metadata.get("completionSummary")
    if (
        metadata.get("toolName") != "completion_summary"
        or str(metadata.get("toolStatus") or "").upper() != "FINISHED"
        or not isinstance(card, dict)
    ):
        return ""
    lines: list[str] = []
    summary = str(card.get("summary") or "").strip()
    if summary:
        lines.append(summary)
    outputs = card.get("outputs")
    if isinstance(outputs, list):
        for output in outputs:
            if not isinstance(output, dict):
                continue
            label = str(output.get("label") or output.get("key") or "").strip()
            value = json.dumps(output.get("value"), ensure_ascii=False, default=str)
            lines.append(f"- {label}: {value}" if label else f"- {value}")
    return "\n".join(lines)


def _screenshot_from_message(message: dict[str, Any]) -> Optional[tuple[str, str]]:
    """Return (base64_payload, mime) if this message carries a screenshot."""
    metadata = _message_metadata(message)
    candidates = [metadata]
    aux = metadata.get("auxiliary")
    if isinstance(aux, dict):
        candidates.append(aux)

    for blob in candidates:
        for key in ("screenshot_b64", "screenshot", "image_b64"):
            value = blob.get(key)
            if isinstance(value, str) and value.strip():
                payload = value.strip()
                if payload.startswith("data:") and "," in payload:
                    header, payload = payload.split(",", 1)
                    mime = "image/png"
                    if ";" in header:
                        mime = header[5:].split(";")[0] or mime
                    return payload, mime
                mime = str(
                    blob.get("screenshot_media_type") or blob.get("media_type") or "image/png"
                )
                return payload, mime
    return None


def _iter_trajectory_messages(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten root + hydrated sub-agent messages in a stable order."""
    rows: list[dict[str, Any]] = []
    root = data.get("messages") or []
    if isinstance(root, list):
        rows.extend(message for message in root if isinstance(message, dict))

    # Key written by run_benchmark._hydrate_semantic_evaluator_tree — keep in sync.
    tree = data.get("_semantic_evaluator_tree")
    if isinstance(tree, dict):
        for agent_id in sorted(tree.keys()):
            info = tree.get(agent_id) or {}
            if not isinstance(info, dict):
                continue
            child_messages = info.get("messages") or []
            if isinstance(child_messages, list):
                rows.extend(message for message in child_messages if isinstance(message, dict))
    return rows


def build_polar_trajectory(
    data: dict[str, Any],
    *,
    max_images: int = DEFAULT_MAX_IMAGES,
) -> tuple[str, list[dict[str, str]]]:
    """Build Odysseys-style (action_history_text, screenshot_assets).

    ``screenshot_assets`` items: ``{"b64": ..., "mime": ...}``.
    ``max_images=0`` keeps every screenshot (Odysseys default).
    """
    history_lines: list[str] = []
    screenshots: list[dict[str, str]] = []
    step_number = 0

    for message in _iter_trajectory_messages(data):
        role = str(message.get("role") or "").upper()
        text = _message_text(message)
        metadata = _message_metadata(message)
        tool_name = str(
            metadata.get("toolName")
            or metadata.get("tool_name")
            or metadata.get("plannedToolName")
            or ""
        ).strip()
        tool_status = str(
            metadata.get("toolStatus") or metadata.get("tool_status") or ""
        ).strip()

        if role == "SYSTEM":
            continue

        shot = _screenshot_from_message(message)
        if shot is not None:
            screenshots.append({"b64": shot[0], "mime": shot[1]})

        parts: list[str] = []
        final_answer = _completion_card_text(metadata)
        if final_answer:
            parts.append(f"Response: {final_answer}")
        if role == "ASSISTANT" and text:
            parts.append(f"Response: {text}")
        if role in {"TOOL", "TOOL_RESULT"} or tool_name:
            action_bits = []
            if tool_name:
                action_bits.append(tool_name)
            if tool_status:
                action_bits.append(f"status={tool_status}")
            if text:
                clipped = text if len(text) <= 4000 else text[:4000] + "…"
                action_bits.append(clipped)
            if action_bits:
                parts.append("Action: " + " | ".join(action_bits))
        elif role == "USER" and text:
            parts.append(f"User: {text}")

        if not parts:
            continue
        step_number += 1
        history_lines.append(f"{step_number}. " + "\n".join(parts))

    action_history = "\n".join(history_lines) if history_lines else "No actions recorded."
    if max_images > 0 and len(screenshots) > max_images:
        screenshots = screenshots[-max_images:]
    return action_history, screenshots


def build_polar_user_text(
    *,
    task_prompt: str,
    rubric: dict[str, str],
    action_history: str,
    screenshot_count: int,
    step_count_hint: int,
) -> str:
    """User-turn text matching Odysseys' per-rubric prompt shape."""
    rubric_lines = [
        f"Rubric ID: {rubric.get('id', '?')}",
        f"Requirement: {str(rubric.get('requirement', '')).strip()}",
    ]
    verification = str(rubric.get("verification", "")).strip()
    if verification:
        rubric_lines.append(f"Verification: {verification}")
    return (
        f"User Task (context only): {task_prompt}\n\n"
        f"Evaluate ONLY this rubric item:\n"
        + "\n".join(rubric_lines)
        + f"\n\nFull Action History:\n{action_history}\n\n"
        f"Screenshots attached below: {screenshot_count} "
        f"(trajectory had {step_count_hint} total step(s)).\n\n"
        f"Decide whether the rubric ({rubric.get('id', '?')}) is satisfied. "
        "Use the required 'Thoughts:' / 'Status:' format."
    )


def parse_polar_judge_response(result_text: str) -> tuple[bool, str]:
    """Parse Odysseys Thoughts:/Status: response. Missing Status → failure."""
    text = (result_text or "").strip()
    status_match = _STATUS_RE.search(text)
    thoughts_match = _THOUGHTS_RE.search(text)
    success = bool(status_match and status_match.group(1).lower() == "success")
    reasoning = (
        thoughts_match.group(1).strip()
        if thoughts_match
        else (text or "Empty judge response.")
    )
    return success, reasoning


def _build_multimodal_messages(
    *,
    user_text: str,
    screenshots: list[dict[str, str]],
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for shot in screenshots:
        b64 = shot["b64"]
        mime = shot.get("mime") or "image/png"
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"},
            }
        )
    return [
        {"role": "system", "content": FULL_TRAJ_JUDGMENT_SYSTEM},
        {"role": "user", "content": content},
    ]


async def _default_judge_llm(messages: list[dict[str, Any]], **kwargs: Any) -> str:
    """Rose multimodal completion used in production polar grading."""
    from helpers.llm import call_llm

    result = await call_llm(
        messages=messages,
        model=kwargs.get("model") or POLAR_JUDGE_MODEL,
        temperature=0.0,
        max_tokens=FINAL_JUDGMENT_MAX_COMPLETION_TOKENS,
        call_site="polar_evaluator",
        agent_id=kwargs.get("agent_id"),
    )
    content = result.get("content") if isinstance(result, dict) else None
    if isinstance(content, str):
        return content
    return str(content or "")


async def judge_one_polar_rubric(
    *,
    task_prompt: str,
    rubric: dict[str, str],
    action_history: str,
    screenshots: list[dict[str, str]],
    step_count_hint: int,
    judge_llm: Optional[JudgeFn] = None,
    agent_id: Optional[str] = None,
    model: Optional[str] = None,
) -> dict[str, Any]:
    """Run one Odysseys-faithful per-rubric judgment."""
    user_text = build_polar_user_text(
        task_prompt=task_prompt,
        rubric=rubric,
        action_history=action_history,
        screenshot_count=len(screenshots),
        step_count_hint=step_count_hint,
    )
    messages = _build_multimodal_messages(user_text=user_text, screenshots=screenshots)
    llm = judge_llm or _default_judge_llm
    try:
        result_text = await llm(messages, agent_id=agent_id, model=model)
        success, reasoning = parse_polar_judge_response(result_text)
    except Exception as exc:
        # Broad catch matches Odysseys: any judge failure → rubric score 0.
        success, reasoning = False, f"Error judging rubric {rubric.get('id', '?')}: {exc}"
    return {
        "rubric_id": rubric.get("id", "?"),
        "requirement": rubric.get("requirement", ""),
        "verification": rubric.get("verification", ""),
        "score": 1 if success else 0,
        "success": success,
        "final_reasoning": reasoning,
    }


async def run_polar_evaluator(
    *,
    task_prompt: str,
    evaluator: dict[str, Any],
    data: dict[str, Any],
    judge_llm: Optional[JudgeFn] = None,
    max_images: int = DEFAULT_MAX_IMAGES,
    model: Optional[str] = None,
) -> dict[str, Any]:
    """Grade a completed agent run with the polar (Odysseys-spec) evaluator.

    Returns a dict compatible with declared-evaluator consumers:
      score (float 0..1 average), reasoning (str), usage (None),
      plus polar-specific ``rubric_results`` / ``perfect``.
    """
    rubrics = parse_polar_rubrics(evaluator)
    if not rubrics:
        return {
            "score": 0.0,
            "reasoning": "polar evaluator: no rubrics/criteria to judge",
            "usage": None,
            "rubric_results": [],
            "perfect": False,
        }

    action_history, screenshots = build_polar_trajectory(data, max_images=max_images)
    step_count_hint = action_history.count("\n") + (
        1 if action_history and action_history != "No actions recorded." else 0
    )
    agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
    agent_id = str(agent.get("agent_id") or agent.get("id") or "") or None

    rubric_results: list[dict[str, Any]] = []
    for rubric in rubrics:
        rubric_results.append(
            await judge_one_polar_rubric(
                task_prompt=task_prompt,
                rubric=rubric,
                action_history=action_history,
                screenshots=screenshots,
                step_count_hint=step_count_hint,
                judge_llm=judge_llm,
                agent_id=agent_id,
                model=model,
            )
        )

    scores = [int(item["score"]) for item in rubric_results]
    average = sum(scores) / len(scores) if scores else 0.0
    perfect = bool(scores) and all(score == 1 for score in scores)
    failed = [item for item in rubric_results if not item["success"]]
    if perfect:
        reasoning = (
            f"All {len(scores)} polar rubrics satisfied "
            f"(screenshots={len(screenshots)})."
        )
    else:
        first = failed[0] if failed else None
        detail = (
            f"{first['rubric_id']}: {first['final_reasoning']}"
            if first
            else "one or more rubrics failed"
        )
        reasoning = (
            f"polar perfect-score failed ({sum(scores)}/{len(scores)} rubrics). "
            f"First failure — {detail}"
        )

    return {
        "score": average,
        "reasoning": reasoning,
        "usage": None,
        "rubric_results": rubric_results,
        "perfect": perfect,
        "num_screenshots_sent": len(screenshots),
        "action_history_chars": len(action_history),
    }


def dump_polar_debug_bundle(result: dict[str, Any]) -> str:
    """Compact JSON for logs / declared_evaluator_results extras."""
    return json.dumps(
        {
            "perfect": result.get("perfect"),
            "score": result.get("score"),
            "num_screenshots_sent": result.get("num_screenshots_sent"),
            "rubric_scores": {
                item.get("rubric_id"): item.get("score")
                for item in (result.get("rubric_results") or [])
                if isinstance(item, dict)
            },
        },
        sort_keys=True,
    )
