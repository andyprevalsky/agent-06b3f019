"""Benchmark task definitions loaded from tasks.json."""

import json
import os
from dataclasses import dataclass, field
from typing import List, Optional

from benchmarks.fixtures import DEFAULT_BASE_IMAGE
from benchmarks.live_fixtures import resolve_live_fixtures
from benchmarks.polar_catalog import (
    POLAR_TAG,
    is_polar_bench_task,
    load_polar_tasks_file,
)

# Runners run_benchmark.py can dispatch directly. "agent" drives the Temporal
# agent workflow; "sms" drives the in-backend SMS supervisor through an inbound
# Surge webhook (benchmarks/sms_runner.py). Suite selection filters on this.
RUNNABLE_TASK_RUNNERS = {"agent", "sms"}

DEFAULT_MIN_STEPS_BY_AGENT_CLASS: dict[str, int] = {"browser": 5}


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
    no_anthropic_price_limit_cents: Optional[int] = None  # Alternate cap for the funded non-Anthropic route
    browser_profile_mode: str = "persistent"  # "persistent" or isolated "fresh" browser state
    browser_auth_realm: Optional[str] = None  # Realm whose saved auth is isolated for fresh mode
    attachments: List[str] = field(default_factory=list)  # Multiple attachments (alternative to single attachment)
    row_start: Optional[int] = None  # Slice CSV attachments starting at this 1-indexed data row
    row_end: Optional[int] = None  # Slice CSV attachments ending at this 1-indexed data row (inclusive)
    expected_approval_count: Optional[int] = None  # Exact number of approvals expected (used with count_only)
    expected_attention_kind: Optional[str] = None  # metadata.attentionKind expected for approval-style tasks
    expected_attention_kinds: List[str] = field(default_factory=list)  # Allowed terminal attention kinds for flows with multiple valid checkout gates
    require_attention_order: bool = False  # Require expected_attention_kinds in exact arrival order
    expected_attention_kind_any_of: List[str] = field(default_factory=list)  # Exactly one approval whose kind is in this set
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
    simulate_gate_webhook: Optional[str] = None  # After gate is seen, replay webhook (e.g. subscription)
    complete_subscription_checkout: bool = False  # Complete real Stripe test Checkout before resuming
    min_agent_count: Optional[int] = None  # Minimum total agents in tree (root + sub-agents)
    min_steps: dict[str, int] = field(default_factory=dict)  # Per-instance trajectory minimums by agent class
    max_steps: dict[str, int] = field(default_factory=dict)  # Per-instance trajectory maximums by agent class
    expected_tool_counts: Optional[dict] = None  # Exact tool call counts (toolName → count)
    min_tool_counts: Optional[dict] = None  # Minimum tool call counts (toolName → min count)
    tool_count_scope: str = "tree"  # "tree" counts all descendants; "root" counts root-visible tool calls only
    forbidden_tools: List[str] = field(default_factory=list)  # Tool names that must not be called
    sub_agent_count: Optional[int] = None  # Default fan-out for load-test style tasks; substitutes {n} in prompt
    expected_payment_receipt: Optional[dict | bool] = None  # Expected request_payment_card approval receipt metadata (`true` = any well-formed receipt)
    expected_payment_lifecycle: Optional[dict] = None  # Expected post-checkout state across purchase, Stripe, and AgentCard
    success_on_payment_card_request: bool = False  # Treat a validated payment-card request as terminal success
    payment_card_request_action: Optional[str] = None  # Benchmark lifecycle action after card issuance (for example, abandon)
    production_only: bool = False  # Refuse to run against a local/sandbox backend
    # When True, harness closes leftover HELD $1 lifecycle-probe cards for the
    # prod lifecycle user before create_agent so lookup cannot skip payment_approval.
    # Only agent-payment-production-purchase sets this; other Stripe reuse tests stay enabled.
    disable_purchase_reuse: bool = False
    response_schema: Optional[dict] = None  # Explicit root verifier contract when prompt inference is ambiguous
    phone_persona: Optional[dict] = None  # Vapi callee persona (system_prompt, first_message, structured_data_schema)
    pinned_facts: Optional[dict] = None  # Ground-truth facts fixed before the run and cross-validated afterward
    expected_call_findings: List[str] = field(default_factory=list)  # Substrings the agent must report after the call
    expected_final_findings: List[str] = field(default_factory=list)  # Substrings that must appear in returned final data
    callee_checks: Optional[dict] = None  # Expected callee-side analysis.structuredData values (persona's view)
    # --- Unified eval-catalog contract (additive; validated by benchmarks/long_horizon.py) ---
    status: str = "ready"  # "ready" = runnable end-to-end today; "incomplete" = missing fixtures/judge runner, excluded from suite runs
    runner: str = "agent"  # "agent" = run_benchmark.py creates a real benchmark agent
    harness: str = "rose"  # "rose" = Temporal Rose workflow; "codex" = Codex E2B orchestrator via codex_runner.py
    bench: str = "pipeline-e2e"  # "pipeline-e2e" = harness plumbing works (write locks, cookie inject, tool pipes); "rose-bench" = harness-independent capability (fixture + prompt + eval portable to any harness)
    world_model_mode: Optional[str] = None  # "real" = sim off, "simulate" = WMH boundaries, "shadow" = live + WMH compare
    wmh_initial_state: Optional[dict] = None  # WHM EnvState for this simulated scenario; never copied from the live fixture
    description: Optional[str] = None  # One-line summary served to the FE test-prompts picker (falls back to title)
    environment: Optional[dict] = None  # {mode, db_fixtures, base_images, services, secrets, live_targets, context_notes}
    project: Optional[str] = None  # Name of the benchmark user's Project the root agent is created in (its repo is attached to code agents); resolved via GET /api/projects
    context_gates: Optional[dict] = None  # Per-task user-context gates (helpers/get_user_context.py keys → bool), forwarded at agent creation
    model: Optional[str] = None  # Pin the ROOT agent to one Rose pool (e.g. 'rose-labs/rose-1-oss'). Only for tasks whose prompt a default-pool primary declines; forwarded at agent creation.
    evaluators: List[dict] = field(default_factory=list)  # Declared evaluator contract (static_check | single_turn_llm_judge | agentic_llm_judge | polar)
    process_spec: Optional[dict] = None  # Authored Process Bench obligations; evaluators are generated and drift-checked
    enforce_declared_evaluators: bool = False  # Execute evaluators[] and require them to pass in run_benchmark.py
    run_all_evaluators: bool = False  # With enforce_declared_evaluators: run EVERY evaluator and report every verdict (no stop at the first failure), including for a failed or timed-out run (static checks only)
    source: List[str] = field(default_factory=list)  # Provenance pointers (origin task/test-prompt/smoke/agent_id)
    group: Optional[str] = None  # Benchmarks-page group label the UI groups off (canonical tokens: pre-deploy | daily | rose-bench | polar-bench | incomplete). Absent → backend derives from status/tags/bench.
    human_time: Optional[str] = None  # Approximate human-equivalent time for capability/complexity bucketing
    world_surface: Optional[str] = None  # "live" or "simulated"; binary world-model surface, independent of DB fixtures
    demo_cache: Optional[str] = None  # "on" or "off" for the intended benchmark run mode
    memory: Optional[str] = None  # Planner memory: "on" forks get_memories into the planner; "off"/None = off (default off)
    success_on_plan: bool = False  # Plan-phase A/B: terminal success once set_plan lands (plan_shape checks run on the plan)
    anti_bot: Optional[str] = None  # "yes" or "no"; daily reporting can aggregate Anti-Bot score
    label_eval: Optional[str] = None  # Human-readable summary of the benchmark pass condition
    label_notes: Optional[str] = None  # Human-readable cleanup/review notes
    mid_run_feedback: Optional[dict] = None  # Live USER message injected after a durable root-message boundary
    # runner="sms" only. Scripted inbound-SMS thread plus the agent state it runs
    # against: {seed_agents: [{goal, status, progress}], turns: [{inbound,
    # max_outbound, min_outbound}], settle_seconds,
    # turn_timeout_seconds}. Validated by benchmarks/sms_runner.py:parse_sms_script.
    sms_script: Optional[dict] = None
    expected_browser_provider: Optional[str] = None
    expected_credential_ref_kind: Optional[str] = None
    forbidden_credential_ref_kinds: List[str] = field(default_factory=list)
    success_on_browser_auth_evidence: bool = False
    expected_browser_session_metadata_values: Optional[dict] = None
    expected_pre_credential_message_contains: List[str] = field(default_factory=list)
    expected_post_credential_message_contains: List[str] = field(default_factory=list)
    # Pre-deploy selection metadata (additive; ignored by the runtime runner).
    # `select_predeploy_benches.py` reads these from tasks.json; keep them on the
    # dataclass so catalog load does not reject the fields.
    deploy_category: Optional[str] = None
    deploy_canary: bool = False
    # Explicit exclusion from deploy selection; manual benchmark execution remains available.
    deploy_quarantine: Optional[str] = None
    # Deploy quarantine marker {since, repair, error, evidence} (long_horizon.validate_task_quarantine):
    # the task still runs; deploy smoke reports its failure as non-blocking QUARANTINED_FAIL.
    quarantine: Optional[dict] = None

    def __post_init__(self) -> None:
        # The catalog may list several files under "attachment"; keep the
        # single-file field a path and carry the list as attachments, which
        # every consumer already supports.
        if isinstance(self.attachment, list):
            self.attachments = [*self.attachments, *self.attachment]
            self.attachment = None

    def effective_price_limit_cents(self) -> int:
        """Return the route-aware cap without weakening the default eval."""
        exclude_anthropic = os.getenv("ROSE_EXCLUDE_ANTHROPIC_FAMILY", "").strip().lower()
        if exclude_anthropic in {"1", "true", "yes", "on"} and self.no_anthropic_price_limit_cents is not None:
            return self.no_anthropic_price_limit_cents
        return self.price_limit_cents


_TASKS_FILE = os.path.join(os.path.dirname(__file__), "tasks.json")


# Smoke test timeout caps — keep these as low as practical.
# If smoke tests hit these limits, diagnose and fix the bottleneck first;
# only raise limits when the underlying latency is genuinely irreducible.
SMOKE_TIMEOUT_CAPS: dict[str, int] = {
    "chat-mode": 120,
    "background-agent-message-smoke": 180,
    # spawn-sub-agents + parallel-tool-calls: real-workload tasks that fan out
    # to multiple web-research agents and may do a final synthesis pass. Keep
    # bounded caps, but leave enough room for recent p95 * 1.5 so valid passing
    # runs can extend the dynamic history instead of timing out at the ceiling.
    "spawn-sub-agents": 480,
    "parallel-tool-calls": 600,
    "message-person": 180,
    "claude-code-agent": 300,
    "browser-smoke": 450,
    "browser-biometrics-webdecoy": 420,
    "test-mass-agent-run-0": 600,
}


TASK_TIMEOUT_FLOORS: dict[str, int] = {
    # Real 2h45m hold plus the post-hold credit conversation. History p95
    # would otherwise clamp to CEIL_SECONDS (900) after the first pass and
    # kill the next run mid-hold.
    "phone-call-hold-queue": 12600,
    # Live palette trials took 175-397s with browser recordings and verifier
    # retries; old single-heading task history understates the needed time.
    "browser-smoke": 450,
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
        "memory_fixtures": [],
        "services": [],
        "secrets": [],
        "live_targets": [],
        "context_notes": (
            "Default environment: workspace base-image DB (prod sync via "
            "scripts/setup-db.sh) + live third-party services. Expiring "
            "credentials are added only by an explicit live fixture."
        ),
    }


def normalize_legacy_catalog_fields(item: dict) -> dict:
    """Accept the legacy ``fast_cache`` catalog field as ``demo_cache``.

    The field was renamed to ``demo_cache`` (DEMO cache) on 2026-10-23; older
    catalogs and checkouts still spell it ``fast_cache``.
    """
    if "fast_cache" not in item:
        return item
    legacy = item["fast_cache"]
    if "demo_cache" in item and item["demo_cache"] != legacy:
        raise ValueError(
            f"Benchmark task {item.get('name')!r} sets both demo_cache={item['demo_cache']!r} "
            f"and legacy fast_cache={legacy!r}"
        )
    normalized = {key: value for key, value in item.items() if key != "fast_cache"}
    normalized["demo_cache"] = legacy
    return normalized


def _load_tasks() -> List[BenchmarkTask]:
    with open(_TASKS_FILE) as f:
        raw = json.load(f)
    if not isinstance(raw, list):
        raise ValueError(f"{_TASKS_FILE} must contain a JSON array of tasks")
    # Polar Odysseys + BU Bench V1 ship as polar_tasks.json (built from
    # agents/benchmarks/polar/*.json). group/tag = polar-bench, never daily.
    polar_raw = load_polar_tasks_file()
    base_names = {t["name"] for t in raw if isinstance(t, dict) and "name" in t}
    overlap = sorted(base_names & {t["name"] for t in polar_raw})
    if overlap:
        raise ValueError(f"polar catalog name collision with tasks.json: {overlap[:5]}")
    from benchmarks.process_bench import validate_task_process

    for item in raw:
        validate_task_process(item)
    tasks = [BenchmarkTask(**normalize_legacy_catalog_fields(t)) for t in [*raw, *polar_raw]]
    for t in tasks:
        if t.browser_profile_mode not in {"persistent", "fresh"}:
            raise ValueError(
                f"Benchmark task '{t.name}' has invalid browser_profile_mode={t.browser_profile_mode!r}"
            )
        if t.browser_profile_mode == "fresh":
            if not t.requires_browser_agent:
                raise ValueError(f"Benchmark task '{t.name}' requests fresh browser state without a browser agent")
            if not t.browser_auth_realm:
                raise ValueError(f"Benchmark task '{t.name}' requests fresh browser state without browser_auth_realm")
        if is_polar_bench_task(t):
            # Polar grades the requested outcome, independent of retrieval tools.
            t.expected_tools = []
            t.requires_browser_agent = False
            t.min_tool_counts = None
            t.expected_tool_counts = None
            t.forbidden_tools = []
            t.min_steps = {}
            if t.start_phase == "browser":
                t.start_phase = "execute"
        t.min_steps = dict(t.min_steps)
        t.max_steps = dict(t.max_steps)
        if t.requires_browser_agent and not is_polar_bench_task(t) and "browser" not in t.min_steps:
            t.min_steps["browser"] = DEFAULT_MIN_STEPS_BY_AGENT_CLASS["browser"]
        if t.environment is None:
            t.environment = _default_environment()
        else:
            if not t.environment.get("base_images"):
                t.environment["base_images"] = [DEFAULT_BASE_IMAGE]
            # Expiring production credentials are opt-in. Do not make every
            # live-world task mutate its DB merely because it uses a live URL.
            if t.environment.get("live_fixtures") is None:
                t.environment["live_fixtures"] = resolve_live_fixtures(t.environment)
            if t.environment.get("memory_fixtures") is None:
                t.environment["memory_fixtures"] = []
        if t.memory not in (None, "on", "off"):
            raise ValueError(f"Benchmark task '{t.name}' has invalid memory={t.memory!r} (expected 'on' or 'off')")
        if t.environment.get("memory_fixtures") and t.memory != "on":
            raise ValueError(f"Benchmark task '{t.name}' declares memory_fixtures but memory is not 'on'")
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


def suite_tasks(*, include_polar: bool = False) -> List[BenchmarkTask]:
    """Tasks eligible for suite runs: benchmark entries whose eval contract is complete.

    `status == "incomplete"` entries (missing fixtures/judge runner) are excluded
    from suite runs. Explicit `--task <name>` selection bypasses this filter for
    dev iteration. Polar-bench (Odysseys + BU Bench V1) is opt-in via
    `--suite polar-bench` so `--suite all` does not fan out ~300 live browser tasks.
    """
    tasks = [t for t in all_tasks() if t.status == "ready" and not t.production_only]
    if include_polar:
        return tasks
    return [t for t in tasks if not is_polar_bench_task(t)]


def get_task_by_name(name: str) -> BenchmarkTask:
    for t in all_tasks():
        if t.name == name:
            return t
    raise ValueError(f"Unknown benchmark task: {name}")


def selected_tasks_require_gate_type(task_names: List[str], gate_type: str) -> bool:
    """Return whether any selected task canonically expects the given gate type."""
    selected = set(task_names)
    return any(
        task.name in selected
        and isinstance(task.expected_gate, dict)
        and task.expected_gate.get("type") == gate_type
        for task in all_tasks()
    )


def get_tasks_by_tag(tag: str) -> List[BenchmarkTask]:
    aliases = {
        "process-bench": "process",
        "attachments": "attachment",
        "code-agent": "claude-code",
        "sub-agent-fan-out": "mass-agent",
    }
    normalized = aliases.get(tag, tag)
    tasks = [t for t in all_tasks() if normalized in t.tags]
    # polar-bench is its own suite slice; other tag suites (browser, auth, …)
    # stay on the first-party catalog so they are not flooded by Odysseys/BU.
    if normalized == POLAR_TAG:
        return tasks
    return [t for t in tasks if not is_polar_bench_task(t)]


def list_all_tasks() -> None:
    for t in all_tasks():
        tags = ", ".join(t.tags)
        all_attach = t.attachments or ([t.attachment] if t.attachment else [])
        attach = f" [attachments: {', '.join(all_attach)}]" if all_attach else ""
        approval = f" [approval: {t.approval_handling}]" if t.approval_handling else ""
        rows = f" [rows: {t.row_start}-{t.row_end}]" if t.row_start is not None else ""
        lifecycle = "" if t.status == "ready" else f" [{t.status}]"
        print(f"  {t.name:<25} {t.title:<35} tags=[{tags}]{attach}{approval}{rows}{lifecycle}")
