"""SMS-supervisor benchmark runner.

Every other benchmark drives the Temporal agent workflow through
``POST /api/agents``. The SMS supervisor is a different surface entirely: it is
an in-backend tool loop that wakes on an inbound text and answers over SMS. This
module drives that surface end to end with **no mocking of the supervisor** —
real inbound webhook, real context build, real LLM, real tool loop, real
``send_user_message`` delivery. Only the Surge transport is intercepted, by the
benchmark stack's existing capture harness (``BLACKBOX_TEST_FAKE_SURGE=1``), so
a benchmark never texts a human being.

What it measures is *trajectory stability*: for one inbound SMS, how many texts
does the user get back, do they repeat themselves, and do they say anything.
That is the failure class this runner exists for — see the 2026-07-27 incident
where a single "Let the agent work" produced eight consecutive
"Acknowledged. I am monitoring active agents…" texts.

Local-only by construction: on a production base URL the outbound Surge
interception is not active and a run would text a real phone.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import aiohttp

from benchmarks.benchmark_tasks import BenchmarkTask
from benchmarks.results import TaskResult

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# Poll cadence while waiting for a turn's outbound texts to land.
POLL_INTERVAL_SECONDS = 1.5
# A turn is finished once the transcript has been quiet this long. Must exceed a
# supervisor round-trip (~4-6s in prod) so a run that IS spamming gets counted in
# full rather than truncated into a false pass.
DEFAULT_SETTLE_SECONDS = 16.0
DEFAULT_TURN_TIMEOUT_SECONDS = 120.0
# Default per-inbound outbound budget asserted when a turn doesn't set its own.
DEFAULT_MAX_OUTBOUND = 2

SMS_STATIC_CHECK_TYPES = {
    "sms_outbound_budget",
    "sms_no_repeated_outbound",
    "sms_no_unrequested_spend",
    "sms_agents_started",
    "sms_completion_accepted",
    "sms_lifecycle_announced",
}


@dataclass
class SmsRunnerDeps:
    """Local-stack primitives injected by run_benchmark (keeps this module importable alone)."""

    run_sql: Callable[[str], str]
    sql_literal: Callable[[str], str]
    is_local_base_url: Callable[[str], bool]
    benchmark_user_id: Callable[[], str]


@dataclass
class SpendState:
    """Everything a supervisor turn could spend the user's money on.

    Observed straight off the DB rather than from tool logs, so it catches a
    budget bump or a spawned agent no matter which code path performed it.
    """

    budget_cents: int
    agent_count: int


@dataclass
class SmsTurn:
    """One inbound text and everything the supervisor said back to it."""

    inbound: str
    outbound: list[str]
    # Texts the runtime sent on a spawned agent's behalf (origin=agent-lifecycle).
    lifecycle: list[str]
    # Whether the supervisor ended this run via attempt_completion, read from
    # the backend's own END log line rather than inferred from silence.
    completion_accepted: bool
    duration_seconds: float
    max_outbound: int
    min_outbound: int
    spend_before: SpendState
    spend_after: SpendState
    allow_spend: bool
    # Ordered, machine-recorded supervisor calls/results for this inbound turn.
    # Kept out of the LLM judge input but included in the durable run report.
    tool_calls: list[dict] = field(default_factory=list)


class SmsScriptError(RuntimeError):
    """The task's sms_script is missing or malformed."""


def parse_sms_script(task: BenchmarkTask) -> dict:
    """Validate and normalize ``task.sms_script`` (required for runner="sms")."""
    script = task.sms_script
    if not isinstance(script, dict):
        raise SmsScriptError(f"{task.name}: runner='sms' requires an sms_script object")
    turns = script.get("turns")
    if not isinstance(turns, list) or not turns:
        raise SmsScriptError(f"{task.name}: sms_script.turns must be a non-empty list")
    for index, turn in enumerate(turns):
        if not isinstance(turn, dict) or not str(turn.get("inbound") or "").strip():
            raise SmsScriptError(f"{task.name}: sms_script.turns[{index}].inbound must be non-empty")
    seed_agents = script.get("seed_agents", [])
    if not isinstance(seed_agents, list):
        raise SmsScriptError(f"{task.name}: sms_script.seed_agents must be a list")
    for index, agent in enumerate(seed_agents):
        if not isinstance(agent, dict) or not str(agent.get("goal") or "").strip():
            raise SmsScriptError(f"{task.name}: sms_script.seed_agents[{index}].goal must be non-empty")
    return script


# ── Transcript access ────────────────────────────────────────────────────────


def _read_transcript(deps: SmsRunnerDeps, user_id: str) -> list[dict]:
    """Return the persisted supervisor transcript, newest last.

    ``SmsSession.messages`` is a JSON *string* wrapped in jsonb (see
    sessionStore.ts), so it needs one unwrap before parsing.
    """
    raw = deps.run_sql(
        'SELECT messages FROM "SmsSession" WHERE "userId" = ' f"{deps.sql_literal(user_id)};"
    ).strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict)]


def _read_spend_state(deps: SmsRunnerDeps, user_id: str) -> SpendState:
    """Total authorized budget and live agent count for the benchmark user."""
    row = deps.run_sql(
        'SELECT COALESCE(SUM("priceLimitCents"), 0), COUNT(*) FROM "Agent" '
        f'WHERE "userId" = {deps.sql_literal(user_id)} AND "deletedAt" IS NULL;'
    ).strip()
    parts = row.split("\t") if row else []
    if len(parts) != 2:
        return SpendState(budget_cents=0, agent_count=0)
    return SpendState(budget_cents=int(parts[0] or 0), agent_count=int(parts[1] or 0))


def _user_phone(deps: SmsRunnerDeps, user_id: str) -> str:
    phone = deps.run_sql(
        'SELECT phone FROM "User" WHERE "userId" = ' f"{deps.sql_literal(user_id)};"
    ).strip()
    if not phone:
        raise RuntimeError(
            f"Benchmark user {user_id} has no phone number; the SMS supervisor cannot be driven "
            "without one. Re-sync the base image (scripts/setup-db.sh)."
        )
    return phone


def _reset_session(deps: SmsRunnerDeps, user_id: str) -> None:
    """Clear the transcript so a run's trajectory is its own."""
    deps.run_sql(f'DELETE FROM "SmsSession" WHERE "userId" = {deps.sql_literal(user_id)};')


def _seed_transcript(deps: SmsRunnerDeps, user_id: str, seed_messages: list[dict]) -> None:
    """Pre-load the thread history the failing turn actually happened inside.

    Prior *assistant* turns are the point. A supervisor conditions on what it
    already said, so a thread where it has been repeating "still in progress" is
    a materially different input from an empty one — that is the state the
    2026-07-27 spam grew out of, and it cannot be reproduced from scratch. Both
    roles are seeded verbatim, in order, exactly as the transcript stores them.

    Written as one jsonb string because sessionStore.ts persists
    ``SmsSession.messages`` as a JSON string inside jsonb; matching that shape
    here is what lets contextBuilder read the seeded history back unchanged.
    """
    if not seed_messages:
        return
    entries = []
    for index, message in enumerate(seed_messages):
        role = str(message["role"])
        entry: dict[str, Any] = {"role": role, "content": str(message["content"])}
        if role == "user":
            # contextBuilder keys inbound turns off inboundSeq; leave room below
            # the live turns so seeded history sorts before anything this run sends.
            entry["inboundSeq"] = index + 1
        entries.append(entry)
    payload = json.dumps(json.dumps(entries))
    deps.run_sql(
        'INSERT INTO "SmsSession" (id, "userId", messages, "lastInboundSeq", "createdAt", "updatedAt") '
        f"VALUES (gen_random_uuid(), {deps.sql_literal(user_id)}, "
        f"{deps.sql_literal(payload)}::jsonb, {len(seed_messages)}, NOW(), NOW()) "
        'ON CONFLICT ("userId") DO UPDATE SET messages = EXCLUDED.messages, '
        '"lastInboundSeq" = EXCLUDED."lastInboundSeq", "updatedAt" = NOW();'
    )


def _seed_agents(deps: SmsRunnerDeps, user_id: str, seed_agents: list[dict]) -> list[str]:
    """Insert the active-agent state a turn needs, without spending a workflow.

    The supervisor reads agent state straight from ``Agent`` rows, so a row is a
    faithful fixture for "an agent is running right now" — which is the exact
    condition that used to tempt it into narrating progress forever. Rows are
    marked ``isBenchmark`` so the lifecycle-SMS dispatcher suppresses their texts.
    """
    ids: list[str] = []
    for agent in seed_agents:
        goal = str(agent["goal"])
        status = str(agent.get("status", "ACTIVE")).upper()
        progress = float(agent.get("progress", 0.1))
        # Explicit budget headroom. A seeded agent left at the schema default
        # sits at spent==limit, which is a trap: it invites the supervisor to
        # "helpfully" top it up and turns a trajectory test into a budget test.
        price_limit_cents = int(agent.get("price_limit_cents", 500))
        tree_cost_cents = int(agent.get("tree_cost_cents", 0))
        row = deps.run_sql(
            'INSERT INTO "Agent" (id, "userId", goal, status, progress, source, "isBenchmark", '
            '"priceLimitCents", "treeCostCents", "createdAt", "updatedAt") VALUES (gen_random_uuid(), '
            f"{deps.sql_literal(user_id)}, {deps.sql_literal(goal)}, "
            f"{deps.sql_literal(status)}::\"AgentStatus\", {progress}, 'SMS'::\"AgentSource\", true, "
            f"{price_limit_cents}, {tree_cost_cents}, NOW(), NOW()) RETURNING id;"
        ).strip()
        if row:
            ids.append(row)
    return ids


def web_search_fixture_path() -> pathlib.Path:
    """The one path the runner writes and the backend reads.

    Deliberately NOT derived from BENCHMARK_CONTEXT_DIR on this side. That value
    is REPO_ROOT-relative while this process runs with cwd=agents/, so resolving
    it here silently produces agents/.context/... — a real file, written and
    read back successfully, that the backend never looks at. The fixture then
    no-ops and the benchmark quietly runs against live search.

    So the backend's own env var is the contract: local.py exports the absolute
    path into the stack, and both sides use exactly that string.
    """
    configured = os.environ.get("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE")
    if configured:
        return pathlib.Path(configured)
    context_dir = os.environ.get("BENCHMARK_CONTEXT_DIR") or ".context"
    return (REPO_ROOT / context_dir / "sms-web-search-fixture.json").resolve()


def _apply_web_search_fixture(fixture: Any) -> None:
    """Publish the task's web_search stub to the backend, or clear a stale one.

    This is the ONLY mocked boundary in an SMS benchmark. It exists because the
    trajectory under test branches on what the world says -- "closed" must end
    the run, "open" must start an agent -- and live search would let the
    restaurant's real hours decide the verdict. Cleared when a task declares no
    fixture so one task cannot inherit another's stubbed world.
    """
    path = web_search_fixture_path()
    if fixture is None:
        path.unlink(missing_ok=True)
        return
    if not os.environ.get("BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE"):
        raise RuntimeError(
            "Task declares a web_search_fixture but the stack was not configured to read one "
            "(BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE unset). The run would use LIVE search and "
            "score a trajectory the fixture was meant to control. Start the stack via "
            "scripts/run-bench --local, which exports the path."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture))


def _backend_log_path() -> pathlib.Path | None:
    context_dir = os.environ.get("BENCHMARK_CONTEXT_DIR")
    for candidate in (
        (REPO_ROOT / context_dir / "logs" / "backend.log") if context_dir else None,
        REPO_ROOT / "back-end" / "backend-logs.log",
    ):
        if candidate is not None and candidate.exists():
            return candidate
    return None


def _backend_log_after(marker: int) -> str:
    path = _backend_log_path()
    if path is None:
        return ""
    try:
        with path.open("rb") as handle:
            handle.seek(marker)
            return handle.read().decode("utf-8", errors="ignore")
    except OSError:
        return ""


def _completion_accepted_after(marker: int) -> bool:
    """Read the supervisor's own END line for this turn.

    `attempt_completion` leaves no DB trace, so silence after one SMS is
    ambiguous — a run that hit the round cap or died in the terminal net looks
    identical from the transcript. The backend logs the answer directly.
    Absent a readable log the check abstains (returns True) rather than failing
    a run for a harness gap.
    """
    text = _backend_log_after(marker)
    if not text:
        return True
    ends = re.findall(r"=== END ===.*?completionAccepted=(\w+)", text)
    return ends[-1] == "true" if ends else True


def _parse_tool_trace_log(text: str) -> list[dict]:
    """Read the last stable TOOL_TRACE record from dev or production logs."""
    latest: list[dict] = []
    ansi = re.compile(r"\x1b\[[0-9;]*m")
    for raw_line in text.splitlines():
        line = ansi.sub("", raw_line).strip()
        if "[SmsSupervisor] TOOL_TRACE" not in line:
            continue
        encoded: Any = None
        try:
            entry = json.loads(line)
            if isinstance(entry, dict):
                encoded = entry.get("toolTrace")
        except json.JSONDecodeError:
            match = re.search(r"(?:^|\s)toolTrace=(\[.*\])$", line)
            if match:
                encoded = match.group(1)
        if not isinstance(encoded, str):
            continue
        try:
            parsed = json.loads(encoded)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list) and all(isinstance(item, dict) for item in parsed):
            latest = parsed
    return latest


def _tool_trace_after(marker: int) -> list[dict]:
    return _parse_tool_trace_log(_backend_log_after(marker))


def _backend_log_size() -> int:
    path = _backend_log_path()
    return path.stat().st_size if path is not None else 0


def _live_agent_ids(deps: SmsRunnerDeps, user_id: str) -> set[str]:
    rows = deps.run_sql(
        f'SELECT id FROM "Agent" WHERE "userId" = {deps.sql_literal(user_id)};'
    ).strip()
    return {line.strip() for line in rows.splitlines() if line.strip()}


def _cleanup(
    deps: SmsRunnerDeps,
    user_id: str,
    agent_ids: list[str],
    pre_existing: set[str] | None = None,
) -> None:
    """Reap every agent this run is responsible for, seeded or supervisor-made.

    Seeded rows are not the whole story: a task whose whole point is that the
    supervisor calls start_new_agent produces agents the runner never recorded.
    Deleting only the seeded list leaves those behind — with a live Temporal
    workflow — on any stack whose database outlives the run. So diff against the
    agents that existed before the run and remove the difference.
    """
    doomed = set(agent_ids)
    if pre_existing is not None:
        doomed |= _live_agent_ids(deps, user_id) - pre_existing
    for agent_id in doomed:
        deps.run_sql(f'DELETE FROM "Agent" WHERE id = {deps.sql_literal(agent_id)};')
    _reset_session(deps, user_id)


# ── Driving one turn ─────────────────────────────────────────────────────────


def _surge_inbound_payload(phone: str, body: str) -> dict:
    """The Surge webhook shape the backend parses (domains/sms-webhook)."""
    return {
        "data": {
            "body": body,
            "conversation": {
                "contact": {"phone_number": phone},
                "phone_number": {"number": "+14154498072"},
            },
        }
    }


async def _drive_turn(
    session: aiohttp.ClientSession,
    base_url: str,
    deps: SmsRunnerDeps,
    user_id: str,
    phone: str,
    turn: dict,
    settle_seconds: float,
    turn_timeout_seconds: float,
) -> SmsTurn:
    inbound = str(turn["inbound"])
    baseline = len(_read_transcript(deps, user_id))
    log_marker = _backend_log_size()
    spend_before = _read_spend_state(deps, user_id)
    started = time.monotonic()

    async with session.post(
        f"{base_url}/api/sms/inbound",
        json=_surge_inbound_payload(phone, inbound),
        timeout=aiohttp.ClientTimeout(total=30),
    ) as response:
        if response.status != 200:
            raise RuntimeError(
                f"Inbound SMS webhook returned {response.status}: {(await response.text())[:300]}"
            )

    outbound: list[str] = []
    lifecycle: list[str] = []
    last_change = time.monotonic()
    while True:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        # Both kinds of text reach the same phone, but they answer different
        # questions. `outbound` is what the SUPERVISOR chose to say — that is
        # what the per-turn budget governs. `lifecycle` is an agent announcing
        # itself on its own channel; scoring those against the supervisor's
        # budget marks correct behavior as spam (it did, before this split).
        fresh = [
            entry for entry in _read_transcript(deps, user_id)[baseline:]
            if entry.get("role") == "assistant"
        ]
        current = [
            str(e.get("content") or "") for e in fresh if e.get("origin") != "agent-lifecycle"
        ]
        current_lifecycle = [
            str(e.get("content") or "") for e in fresh if e.get("origin") == "agent-lifecycle"
        ]
        if len(current) != len(outbound) or len(current_lifecycle) != len(lifecycle):
            outbound = current
            lifecycle = current_lifecycle
            last_change = time.monotonic()
        elapsed = time.monotonic() - started
        quiet_for = time.monotonic() - last_change
        if outbound and quiet_for >= settle_seconds:
            break
        if elapsed >= turn_timeout_seconds:
            break

    return SmsTurn(
        inbound=inbound,
        outbound=outbound,
        lifecycle=lifecycle,
        completion_accepted=_completion_accepted_after(log_marker),
        duration_seconds=time.monotonic() - started,
        max_outbound=int(turn.get("max_outbound", DEFAULT_MAX_OUTBOUND)),
        min_outbound=int(turn.get("min_outbound", 1)),
        spend_before=spend_before,
        spend_after=_read_spend_state(deps, user_id),
        allow_spend=bool(turn.get("allow_spend", False)),
        tool_calls=_tool_trace_after(log_marker),
    )


# ── Evaluation ───────────────────────────────────────────────────────────────


def _content_fingerprint(message: str) -> str:
    """Normalize a reply so a literal re-send collides with its original.

    Deliberately lexical. Two replies that mean the same thing in different
    words ("I'll update you when it's done" vs "I'll ping you when it's placed")
    are NOT caught here and are not meant to be — no regex decides semantic
    sameness honestly. That judgement belongs to the declared LLM judge, which reads the
    thread. This check owns the cheap, un-gameable half: the same text twice.
    """
    return " ".join(re.findall(r"[a-z0-9']+", message.lower()))


def run_sms_static_check(evaluator: dict, turns: list[SmsTurn]) -> tuple[bool, str]:
    """Fail-closed static checks over a completed SMS trajectory."""
    for check in evaluator.get("checks", []):
        check_type = check.get("type")
        if check_type == "sms_outbound_budget":
            for index, turn in enumerate(turns):
                if len(turn.outbound) > turn.max_outbound:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) produced {len(turn.outbound)} outbound SMS, "
                        f"budget is {turn.max_outbound}: {turn.outbound}"
                    )
                if len(turn.outbound) < turn.min_outbound:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) produced {len(turn.outbound)} outbound SMS, "
                        f"at least {turn.min_outbound} required"
                    )
            continue
        if check_type == "sms_no_repeated_outbound":
            # Compared across the whole thread, not just within a turn. The prod
            # failure was N near-identical texts in one run, but the same defect
            # also shows up one-per-turn ("letting the agent keep working, I'll
            # update you" → "the agent is still on it, I'll ping you"), which a
            # per-turn check waves through.
            seen: dict[str, int] = {}
            for index, turn in enumerate(turns):
                for message in turn.outbound:
                    fingerprint = _content_fingerprint(message)
                    if fingerprint in seen:
                        return False, (
                            f"Turn {index} ({turn.inbound!r}) repeated what turn {seen[fingerprint]} "
                            f"already said: {message!r}"
                        )
                    seen[fingerprint] = index
            continue
        if check_type == "sms_no_unrequested_spend":
            for index, turn in enumerate(turns):
                if turn.allow_spend:
                    continue
                added = turn.spend_after.budget_cents - turn.spend_before.budget_cents
                if added > 0:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) raised the user's authorized budget by "
                        f"${added / 100:.2f} without being asked to spend anything"
                    )
                spawned = turn.spend_after.agent_count - turn.spend_before.agent_count
                if spawned > 0:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) started {spawned} new agent(s) without "
                        "being asked to start anything"
                    )
            continue
        if check_type == "sms_completion_accepted":
            for index, turn in enumerate(turns):
                if not turn.completion_accepted:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) did not end via attempt_completion "
                        "(the run stopped some other way: round cap, error, or terminal net)"
                    )
            continue
        if check_type == "sms_agents_started":
            # The positive half of the contract: a real request must actually
            # start the work, exactly once. "Started two agents" and "replied
            # about it but started nothing" are both failures, and neither is
            # visible from the reply text alone — this reads the DB.
            expected = int(check.get("count", 1))
            for index, turn in enumerate(turns):
                if not turn.allow_spend:
                    continue
                spawned = turn.spend_after.agent_count - turn.spend_before.agent_count
                if spawned != expected:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) started {spawned} agent(s), expected "
                        f"{expected}"
                    )
            continue
        if check_type == "sms_lifecycle_announced":
            # Starting work the user never hears about is its own failure, and it
            # is invisible to the supervisor's own send budget.
            expected = int(check.get("count", 1))
            for index, turn in enumerate(turns):
                if not turn.allow_spend:
                    continue
                if len(turn.lifecycle) != expected:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) produced {len(turn.lifecycle)} agent "
                        f"lifecycle SMS, expected {expected}: {turn.lifecycle}"
                    )
            continue
        return False, f"Unsupported enforced static check for runner='sms': {check_type}"
    return True, "All SMS static checks passed"


def build_judge_transcript(turns: list[SmsTurn]) -> list[dict]:
    return [
        {
            "turn": index,
            "agent_lifecycle_sms": turn.lifecycle,
            "user_texted": turn.inbound,
            "rose_replied": turn.outbound,
            "reply_count": len(turn.outbound),
            "budget_change_cents": turn.spend_after.budget_cents - turn.spend_before.budget_cents,
            "agents_started": turn.spend_after.agent_count - turn.spend_before.agent_count,
        }
        for index, turn in enumerate(turns)
    ]


def build_report_transcript(turns: list[SmsTurn]) -> list[dict]:
    """The durable trajectory, including evidence intentionally hidden from judges."""
    transcript = build_judge_transcript(turns)
    for entry, turn in zip(transcript, turns):
        entry["tool_calls"] = turn.tool_calls
    return transcript


def build_judge_scenario(script: dict) -> dict:
    """Ground truth the judge needs to separate "grounded" from "invented".

    Without the pre-existing agent state, a judge reads a correct reference to a
    running agent's goal as a hallucination and fails a clean run.
    """
    return {
        "agents_already_running_before_the_thread": [
            {
                "goal": str(agent.get("goal", "")),
                "status": str(agent.get("status", "ACTIVE")).upper(),
                "budget_dollars": round(int(agent.get("price_limit_cents", 500)) / 100, 2),
            }
            for agent in script.get("seed_agents", [])
        ],
        # The judge must see EVERYTHING the supervisor was told, or it scores
        # grounded facts as hallucinations. Observed: the open-world fixture
        # lists "Lok Lak $18.50", the model correctly quoted it, and the judge
        # failed the run for "claiming a price" because the fixture was not in
        # its view of the world.
        "web_search_results_the_assistant_saw": script.get("web_search_fixture"),
        "note": (
            "Two sources are GROUNDED: the agents already running when the thread started, and "
            "the web-search results above, which the assistant genuinely retrieved. A menu price, "
            "opening hours, or address quoted from those results is correct behavior, NOT an "
            "invention. What counts as invented is a fact about an order that has not happened: "
            "a confirmation number, an order total, or a pickup time for an order still being "
            "placed. Judge those two categories separately."
        ),
    }


def build_sms_verifier_prompt(task: BenchmarkTask, evaluator: dict, scenario: dict) -> str:
    """Build a judge prompt limited to the evaluator's declared criteria."""
    criteria = "\n".join(f"- {criterion}" for criterion in evaluator.get("criteria", []))
    return f"""You are a benchmark judge for an SMS assistant's conversation trajectory.

You are given the literal text thread — what the user texted and every SMS the assistant sent back —
plus the world state that already existed before the thread started. Evaluate only the declared criteria
below. Do not invent additional requirements about wording, tone, style, length, repetition, promises,
or general response quality unless a declared criterion explicitly asks for one. Each turn also reports
`budget_change_cents` and `agents_started` as observed side effects; use them only when a declared
criterion calls for that evidence.

Score exactly 1.0 only when every declared criterion holds for every turn. Otherwise score 0.0 and name
the first turn and message that violates a declared criterion.

Scenario: {task.prompt}
World state before the thread: {json.dumps(scenario, default=str)}
Criteria:
{criteria}
Clarification of the declared criteria: {evaluator.get("judge_prompt", "")}
"""


async def run_sms_llm_judge(
    task: BenchmarkTask, evaluator: dict, turns: list[SmsTurn], scenario: dict
) -> dict:
    """Judge the SMS trajectory itself — what the human's phone actually showed."""
    from helpers.llm import check_progress

    return await check_progress(
        context=[
            {"role": "USER", "text": "Evaluate this SMS thread against the criteria."},
            {"role": "TOOL", "text": json.dumps(build_judge_transcript(turns), default=str)},
        ],
        verifier_system_prompt=build_sms_verifier_prompt(task, evaluator, scenario),
        response_schema=None,
        call_site="benchmark_sms_evaluator",
    )


async def evaluate_sms_turns(
    task: BenchmarkTask, turns: list[SmsTurn], scenario: Optional[dict] = None
) -> tuple[bool, Optional[str], list[dict]]:
    """Run the task's declared evaluators against the trajectory. Fails closed."""
    if not task.evaluators:
        raise SmsScriptError(f"{task.name}: runner='sms' requires at least one evaluator")

    results: list[dict] = []
    for evaluator in task.evaluators:
        evaluator_id = evaluator.get("id", "unnamed")
        method = evaluator.get("method")
        try:
            if method == "static_check":
                passed, reasoning = run_sms_static_check(evaluator, turns)
                score = 1.0 if passed else 0.0
            elif method == "single_turn_llm_judge":
                judged = await run_sms_llm_judge(task, evaluator, turns, scenario or {})
                score = float(judged.get("score", 0.0))
                reasoning = str(judged.get("reasoning") or "Judge returned no reasoning")
                passed = score >= float(evaluator.get("pass_threshold", 1.0))
            else:
                passed, score = False, 0.0
                reasoning = f"Unsupported evaluator method for runner='sms': {method}"
        except Exception as exc:  # noqa: BLE001 — fail closed, surface the cause
            passed, score = False, 0.0
            reasoning = f"SMS evaluator execution failed: {exc}"
        results.append(
            {"id": evaluator_id, "method": method, "score": score, "passed": passed, "reasoning": reasoning}
        )
        if not passed:
            return False, f"Declared evaluator {evaluator_id} failed: {reasoning}", results
    return True, None, results


# ── Entry point ──────────────────────────────────────────────────────────────


async def run_sms_task(base_url: str, task: BenchmarkTask, deps: SmsRunnerDeps) -> TaskResult:
    """Drive the real SMS supervisor through a scripted thread and score it."""
    if not deps.is_local_base_url(base_url):
        raise RuntimeError(
            f"{task.name} drives the live SMS supervisor and must run against the local benchmark "
            "stack, where outbound Surge is intercepted. Against a remote base URL it would text a "
            "real phone."
        )

    script = parse_sms_script(task)
    settle_seconds = float(script.get("settle_seconds", DEFAULT_SETTLE_SECONDS))
    turn_timeout_seconds = float(script.get("turn_timeout_seconds", DEFAULT_TURN_TIMEOUT_SECONDS))
    user_id = deps.benchmark_user_id()
    phone = _user_phone(deps, user_id)

    started = time.monotonic()
    seeded_agent_ids: list[str] = []
    turns: list[SmsTurn] = []
    # Bound before the try: the finally-block cleanup reads it, so an exception
    # raised by the very first statement inside must not surface as a NameError
    # that hides the real failure.
    pre_existing_agents: set[str] = set()
    try:
        _apply_web_search_fixture(script.get("web_search_fixture"))
        pre_existing_agents = _live_agent_ids(deps, user_id)
        _reset_session(deps, user_id)
        seed_messages = script.get("seed_messages", [])
        _seed_transcript(deps, user_id, seed_messages)
        # A silently-unreadable seed would turn a mid-thread repro into a
        # fresh-session run that still reports "seeded" — the failure would just
        # stop reproducing and nobody would know why. Read it back through the
        # same path contextBuilder uses and refuse to run if it did not land.
        if seed_messages:
            landed = _read_transcript(deps, user_id)
            if [m["content"] for m in landed] != [str(m["content"]) for m in seed_messages]:
                raise RuntimeError(
                    f"Seeded transcript did not persist readably: wrote {len(seed_messages)} "
                    f"messages, read back {len(landed)}. The supervisor would have started from "
                    "an empty thread, so this run would not be the mid-thread repro it claims."
                )
        seeded_agent_ids = _seed_agents(deps, user_id, script.get("seed_agents", []))
        print(
            f"    📱 SMS bench: user={user_id[:8]} phone={phone[:7]}**** "
            f"seeded_history={len(seed_messages)} seeded_agents={len(seeded_agent_ids)} "
            f"turns={len(script['turns'])}"
        )

        async with aiohttp.ClientSession() as session:
            for index, turn in enumerate(script["turns"]):
                result = await _drive_turn(
                    session,
                    base_url,
                    deps,
                    user_id,
                    phone,
                    turn,
                    settle_seconds,
                    turn_timeout_seconds,
                )
                turns.append(result)
                print(
                    f"    📨 turn {index}: {result.inbound!r} → {len(result.outbound)} SMS "
                    f"in {result.duration_seconds:.1f}s"
                )
                for message in result.outbound:
                    print(f"       ↳ {message[:140]}")

        passed, failure_reason, evaluator_results = await evaluate_sms_turns(
            task, turns, build_judge_scenario(script)
        )
    except Exception as exc:  # noqa: BLE001 — a harness error is a task failure, not a crash
        passed = False
        failure_reason = f"SMS runner error: {exc}"
        evaluator_results = []
    finally:
        _cleanup(deps, user_id, seeded_agent_ids, pre_existing_agents)

    total_outbound = sum(len(turn.outbound) for turn in turns)
    return TaskResult(
        name=task.name,
        passed=passed,
        agent_id="",
        status="COMPLETED" if passed else "FAILED",
        progress_score=1.0 if passed else 0.0,
        duration_seconds=round(time.monotonic() - started, 1),
        cost_cents=0.0,
        message_count=total_outbound + len(turns),
        failure_reason=failure_reason,
        stop_metadata={
            "runner": "sms",
            "turns": build_report_transcript(turns),
            "declared_evaluators": evaluator_results,
        },
    )


def build_deps_from_module(module: Any) -> SmsRunnerDeps:
    """Bind the runner to run_benchmark's local-stack helpers."""
    return SmsRunnerDeps(
        run_sql=module._run_local_victoria_sql,
        sql_literal=module._sql_literal,
        is_local_base_url=module._is_local_base_url,
        benchmark_user_id=module._current_benchmark_user_id,
    )
