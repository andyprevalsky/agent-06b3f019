"""Benchmark task definitions loaded from tasks.json."""

import json
import os
from dataclasses import dataclass, field
from typing import List, Optional

from benchmarks.fixtures import DEFAULT_BASE_IMAGE
from benchmarks.live_fixtures import resolve_live_fixtures


@dataclass
class BenchmarkTask:
    name: str
    title: str
    prompt: str
    timeout_seconds: int
    is_chat_mode: bool
    expected_tools: List[str]
    tags: List[str]
    price_limit_cents: int
    requires_browser_agent: bool
    requires_claude_code: bool
    attachment: Optional[str]
    approval_handling: Optional[str]  # "auto_approve", "ignore", "prompt_user", "count_only", or None
    start_phase: Optional[str]  # "plan", "execute", or None (chat mode)
    attachments: List[str] = field(default_factory=list)  # Multiple attachments (alternative to single attachment)
    row_start: Optional[int] = None  # Slice CSV attachments starting at this 1-indexed data row
    row_end: Optional[int] = None    # Slice CSV attachments ending at this 1-indexed data row (inclusive)
    expected_approval_count: Optional[int] = None  # Exact number of approvals expected (used with count_only)
    expected_attention_kind: Optional[str] = None  # metadata.attentionKind expected for approval-style tasks
    expected_attention_kinds: List[str] = field(default_factory=list)  # Allowed terminal attention kinds for flows with multiple valid checkout gates
    agentcard_setup_action: Optional[str] = None  # Benchmark user action for hosted setup (for example, complete)
    expected_credential_ref_kind: Optional[str] = None  # credential_ref.kind that must be observed before terminal success
    forbidden_credential_ref_kinds: List[str] = field(default_factory=list)  # credential paths that invalidate the run
    expected_browser_provider: Optional[str] = None  # browser_session_metadata.provider required for provider-specific probes
    expected_browser_session_metadata_values: Optional[dict] = None  # exact session/injection metadata required for isolation probes
    expected_pre_credential_message_contains: List[str] = field(default_factory=list)  # evidence required before credential use
    expected_post_credential_message_contains: List[str] = field(default_factory=list)  # authenticated evidence required after use
    success_on_browser_auth_evidence: bool = False  # stop once ordered browser-auth evidence is durable
    expected_structured_response_values: Optional[dict] = None  # exact browser result fields required for success
    expected_structured_response_contains: Optional[dict] = None  # required substrings by browser result field
    required_structured_response_fields: List[str] = field(default_factory=list)  # non-empty browser result fields
    expected_gate: Optional[dict] = None  # Expected metadata.gate fields for gate-blocked tasks
    min_agent_count: Optional[int] = None  # Minimum total agents in tree (root + sub-agents)
    expected_tool_counts: Optional[dict] = None  # Exact tool call counts (toolName → count)
    min_tool_counts: Optional[dict] = None  # Minimum tool call counts (toolName → min count)
    tool_count_scope: str = "tree"  # "tree" counts all descendants; "root" counts root-visible tool calls only
    forbidden_tools: List[str] = field(default_factory=list)  # Tool names that must not be called
    sub_agent_count: Optional[int] = None  # Default fan-out for load-test style tasks; substitutes {n} in prompt
    expected_payment_receipt: Optional[dict] = None  # Expected request_payment_card approval receipt metadata
    expected_payment_lifecycle: Optional[dict] = None  # Expected post-checkout state across purchase, Stripe, and AgentCard
    success_on_payment_card_request: bool = False  # Treat a validated payment-card request as terminal success
    payment_card_request_action: Optional[str] = None  # Benchmark lifecycle action after card issuance (for example, abandon)
    production_only: bool = False  # Refuse to run against a local/sandbox backend
    response_schema: Optional[dict] = None  # Explicit root verifier contract when prompt inference is ambiguous
    phone_persona: Optional[dict] = None  # Vapi callee persona (system_prompt, first_message, structured_data_schema)
    pinned_facts: Optional[dict] = None  # Ground-truth facts fixed before the run and cross-validated afterward
    expected_call_findings: List[str] = field(default_factory=list)  # Substrings the agent must report after the call
    expected_final_findings: List[str] = field(default_factory=list)  # Substrings that must appear in returned final data
    callee_checks: Optional[dict] = None  # Expected callee-side analysis.structuredData values (persona's view)
    # --- Unified eval-catalog contract (additive; validated by benchmarks/long_horizon.py) ---
    status: str = "ready"  # "ready" = runnable end-to-end today; "incomplete" = missing fixtures/judge runner, excluded from suite runs
    runner: str = "agent"  # "agent" = run_benchmark.py creates a real benchmark agent
    bench: str = "pipeline-e2e"  # "pipeline-e2e" = harness plumbing works (write locks, cookie inject, tool pipes); "rose-bench" = harness-independent capability (fixture + prompt + eval portable to any harness)
    world_model_mode: Optional[str] = None  # "real" = sim off, "simulate" = WMH boundaries, "shadow" = live + WMH compare
    description: Optional[str] = None  # One-line summary served to the FE test-prompts picker (falls back to title)
    environment: Optional[dict] = None  # {mode, db_fixtures, base_images, services, secrets, live_targets, context_notes}
    evaluators: List[dict] = field(default_factory=list)  # Declared evaluator contract (static_check | single_turn_llm_judge | agentic_llm_judge)
    enforce_declared_evaluators: bool = False  # Execute evaluators[] and require them to pass in run_benchmark.py
    source: List[str] = field(default_factory=list)  # Provenance pointers (origin task/test-prompt/smoke/agent_id)
    group: Optional[str] = None  # Benchmarks-page group label the UI groups off (canonical tokens: pre-deploy | daily | rose-bench | incomplete). Absent → backend derives from status/tags/bench.
    human_time: Optional[str] = None  # Approximate human-equivalent time for capability/complexity bucketing
    world_surface: Optional[str] = None  # "live" or "simulated"; binary world-model surface, independent of DB fixtures
    fast_cache: Optional[str] = None  # "on" or "off" for the intended benchmark run mode
    anti_bot: Optional[str] = None  # "yes" or "no"; daily reporting can aggregate Anti-Bot score
    label_eval: Optional[str] = None  # Human-readable summary of the benchmark pass condition
    label_notes: Optional[str] = None  # Human-readable cleanup/review notes
    mid_run_feedback: Optional[dict] = None  # Live USER message injected after a durable root-message boundary
    expected_browser_provider: Optional[str] = None
    expected_credential_ref_kind: Optional[str] = None
    forbidden_credential_ref_kinds: List[str] = field(default_factory=list)
    success_on_browser_auth_evidence: bool = False
    expected_browser_session_metadata_values: Optional[dict] = None
    expected_pre_credential_message_contains: List[str] = field(default_factory=list)
    expected_post_credential_message_contains: List[str] = field(default_factory=list)


_TASKS_FILE = os.path.join(os.path.dirname(__file__), "tasks.json")


# Smoke test timeout caps — keep these as low as practical.
# If smoke tests hit these limits, diagnose and fix the bottleneck first;
# only raise limits when the underlying latency is genuinely irreducible.
SMOKE_TIMEOUT_CAPS: dict[str, int] = {
    "chat-mode": 120,
    # spawn-sub-agents + parallel-tool-calls: real-workload tasks that fan out
    # to multiple web-research agents and may do a final synthesis pass. Keep
    # bounded caps, but leave enough room for recent p95 * 1.5 so valid passing
    # runs can extend the dynamic history instead of timing out at the ceiling.
    "spawn-sub-agents": 480,
    "parallel-tool-calls": 600,
    "message-person": 180,
    "claude-code-agent": 300,
    "browser-smoke": 300,
    "browser-biometrics-webdecoy": 420,
}


TASK_TIMEOUT_FLOORS: dict[str, int] = {
    # This batch intentionally does upfront outreach research before spawning
    # 40 row agents. Historical local passes are from older, narrower task
    # shapes, so do not let the dynamic cap collapse below this floor.
    "outreach-batch": 600,
    # Mass-agent fanout is intentionally wide and prod can legitimately need
    # more than the older dynamic history cap while children finish.
    "test-mass-agent-run-0": 900,
}


def get_smoke_cap(name: str) -> int | None:
    """Return the hard timeout cap for a smoke task, or None if not a smoke task."""
    return SMOKE_TIMEOUT_CAPS.get(name)


def get_timeout_floor(name: str) -> int | None:
    """Return the minimum dynamic timeout for a task, if it needs one."""
    return TASK_TIMEOUT_FLOORS.get(name)


def _default_environment() -> dict:
    """Effective environment for tasks that don't declare one.

    Every eval runs on top of a base image — the workspace Victoria DB synced
    from prod (scripts/setup-db.sh) — so all tasks have a reproducible starting
    state by default. Tasks override this by declaring `environment` in
    tasks.json; declared environments with empty base_images also inherit the
    default base image.
    """
    return {
        "mode": "live",
        "db_fixtures": [],
        "base_images": [DEFAULT_BASE_IMAGE],
        "live_fixtures": [],
        "services": [],
        "secrets": [],
        "live_targets": [],
        "context_notes": (
            "Default environment: workspace base-image DB (prod sync via "
            "scripts/setup-db.sh) + live third-party services. Expiring "
            "credentials are added only by an explicit live fixture."
        ),
    }


def _load_tasks() -> List[BenchmarkTask]:
    with open(_TASKS_FILE) as f:
        raw = json.load(f)
    tasks = [BenchmarkTask(**t) for t in raw]
    for t in tasks:
        if t.environment is None:
            t.environment = _default_environment()
        else:
            if not t.environment.get("base_images"):
                t.environment["base_images"] = [DEFAULT_BASE_IMAGE]
            # Expiring production credentials are opt-in. Do not make every
            # live-world task mutate its DB merely because it uses a live URL.
            if t.environment.get("live_fixtures") is None:
                t.environment["live_fixtures"] = resolve_live_fixtures(t.environment)
        if t.sub_agent_count is not None:
            apply_sub_agent_count(t, t.sub_agent_count)
        if t.name in SMOKE_TIMEOUT_CAPS:
            cap = SMOKE_TIMEOUT_CAPS[t.name]
            if t.timeout_seconds > cap:
                raise ValueError(
                    f"Smoke test '{t.name}' timeout_seconds={t.timeout_seconds} exceeds "
                    f"immutable cap of {cap}s. Do NOT increase the timeout — speed up "
                    f"the underlying code instead."
                )
    return tasks


def apply_sub_agent_count(task: BenchmarkTask, n: int) -> None:
    """Substitute count placeholders in prompt with the chosen count.

    Caches the original templates on the task so repeat calls (e.g. CLI override
    after JSON load already substituted) work correctly.
    """
    prompt_tpl = getattr(task, "_prompt_template", None) or task.prompt
    expected_sum = sum((i * i) + (i * 3) + 7 for i in range(1, n + 1))
    task._prompt_template = prompt_tpl
    task.sub_agent_count = n
    task.prompt = prompt_tpl.replace("{n}", str(n)).replace("{expected_sum}", str(expected_sum))


_cached_tasks: Optional[List[BenchmarkTask]] = None


def all_tasks() -> List[BenchmarkTask]:
    global _cached_tasks
    if _cached_tasks is None:
        _cached_tasks = _load_tasks()
    return _cached_tasks


def suite_tasks() -> List[BenchmarkTask]:
    """Tasks eligible for suite runs: benchmark entries whose eval contract is complete.

    `status == "incomplete"` entries (missing fixtures/judge runner) are excluded
    from suite runs. Explicit `--task <name>` selection bypasses this filter for
    dev iteration.
    """
    return [t for t in all_tasks() if t.status == "ready" and not t.production_only]


def get_task_by_name(name: str) -> BenchmarkTask:
    for t in all_tasks():
        if t.name == name:
            return t
    raise ValueError(f"Unknown benchmark task: {name}")


def get_tasks_by_tag(tag: str) -> List[BenchmarkTask]:
    aliases = {
        "attachments": "attachment",
        "code-agent": "claude-code",
        "sub-agent-fan-out": "mass-agent",
    }
    normalized = aliases.get(tag, tag)
    return [t for t in all_tasks() if normalized in t.tags]


def list_all_tasks() -> None:
    for t in all_tasks():
        tags = ", ".join(t.tags)
        all_attach = t.attachments or ([t.attachment] if t.attachment else [])
        attach = f" [attachments: {', '.join(all_attach)}]" if all_attach else ""
        approval = f" [approval: {t.approval_handling}]" if t.approval_handling else ""
        rows = f" [rows: {t.row_start}-{t.row_end}]" if t.row_start is not None else ""
        lifecycle = "" if t.status == "ready" else f" [{t.status}]"
        print(f"  {t.name:<25} {t.title:<35} tags=[{tags}]{attach}{approval}{rows}{lifecycle}")
