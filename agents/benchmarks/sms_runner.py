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
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import parse_qs, urlparse

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
    "sms_agent_goal_contains",
    "sms_completion_accepted",
    "sms_lifecycle_announced",
}
# Synced-document providers the supervisor's grep reads as `source="documents"`.
# Google Drive/Calendar rows are excluded by the documents grep, so they are not
# seedable here.
SEED_DOCUMENT_SOURCES = {"apple_notes", "obsidian", "chatgpt", "claude"}


@dataclass
class SmsRunnerDeps:
    """Local-stack primitives injected by run_benchmark (keeps this module importable alone)."""

    run_sql: Callable[[str], str]
    sql_literal: Callable[[str], str]
    is_local_base_url: Callable[[str], bool]
    benchmark_user_id: Callable[[], str]
    cleanup_agents: Callable[[str, str, set[str], set[str], dict], Awaitable[dict]] | None = None
    committed_agent_ids: set[str] = field(default_factory=set)
    root_provenance_errors: list[str] = field(default_factory=list)
    other_task_roots: Callable[[], set[str]] | None = None
    on_agent_created: Callable[[str, str], None] | None = None
    task_name: str = ""


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
    # Goals of the agents this turn started, read from the Agent rows it created.
    started_agent_goals: list[str] = field(default_factory=list)
    owned_agent_ids: set[str] = field(default_factory=set)


class SmsCleanupError(RuntimeError):
    """Keep exact custody evidence attached to an unsuccessful cleanup."""

    def __init__(self, message: str, receipt: dict):
        super().__init__(message)
        self.receipt = receipt


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
        children = agent.get("children", [])
        if not isinstance(children, list):
            raise SmsScriptError(f"{task.name}: sms_script.seed_agents[{index}].children must be a list")
        for child_index, child in enumerate(children):
            if not isinstance(child, dict) or not str(child.get("goal") or "").strip():
                raise SmsScriptError(
                    f"{task.name}: sms_script.seed_agents[{index}].children[{child_index}].goal must be non-empty"
                )
    attention_requests = script.get("seed_attention_requests", [])
    if not isinstance(attention_requests, list):
        raise SmsScriptError(f"{task.name}: sms_script.seed_attention_requests must be a list")
    for index, request in enumerate(attention_requests):
        if not isinstance(request, dict) or not str(request.get("question") or "").strip():
            raise SmsScriptError(f"{task.name}: sms_script.seed_attention_requests[{index}].question must be non-empty")
    seed_documents = script.get("seed_documents", [])
    if not isinstance(seed_documents, list):
        raise SmsScriptError(f"{task.name}: sms_script.seed_documents must be a list")
    for index, document in enumerate(seed_documents):
        if not isinstance(document, dict):
            raise SmsScriptError(f"{task.name}: sms_script.seed_documents[{index}] must be an object")
        if document.get("source") not in SEED_DOCUMENT_SOURCES:
            raise SmsScriptError(
                f"{task.name}: sms_script.seed_documents[{index}].source must be one of "
                f"{sorted(SEED_DOCUMENT_SOURCES)}"
            )
        for key in ("title", "content"):
            if not str(document.get(key) or "").strip():
                raise SmsScriptError(f"{task.name}: sms_script.seed_documents[{index}].{key} must be non-empty")
    return script


# ── Transcript access ────────────────────────────────────────────────────────


def _read_transcript(deps: SmsRunnerDeps, user_id: str) -> list[dict]:
    """Return the persisted supervisor transcript, newest last.

    ``SmsSession.messages`` is a JSON *string* wrapped in jsonb (see
    sessionStore.ts), so it needs one unwrap before parsing.
    """
    raw = deps.run_sql(f'SELECT messages FROM "SmsSession" WHERE "userId" = {deps.sql_literal(user_id)};').strip()
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
    phone = deps.run_sql(f'SELECT phone FROM "User" WHERE "userId" = {deps.sql_literal(user_id)};').strip()
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


_UUID_LINE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _returned_id(output: str, what: str) -> str:
    """The one row id from ``INSERT ... RETURNING id`` output.

    ``psql -t -A`` prints the returned row and then the command tag, so the raw
    output is ``<uuid>\nINSERT 0 1``. Using it verbatim as an id silently breaks
    every later foreign key and every cleanup DELETE keyed on it.
    """
    ids = [line.strip() for line in output.splitlines() if _UUID_LINE.match(line.strip())]
    if len(ids) != 1:
        raise RuntimeError(f"Seeding {what} returned {output!r}, expected exactly one row id")
    return ids[0]


def _insert_agent(
    deps: SmsRunnerDeps, user_id: str, spec: dict, parent_id: Optional[str] = None, depth: int = 0
) -> str:
    goal = str(spec["goal"])
    status = str(spec.get("status", "ACTIVE")).upper()
    progress = float(spec.get("progress", 0.1))
    # Explicit budget headroom. A seeded agent left at the schema default
    # sits at spent==limit, which is a trap: it invites the supervisor to
    # "helpfully" top it up and turns a trajectory test into a budget test.
    price_limit_cents = int(spec.get("price_limit_cents", 500))
    tree_cost_cents = int(spec.get("tree_cost_cents", 0))
    parent_sql = deps.sql_literal(parent_id) if parent_id is not None else "NULL"
    row = deps.run_sql(
        'INSERT INTO "Agent" (id, "userId", goal, status, progress, source, "isBenchmark", '
        '"memoryEnabled", "priceLimitCents", "treeCostCents", "parentAgentId", depth, "createdAt", "updatedAt") '
        "VALUES (gen_random_uuid(), "
        f"{deps.sql_literal(user_id)}, {deps.sql_literal(goal)}, "
        f'{deps.sql_literal(status)}::"AgentStatus", {progress}, \'SMS\'::"AgentSource", true, false, '
        f"{price_limit_cents}, {tree_cost_cents}, {parent_sql}, {depth}, NOW(), NOW()) RETURNING id;"
    )
    return _returned_id(row, f"agent {goal[:60]!r}")


def _insert_completion_summary(deps: SmsRunnerDeps, agent_id: str, summary: str, age_seconds: int) -> None:
    """The final-summary TOOL message the context builder lists under Recent Agent Activity."""
    metadata = json.dumps(
        {
            "toolName": "completion_summary",
            "title": "✅ Task Complete",
            "isFinalSummary": True,
            "completionSummary": {"summary": summary},
        }
    )
    deps.run_sql(
        'INSERT INTO "Message" (id, "agentId", text, role, metadata, timestamp, "createdAt") VALUES (gen_random_uuid(), '
        f"{deps.sql_literal(agent_id)}, {deps.sql_literal(summary)}, 'TOOL'::\"MessageRole\", "
        f"{deps.sql_literal(metadata)}::jsonb, NOW() - interval '{int(age_seconds)} seconds', NOW());"
    )


def _seed_agents(
    deps: SmsRunnerDeps, user_id: str, seed_agents: list[dict], ids: Optional[list[str]] = None
) -> list[str]:
    """Insert the agent state a turn needs, without spending a workflow.

    The supervisor reads agent state straight from ``Agent`` rows, so a row is a
    faithful fixture for "an agent is running right now" — which is the exact
    condition that used to tempt it into narrating progress forever. Rows are
    marked ``isBenchmark`` so the lifecycle-SMS dispatcher suppresses their texts.

    A spec may also carry ``completion_summary`` and ``children`` (each with an
    optional ``count`` and ``completion_summaries``), which reproduces a prod
    agent tree and its Recent Agent Activity lines. Summaries are stamped newest
    first in the order given, so the activity list keeps the prod order.
    Ids are appended to ``ids`` as each row lands, so a failure partway through
    a tree still leaves the caller every row it must reap.
    """
    ids = [] if ids is None else ids
    summary_age = 0
    for agent in seed_agents:
        root_id = _insert_agent(deps, user_id, agent)
        ids.append(root_id)
        if agent.get("completion_summary"):
            _insert_completion_summary(deps, root_id, str(agent["completion_summary"]), summary_age)
            summary_age += 1
        for child in agent.get("children", []):
            summaries = [str(text) for text in child.get("completion_summaries", [])]
            for index in range(int(child.get("count", 1))):
                child_id = _insert_agent(deps, user_id, child, parent_id=root_id, depth=1)
                ids.append(child_id)
                if index < len(summaries):
                    _insert_completion_summary(deps, child_id, summaries[index], summary_age)
                    summary_age += 1
    return ids


def _seed_attention_requests(deps: SmsRunnerDeps, user_id: str, requests: list[dict]) -> list[str]:
    """Pending attention requests, as the Pending Requests section shows them.

    A prod request can outlive its agent row (the attention table has no foreign
    key), so a request may be seeded without one; ``agent_id`` defaults to a
    fresh orphan id, which renders exactly like the prod orphan.
    """
    ids: list[str] = []
    for request in requests:
        agent_sql = (
            deps.sql_literal(str(request["agent_id"])) if request.get("agent_id") else "gen_random_uuid()::text"
        )
        metadata = json.dumps(request.get("metadata") or {})
        row = deps.run_sql(
            'INSERT INTO "AgentAttentionRequest" (id, "userId", "agentId", "workflowId", question, metadata, '
            '"createdAt", "updatedAt") VALUES (gen_random_uuid()::text, '
            f"{deps.sql_literal(user_id)}, {agent_sql}, 'sms-bench-seeded', "
            f"{deps.sql_literal(str(request['question']))}, {deps.sql_literal(metadata)}::jsonb, NOW(), NOW()) RETURNING id;"
        )
        ids.append(_returned_id(row, f"attention request {request['question']!r}"))
    return ids


def _seed_documents(deps: SmsRunnerDeps, user_id: str, seed_documents: list[dict]) -> list[str]:
    """Insert synced-document rows the supervisor's grep can find.

    A task about whether the supervisor *looks things up* needs the answer to
    exist in the user's data; otherwise asking the user is the only correct
    move and the task measures nothing. Rows go straight into
    ``UserDataDocument``, the table ``grep source="documents"`` reads, with a
    per-run externalId so a crashed earlier run can never collide.
    """
    ids: list[str] = []
    for document in seed_documents:
        content = str(document["content"])
        row = deps.run_sql(
            'INSERT INTO "UserDataDocument" (id, "userId", source, "externalId", title, content, metadata, '
            '"contentHash", "sourceUpdatedAt", "lastSeenAt", "createdAt", "updatedAt") VALUES (gen_random_uuid(), '
            f"{deps.sql_literal(user_id)}, {deps.sql_literal(str(document['source']))}, "
            "'sms-bench-' || gen_random_uuid(), "
            f"{deps.sql_literal(str(document['title']))}, {deps.sql_literal(content)}, '{{}}'::jsonb, "
            f"md5({deps.sql_literal(content)}), NOW(), NOW(), NOW(), NOW()) RETURNING id;"
        )
        ids.append(_returned_id(row, f"document {document['title']!r}"))
    return ids


def _started_agent_goals(deps: SmsRunnerDeps, user_id: str, before: set[str]) -> list[str]:
    """Goals of the agents created since ``before`` was read, oldest first."""
    started = sorted(_live_agent_ids(deps, user_id) - before)
    if not started:
        return []
    id_list = ", ".join(deps.sql_literal(agent_id) for agent_id in started)
    # One output line per agent: psql would split a multi-line goal across rows.
    rows = deps.run_sql(
        f"SELECT regexp_replace(goal, E'[\\\\r\\\\n]+', ' ', 'g') FROM \"Agent\" "
        f'WHERE id IN ({id_list}) ORDER BY "createdAt";'
    )
    return [line for line in rows.splitlines() if line.strip()]


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


def _owning_sms_log_lines(marker: int, user_id: str, inbound_seq: int, event: str) -> list[str]:
    """Select only this webhook's exact user/sequence audit records."""
    matches = []
    for raw in _backend_log_after(marker).splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", raw).strip()
        if f"[SmsSupervisor] {event}" not in line:
            continue
        try:
            entry = json.loads(line)
            same = (isinstance(entry, dict) and entry.get("message") == f"[SmsSupervisor] {event}"
                    and entry.get("userId") == user_id and entry.get("mySeq") == inbound_seq)
        except json.JSONDecodeError:
            same = (re.search(r"(?:^|\s)userId=" + re.escape(user_id) + r"(?=\s|$)", line) is not None
                    and re.search(r"(?:^|\s)mySeq=" + str(inbound_seq) + r"(?=\s|$)", line) is not None)
        if same:
            matches.append(line)
    return matches


def _completion_accepted_after(marker: int, user_id: str, inbound_seq: int) -> bool | None:
    """None means still running or unobserved; a missing END never grants a pass."""
    ends = _owning_sms_log_lines(marker, user_id, inbound_seq, "=== END ===")
    if not ends:
        return None
    if len(ends) != 1:
        raise RuntimeError("SMS terminal record is ambiguous for the owning turn")
    try:
        accepted = json.loads(ends[0]).get("completionAccepted")
    except json.JSONDecodeError:
        match = re.search(r"(?:^|\s)completionAccepted=(true|false)(?=\s|$)", ends[0])
        accepted = match.group(1) == "true" if match else None
    if not isinstance(accepted, bool):
        raise RuntimeError("SMS terminal record lacks completion status")
    return accepted


def _parse_tool_trace_log(text: str, *, strict: bool = False) -> list[dict]:
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
            if strict:
                raise RuntimeError("SMS owning tool trace is unreadable")
            continue
        try:
            parsed = json.loads(encoded)
        except json.JSONDecodeError:
            if strict:
                raise RuntimeError("SMS owning tool trace is unreadable")
            continue
        if isinstance(parsed, list) and all(isinstance(item, dict) for item in parsed):
            latest = parsed
        elif strict:
            raise RuntimeError("SMS owning tool trace is unreadable")
    return latest


def _tool_trace_after(marker: int) -> list[dict]:
    return _parse_tool_trace_log(_backend_log_after(marker))


def _remember_sms_committed_roots(deps: SmsRunnerDeps, ids: set[str]) -> None:
    new = ids - deps.committed_agent_ids
    deps.committed_agent_ids.update(ids)
    if deps.on_agent_created is not None:
        for agent_id in sorted(new):
            deps.on_agent_created(deps.task_name, agent_id)


def _incremental_sms_root_ids_after(
    marker: int, user_id: str, inbound_seq: int, event: str = "ROOT_COMMITTED"
) -> set[str]:
    """Positive allocation/commit receipts precede the final supervisor trace."""
    owned = set()
    for line in _owning_sms_log_lines(marker, user_id, inbound_seq, event):
        try:
            agent_id = json.loads(line).get("agentId")
        except json.JSONDecodeError:
            match = re.search(r"(?:^|\s)agentId=([^\s]+)(?=\s|$)", line)
            agent_id = match.group(1) if match else None
        if not isinstance(agent_id, str) or str(uuid.UUID(agent_id)) != agent_id or agent_id in owned:
            raise RuntimeError("SMS incremental committed-root identity is invalid or ambiguous")
        owned.add(agent_id)
    return owned


def _owning_tool_trace_after(marker: int, user_id: str, inbound_seq: int) -> list[dict]:
    matches = _owning_sms_log_lines(marker, user_id, inbound_seq, "TOOL_TRACE")
    if len(matches) != 1:
        raise RuntimeError("SMS committed-root trace is missing or ambiguous for the owning turn")
    return _parse_tool_trace_log(matches[0], strict=True)


def _committed_sms_root_ids_after(
    marker: int, user_id: str, inbound_seq: int, *, allow_partial: bool = False
) -> set[str]:
    """Final trace for normal results; exact successful commits suffice on interruption."""
    incremental = _incremental_sms_root_ids_after(marker, user_id, inbound_seq)
    allocated = _incremental_sms_root_ids_after(marker, user_id, inbound_seq, "ROOT_ALLOCATED")
    if allow_partial and not _owning_sms_log_lines(marker, user_id, inbound_seq, "TOOL_TRACE") and (incremental or allocated):
        return incremental | allocated
    owned = set()
    for entry in _owning_tool_trace_after(marker, user_id, inbound_seq):
        if entry.get("tool") != "start_new_agent" or entry.get("phase") != "commit":
            continue
        if entry.get("success") is not True or entry.get("resultTruncated") is True:
            if allow_partial and allocated and entry.get("success") is False:
                continue  # Allocation is custody, never proof of a successful start.
            raise RuntimeError("SMS root creation outcome is not fully proved")
        tracks = [line[len("Track: "):] for line in str(entry.get("result", "")).splitlines()
                  if line.startswith("Track: ")]
        if len(tracks) != 1:
            raise RuntimeError("SMS successful commit lacks a complete root tracking URL")
        ids = parse_qs(urlparse(tracks[0]).query).get("agent-id", [])
        if len(ids) != 1 or str(uuid.UUID(ids[0])) != ids[0]:
            raise RuntimeError("SMS committed root tracking identity is invalid")
        owned.add(ids[0])
    if incremental and incremental != owned:
        raise RuntimeError("SMS final trace disagrees with successful incremental commits")
    return owned | allocated


def _backend_log_size() -> int:
    path = _backend_log_path()
    return path.stat().st_size if path is not None else 0


def _live_agent_ids(deps: SmsRunnerDeps, user_id: str) -> set[str]:
    rows = deps.run_sql(f'SELECT id FROM "Agent" WHERE "userId" = {deps.sql_literal(user_id)};').strip()
    return {line.strip() for line in rows.splitlines() if line.strip()}


async def _cleanup(
    deps: SmsRunnerDeps,
    user_id: str,
    agent_ids: list[str],
    pre_existing: set[str] | None = None,
    document_ids: list[str] | None = None,
    attention_request_ids: list[str] | None = None,
    *,
    base_url: str = "",
    outcome: dict | None = None,
) -> dict:
    """Retire seeded rows and positively committed SMS roots.

    The user-row delta detects unattributed rows; it never grants cleanup authority.
    The canonical callback must preserve exact ownership and native terminal proof
    before any Agent row is removed. Seeded documents are then removed by exact id.
    """
    receipt = {"verified": False, "owned_agent_ids": sorted(agent_ids)}
    try:
        # An early failure before the baseline read owns no discovered rows.
        if pre_existing is None:
            if agent_ids or document_ids or attention_request_ids:
                raise RuntimeError("SMS cleanup ownership baseline was not captured")
            return {"verified": True, "root_agent_ids": [], "native_workflows": []}
        discovered = _live_agent_ids(deps, user_id) - pre_existing
        foreign = deps.other_task_roots() if deps.other_task_roots is not None else set()
        doomed = set(agent_ids) | deps.committed_agent_ids
        if doomed & (pre_existing | foreign):
            raise RuntimeError("SMS committed root conflicts with a pre-existing or another task owner")
        unattributed = discovered - doomed - foreign
        receipt = {"verified": False, "owned_agent_ids": sorted(doomed), "root_agent_ids": [], "native_workflows": []}
        if doomed:
            if deps.cleanup_agents is None:
                raise RuntimeError("SMS exact-root cleanup dependency is missing")
            receipt = await deps.cleanup_agents(base_url, user_id, doomed, set(agent_ids), outcome or {
                "name": "sms-cleanup-only", "passed": False, "failure_reason": "Cleanup-only fixture",
            })
            if receipt.get("verified") is not True:
                raise RuntimeError("SMS native owned-root closure was not verified")
        else:
            receipt["verified"] = True
        if deps.root_provenance_errors:
            receipt["root_provenance_errors"] = list(deps.root_provenance_errors)
            raise RuntimeError("SMS interrupted root provenance is incomplete; identities retained")
        covered = {row["id"] for row in receipt.get("after_rows", [])} | doomed
        unattributed -= covered
        if unattributed:
            receipt["unattributed_observed_agent_ids"] = sorted(unattributed)
            raise RuntimeError("SMS new-agent attribution is incomplete; observed rows retained")
        # Preserve every workflow/provider identity until the durable native proof exists.
        for agent_id in doomed:
            deps.run_sql(f'DELETE FROM "Agent" WHERE id = {deps.sql_literal(agent_id)};')
        for document_id in document_ids or []:
            deps.run_sql(f'DELETE FROM "UserDataDocument" WHERE id = {deps.sql_literal(document_id)};')
        for request_id in attention_request_ids or []:
            deps.run_sql(f'DELETE FROM "AgentAttentionRequest" WHERE id = {deps.sql_literal(request_id)};')
        _reset_session(deps, user_id)
        return receipt
    except Exception as exc:
        if isinstance(exc, SmsCleanupError):
            receipt = exc.receipt
        receipt["verified"] = False
        receipt["error"] = str(exc) or type(exc).__name__
        raise SmsCleanupError(receipt["error"], receipt) from exc


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
    agents_before = _live_agent_ids(deps, user_id)
    started = time.monotonic()
    deadline = started + turn_timeout_seconds

    inbound_seq = None
    ownership_captured = False
    try:
        async with session.post(
            f"{base_url}/api/sms/inbound",
            json=_surge_inbound_payload(phone, inbound),
            timeout=aiohttp.ClientTimeout(total=30),
        ) as response:
            if response.status != 200:
                raise RuntimeError(f"Inbound SMS webhook returned {response.status}: {(await response.text())[:300]}")

        inbound_rows = [entry for entry in _read_transcript(deps, user_id)[baseline:]
                        if entry.get("role") == "user" and entry.get("content") == inbound]
        if len(inbound_rows) != 1 or not isinstance(inbound_rows[0].get("inboundSeq"), int):
            raise RuntimeError("SMS webhook turn lacks a unique persisted inbound sequence")
        inbound_seq = inbound_rows[0]["inboundSeq"]
        outbound: list[str] = []
        lifecycle: list[str] = []
        last_change = time.monotonic()
        while True:
            remaining = deadline - time.monotonic()
            if remaining > 0:
                await asyncio.sleep(min(POLL_INTERVAL_SECONDS, remaining))
            # Both kinds of text reach the same phone, but they answer different
            # questions. `outbound` is what the SUPERVISOR chose to say — that is
            # what the per-turn budget governs. `lifecycle` is an agent announcing
            # itself on its own channel; scoring those against the supervisor's
            # budget marks correct behavior as spam (it did, before this split).
            fresh = [entry for entry in _read_transcript(deps, user_id)[baseline:] if entry.get("role") == "assistant"]
            current = [str(e.get("content") or "") for e in fresh if e.get("origin") != "agent-lifecycle"]
            current_lifecycle = [str(e.get("content") or "") for e in fresh if e.get("origin") == "agent-lifecycle"]
            if len(current) != len(outbound) or len(current_lifecycle) != len(lifecycle):
                outbound = current
                lifecycle = current_lifecycle
                last_change = time.monotonic()
            elapsed = time.monotonic() - started
            quiet_for = time.monotonic() - last_change
            _remember_sms_committed_roots(deps, _incremental_sms_root_ids_after(log_marker, user_id, inbound_seq))
            _remember_sms_committed_roots(deps, _incremental_sms_root_ids_after(log_marker, user_id, inbound_seq, "ROOT_ALLOCATED"))
            completion_accepted = _completion_accepted_after(log_marker, user_id, inbound_seq)
            if completion_accepted is not None and (quiet_for >= settle_seconds or elapsed >= turn_timeout_seconds):
                break
            if elapsed >= turn_timeout_seconds:
                raise TimeoutError("SMS owning turn did not emit a terminal record before its existing deadline")

        owned_ids = _committed_sms_root_ids_after(log_marker, user_id, inbound_seq)
        _remember_sms_committed_roots(deps, owned_ids)
        ownership_captured = True
        return SmsTurn(
            inbound=inbound,
            outbound=outbound,
            lifecycle=lifecycle,
            completion_accepted=completion_accepted,
            duration_seconds=time.monotonic() - started,
            max_outbound=int(turn.get("max_outbound", DEFAULT_MAX_OUTBOUND)),
            min_outbound=int(turn.get("min_outbound", 1)),
            spend_before=spend_before,
            spend_after=_read_spend_state(deps, user_id),
            allow_spend=bool(turn.get("allow_spend", False)),
            tool_calls=_owning_tool_trace_after(log_marker, user_id, inbound_seq),
            started_agent_goals=_started_agent_goals(deps, user_id, agents_before),
            owned_agent_ids=owned_ids,
        )
    finally:
        # A cancelled poll can still follow a fully committed native tool result.
        # Recover only the same exact user/sequence audit; never adopt a user-row delta.
        if not ownership_captured:
            try:
                if inbound_seq is None:
                    inbound_rows = [entry for entry in _read_transcript(deps, user_id)[baseline:]
                                    if entry.get("role") == "user" and entry.get("content") == inbound]
                    if len(inbound_rows) != 1 or not isinstance(inbound_rows[0].get("inboundSeq"), int):
                        raise RuntimeError("SMS interrupted webhook sequence is unproved")
                    inbound_seq = inbound_rows[0]["inboundSeq"]
                _remember_sms_committed_roots(deps, _committed_sms_root_ids_after(
                    log_marker, user_id, inbound_seq, allow_partial=True))
            except Exception as exc:
                deps.root_provenance_errors.append(str(exc) or type(exc).__name__)



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
                    return False, (f"Turn {index} ({turn.inbound!r}) started {spawned} agent(s), expected {expected}")
            continue
        if check_type == "sms_agent_goal_contains":
            # Proof that a lookup answered the question rather than the user:
            # the values exist only in seeded user data, so an agent whose goal
            # carries them was handed facts the supervisor found by searching.
            values = [str(value) for value in check.get("values", []) if str(value).strip()]
            if not values:
                return False, "sms_agent_goal_contains declares no values"
            for index, turn in enumerate(turns):
                if not turn.allow_spend:
                    continue
                goals = " \n".join(turn.started_agent_goals).lower()
                missing = [value for value in values if value.lower() not in goals]
                if missing:
                    return False, (
                        f"Turn {index} ({turn.inbound!r}) started agent goal(s) "
                        f"{turn.started_agent_goals!r} missing {missing}"
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
        entry["started_agent_goals"] = turn.started_agent_goals
    return transcript


def _read_user_profile(deps: SmsRunnerDeps, user_id: str) -> dict:
    """Read the same profile fields selected by SMS contextBuilder, without credentials."""
    raw = deps.run_sql(
        'SELECT row_to_json(profile) FROM (SELECT "userId", name, email, phone, '
        '"deliveryRecipientName", "addressLine1", "addressLine2", city, state, '
        '"postalCode", country, "systemName" FROM "User" WHERE "userId" = '
        f'{deps.sql_literal(user_id)}) AS profile;'
    ).strip()
    if not raw:
        raise SmsScriptError("SMS judge profile ground truth was not read back")
    try:
        profile = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise SmsScriptError("SMS judge profile ground truth was not valid JSON") from exc
    expected = {
        "userId", "name", "email", "phone", "deliveryRecipientName", "addressLine1",
        "addressLine2", "city", "state", "postalCode", "country", "systemName",
    }
    if not isinstance(profile, dict) or set(profile) != expected:
        raise SmsScriptError("SMS judge profile ground truth did not match the selected fields")
    # The product uses userId to look up the profile but never renders it to the LLM.
    return {key: value for key, value in profile.items() if key != "userId"}


def build_judge_scenario(script: dict, user_profile: Optional[dict] = None) -> dict:
    """Ground truth the judge needs to separate "grounded" from "invented".

    Without the pre-existing agent state, a judge reads a correct reference to a
    running agent's goal as a hallucination and fails a clean run. Seeded user
    documents are listed for the same reason: a fact the assistant found in them
    is grounded, and a question asking the user for one is avoidable.
    """
    documents = script.get("seed_documents", [])
    searchable = (
        {
            "user_data_the_assistant_could_search": [
                {"source": str(d.get("source", "")), "title": str(d.get("title", "")), "content": str(d.get("content", ""))}
                for d in documents
            ]
        }
        if documents
        else {}
    )
    return {
        **searchable,
        **({"user_profile_available_to_assistant": user_profile} if user_profile is not None else {}),
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
        **(
            {
                "user_data_note": (
                    "The user data above is also GROUNDED: it was in the user's own synced data, "
                    "searchable by the assistant's grep tool. Facts quoted from it are not inventions."
                )
            }
            if documents
            else {}
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


async def run_sms_llm_judge(task: BenchmarkTask, evaluator: dict, turns: list[SmsTurn], scenario: dict) -> dict:
    """Judge the SMS trajectory itself — what the human's phone actually showed."""
    from benchmarks.run_benchmark import _benchmark_judge_claude_auth_kwargs, _judge_until_verdict
    from helpers.llm import check_progress

    claude_auth = await _benchmark_judge_claude_auth_kwargs()
    transcript_text = json.dumps(build_judge_transcript(turns), default=str)
    verifier_prompt = build_sms_verifier_prompt(task, evaluator, scenario)

    async def judge() -> dict:
        return await check_progress(
            context=[
                {"role": "USER", "text": "Evaluate this SMS thread against the criteria."},
                {"role": "TOOL", "text": transcript_text},
            ],
            verifier_system_prompt=verifier_prompt,
            response_schema=None,
            call_site="benchmark_sms_evaluator",
            **claude_auth,
        )

    return await _judge_until_verdict(judge)


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
                raise ValueError(f"Unsupported evaluator method for runner='sms': {method}")
        except Exception as exc:  # fail closed, surface the cause
            raise RuntimeError(f"SMS evaluator {evaluator_id} execution failed: {exc}") from exc
        results.append({"id": evaluator_id, "method": method, "score": score, "passed": passed, "reasoning": reasoning})
        if not passed:
            return False, f"Declared evaluator {evaluator_id} failed: {reasoning}", results
    return True, None, results


# ── Entry point ──────────────────────────────────────────────────────────────


async def run_sms_task(base_url: str, task: BenchmarkTask, deps: SmsRunnerDeps) -> TaskResult:
    """Drive the real SMS supervisor through a scripted thread and score it."""
    task_deadline_at_ms = int((time.time() + float(getattr(task, "_resolved_timeout_seconds", task.timeout_seconds))) * 1000)
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
    seeded_document_ids: list[str] = []
    seeded_request_ids: list[str] = []
    turns: list[SmsTurn] = []
    # Bound before the try: the finally-block cleanup reads it, so an exception
    # raised by the very first statement inside must not surface as a NameError
    # that hides the real failure.
    pre_existing_agents: set[str] | None = None
    cleanup_receipt: dict | None = None
    cleanup_error: str | None = None
    cancellation: asyncio.CancelledError | None = None
    passed = False
    failure_reason: str | None = None
    evaluator_results: list[dict] = []
    execution_error = False
    try:
        pre_existing_agents = _live_agent_ids(deps, user_id)
        _apply_web_search_fixture(script.get("web_search_fixture"))
        user_profile = _read_user_profile(deps, user_id)
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
        # Rows are recorded as they land so a failure mid-seed still reaps them.
        _seed_agents(deps, user_id, script.get("seed_agents", []), seeded_agent_ids)
        for request in script.get("seed_attention_requests", []):
            seeded_request_ids.extend(_seed_attention_requests(deps, user_id, [request]))
        seed_documents = script.get("seed_documents", [])
        for document in seed_documents:
            seeded_document_ids.extend(_seed_documents(deps, user_id, [document]))
        print(
            f"    📱 SMS bench: user={user_id[:8]} phone={phone[:7]}**** "
            f"seeded_history={len(seed_messages)} seeded_agents={len(seeded_agent_ids)} "
            f"seeded_documents={len(seeded_document_ids)} seeded_requests={len(seeded_request_ids)} "
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
                _remember_sms_committed_roots(deps, result.owned_agent_ids)
                print(
                    f"    📨 turn {index}: {result.inbound!r} → {len(result.outbound)} SMS "
                    f"in {result.duration_seconds:.1f}s"
                )
                for message in result.outbound:
                    print(f"       ↳ {message[:140]}")

        passed, failure_reason, evaluator_results = await evaluate_sms_turns(
            task, turns, build_judge_scenario(script, user_profile)
        )
    except asyncio.CancelledError as exc:
        cancellation = exc
        execution_error = True
        failure_reason = "SMS runner cancelled"
        raise
    except Exception as exc:  # a harness error is a task failure, not a crash
        execution_error = True
        passed = False
        failure_reason = f"SMS runner error: {exc}"
        evaluator_results = []
    finally:
        try:
            cleanup_receipt = await _cleanup(
                deps, user_id, seeded_agent_ids, pre_existing_agents,
                seeded_document_ids, seeded_request_ids, base_url=base_url,
                outcome={"name": task.name, "passed": passed, "failure_reason": failure_reason,
                         "deadline_at_ms": task_deadline_at_ms,
                         "benchmark_status": "ERROR" if execution_error else "PASSED" if passed else "FAILED"},
            )
        except Exception as exc:
            cleanup_error = str(exc) or type(exc).__name__
            if isinstance(exc, SmsCleanupError):
                cleanup_receipt = exc.receipt
            execution_error = True
            passed = False
            failure_reason = "; ".join(filter(None, [failure_reason, f"SMS cleanup failed: {cleanup_error}"]))

        if cancellation is not None:
            cancellation.owned_cleanup_receipt = cleanup_receipt
            cancellation.owned_cleanup_error = cleanup_error

    total_outbound = sum(len(turn.outbound) for turn in turns)
    return TaskResult(
        name=task.name,
        passed=passed,
        agent_id="",
        status="COMPLETED" if passed else "FAILED",
        benchmark_status="ERROR" if execution_error else "PASSED" if passed else "FAILED",
        progress_score=1.0 if passed else 0.0,
        duration_seconds=round(time.monotonic() - started, 1),
        cost_cents=0.0,
        message_count=total_outbound + len(turns),
        failure_reason=failure_reason,
        stop_metadata={
            "runner": "sms",
            "owned_cleanup_verified": cleanup_receipt is not None and cleanup_receipt.get("verified") is True,
            "owned_cleanup_receipt": cleanup_receipt,
            "owned_cleanup_error": cleanup_error,
            "turns": build_report_transcript(turns),
            "declared_evaluators": evaluator_results,
        },
    )


async def _cleanup_owned_sms_roots(
    module: Any, base_url: str, user_id: str, owned_ids: set[str], seeded_ids: set[str], outcome: dict
) -> dict:
    """Retain SMS identities until canonical exact-tree cleanup and native closure agree."""
    from temporalio.client import Client, WorkflowExecutionStatus
    from config import load_config
    from temporal_connection import temporal_connect_options

    evidence = {"verified": False, "owned_agent_ids": sorted(owned_ids), "root_agent_ids": []}
    receipt_path = None
    try:
        if module.cloud_batch_cleanup.contract() is None:
            raise RuntimeError("SMS native cleanup requires an owned isolated stack")
        queue = module._local_benchmark_task_queue(base_url)
        if not queue or not owned_ids or not seeded_ids.issubset(owned_ids):
            raise RuntimeError("SMS exact-root cleanup ownership is incomplete")
        if any(str(uuid.UUID(aid)) != aid for aid in owned_ids):
            raise RuntimeError("SMS exact-root identity is invalid")

        def read_rows(ids: set[str]) -> list[dict]:
            literals = ",".join(module._sql_literal(aid) for aid in sorted(ids))
            rows = json.loads(module._run_local_victoria_sql(
                'SELECT COALESCE(json_agg(json_build_object('
                "'id',id,'user_id',\"userId\",'parent_id',\"parentAgentId\","
                "'workflow_id',\"temporalWorkflowId\",'first_run_id',\"temporalFirstExecutionRunId\","
                "'queue',\"workflowTaskQueue\",'start_pending',\"temporalWorkflowStartPending\","
                "'cleanup_pending',\"temporalCleanupPending\",'stale_workflow_id',\"staleTemporalWorkflowId\","
                "'stale_first_run_id',\"staleTemporalFirstExecutionRunId\")), '[]'::json)::text "
                f'FROM "Agent" WHERE id IN ({literals});'
            ))
            if {row["id"] for row in rows} != ids or any(row["user_id"] != user_id for row in rows):
                raise RuntimeError("SMS exact-root rows or owner changed")
            return rows

        context = pathlib.Path(os.environ["BENCHMARK_CONTEXT_DIR"])
        receipt_path = context / ("sms-owned-cleanup-" + sorted(owned_ids)[0] + ".json")
        evidence["receipt_path"] = str(receipt_path)

        def save() -> None:
            temporary = receipt_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(evidence, indent=2) + "\n")
            temporary.chmod(0o600)
            temporary.replace(receipt_path)

        save()
        rows = read_rows(owned_ids)
        if any(row["parent_id"] is not None and row["parent_id"] not in owned_ids for row in rows):
            raise RuntimeError("SMS newly observed child belongs to a pre-existing owner")
        roots = {row["id"] for row in rows if row["parent_id"] is None}
        if not roots:
            raise RuntimeError("SMS native cleanup lacks a positively owned root")
        evidence.update({"root_agent_ids": sorted(roots), "before_rows": rows,
                         "native_workflows": [], "canonical_cleanup": {}})
        bindings = {}

        def bind(workflow_id: str, first_run_id: str, agent_id: str) -> None:
            key = (workflow_id, first_run_id)
            if key in bindings and bindings[key] != agent_id:
                raise RuntimeError("SMS workflow generation is bound to multiple agents")
            bindings[key] = agent_id
        for row in rows:
            if row["start_pending"]:
                raise RuntimeError("SMS workflow creation outcome is not yet known")
            if row["workflow_id"]:
                if not row["first_run_id"] or (row["queue"] is not None and row["queue"] != queue):
                    raise RuntimeError("SMS workflow generation or owned queue is unproved")
                bind(row["workflow_id"], row["first_run_id"], row["id"])
            elif row["id"] not in seeded_ids:
                raise RuntimeError("SMS spawned root lacks a persisted workflow generation")
            if row["stale_workflow_id"]:
                if not row["stale_first_run_id"]:
                    raise RuntimeError("SMS stale generation is unproved")
                bind(row["stale_workflow_id"], row["stale_first_run_id"], row["id"])
        client = None
        if bindings:
            cfg = load_config().temporal
            async with asyncio.timeout(15):
                client = await Client.connect(cfg.address, **temporal_connect_options(cfg.address, cfg.namespace, cfg.api_key))
            for workflow_id, first_run_id in bindings:
                description = await client.get_workflow_handle(workflow_id).describe(rpc_timeout=timedelta(seconds=15))
                evidence.setdefault("native_before", []).append({"workflow_id": workflow_id,
                    "first_run_id": description.raw_info.first_run_id, "queue": description.task_queue,
                    "status": description.status.name if description.status is not None else None})
                if description.task_queue != queue or description.raw_info.first_run_id != first_run_id:
                    raise RuntimeError("SMS native workflow generation or queue is unproved")
        save()
        # The callback never introduces a second termination path or a queue-wide reaper.
        results = [TaskResult(name=outcome["name"], passed=outcome["passed"], agent_id=aid,
                              status="COMPLETED" if outcome["passed"] else "FAILED",
                              progress_score=1.0 if outcome["passed"] else 0.0, duration_seconds=0,
                              cost_cents=0, message_count=0, failure_reason=outcome.get("failure_reason"),
                              logs={}) for aid in sorted(roots)]
        try:
            await module._finalize_owned_cloud_batch(base_url, results, {})
        finally:
            evidence["canonical_cleanup"] = {row.agent_id: row.logs for row in results}
            save()
        final_ids = set(owned_ids)
        for row in results:
            final_ids.update(row.logs["cloud_cleanup_evidence"]["final"]["tree_agent_ids"])
        after = read_rows(final_ids)
        evidence["after_rows"] = after
        save()
        if any(row["start_pending"] for row in after):
            save()
            raise RuntimeError("SMS terminal generation cleanup is still pending")
        for row in after:
            if row["workflow_id"]:
                if not row["first_run_id"] or (row["queue"] is not None and row["queue"] != queue):
                    raise RuntimeError("SMS terminal generation or queue changed")
                bind(row["workflow_id"], row["first_run_id"], row["id"])
            if row["stale_workflow_id"]:
                if not row["stale_first_run_id"]:
                    raise RuntimeError("SMS stale terminal generation is unproved")
                bind(row["stale_workflow_id"], row["stale_first_run_id"], row["id"])
        evidence["terminal_obligation_receipt_path"] = str(context / ("sms-terminal-obligations-" + sorted(roots)[0] + ".json"))
        save()
        drain = await _drain_owned_sms_obligations(module, base_url, user_id, final_ids, roots, bindings, outcome,
                                                  pathlib.Path(evidence["terminal_obligation_receipt_path"]))
        evidence["terminal_obligations"] = drain
        terminal_rows = read_rows(final_ids)
        if (sorted(terminal_rows, key=lambda row: row["id"]) != sorted(drain.get("agent_rows_after", []), key=lambda row: row["id"])
                or any(row["start_pending"] or row["cleanup_pending"] for row in terminal_rows)):
            raise RuntimeError("SMS canonical obligation receipt or final owned rows changed")
        evidence["after_rows"] = terminal_rows
        save()
        # The canonical consumer seals the DB pointer. Retain the original real bindings;
        # its tombstone is not a workflow to describe.
        if bindings:
            if client is None:
                cfg = load_config().temporal
                async with asyncio.timeout(15):
                    client = await Client.connect(cfg.address, **temporal_connect_options(cfg.address, cfg.namespace, cfg.api_key))
            for (workflow_id, first_run_id), aid in sorted(bindings.items()):
                description = await client.get_workflow_handle(workflow_id, first_execution_run_id=first_run_id).describe(
                    rpc_timeout=timedelta(seconds=15)
                )
                if (description.task_queue != queue or description.raw_info.first_run_id != first_run_id
                        or description.status is None or description.status in {WorkflowExecutionStatus.RUNNING, WorkflowExecutionStatus.CONTINUED_AS_NEW}):
                    raise RuntimeError("SMS native workflow terminal generation is unproved")
                evidence["native_workflows"].append({"agent_id": aid, "workflow_id": workflow_id,
                    "first_run_id": first_run_id, "run_id": description.run_id, "queue": queue,
                    "status": description.status.name, "observed_at": datetime.now(timezone.utc).isoformat()})
        evidence["verified"] = True
        save()
        return evidence

    except asyncio.CancelledError as exc:
        evidence["verified"] = False
        evidence["error"] = "SMS owned native cleanup cancelled"
        if receipt_path is not None:
            save()
        exc.owned_cleanup_receipt = evidence
        raise
    except Exception as exc:
        evidence["verified"] = False
        evidence["error"] = str(exc) or type(exc).__name__
        if receipt_path is not None:
            try:
                save()
            except Exception as save_error:
                evidence["receipt_write_error"] = str(save_error) or type(save_error).__name__
        raise SmsCleanupError(evidence["error"], evidence) from exc


def build_deps_from_module(
    module: Any, other_task_roots: Callable[[], set[str]] | None = None,
    on_agent_created: Callable[[str, str], None] | None = None, task_name: str = "",
) -> SmsRunnerDeps:
    """Bind the runner to run_benchmark's local-stack helpers."""
    return SmsRunnerDeps(
        run_sql=module._run_local_victoria_sql,
        sql_literal=module._sql_literal,
        is_local_base_url=module._is_local_base_url,
        benchmark_user_id=module._current_benchmark_user_id,
        cleanup_agents=lambda *args: _cleanup_owned_sms_roots(module, *args),
        other_task_roots=other_task_roots,
        on_agent_created=on_agent_created,
        task_name=task_name,
    )


async def _drain_owned_sms_obligations(module: Any, base_url: str, user_id: str, owned_ids: set[str], roots: set[str],
                                       bindings: dict, outcome: dict, receipt_path: pathlib.Path) -> dict:
    """Use the canonical exact-agent outbox consumer on the active isolated stack only."""
    context = pathlib.Path(os.environ["BENCHMARK_CONTEXT_DIR"])
    manifest_path = context / "services.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("SMS canonical drain lacks an owned services manifest")
    manifest = json.loads(manifest_path.read_text())
    owner = json.loads((context / "local-stack-owner.json").read_text())
    queue = module._local_benchmark_task_queue(base_url)
    if (not module._services_manifest_is_active(manifest) or manifest.get("status") != "running"
            or pathlib.Path(manifest.get("worktree", "")).resolve() != REPO_ROOT or manifest.get("benchmark_mode") is not True
            or manifest.get("run_sh_pid") != owner.get("pid") or not owner.get("native_identity") or not owner.get("token")
            or manifest.get("temporal_task_queue") != queue or base_url != f"http://localhost:{manifest.get('ports', {}).get('backend')}"):
        raise RuntimeError("SMS canonical drain active stack identity is unproved")
    from benchmarks.local import _process_identity_tools
    if _process_identity_tools()["current_identity"](owner["pid"]) != owner["native_identity"]:
        raise RuntimeError("SMS canonical drain stack PID birth changed")
    database_url = module.manifest_database_url(manifest)
    parsed = urlparse(database_url)
    if parsed.scheme != "postgresql" or parsed.hostname != "localhost" or parsed.path != "/" + manifest["database"]["name"]:
        raise RuntimeError("SMS canonical drain database is not the owned local target")
    deadline_at_ms = int(outcome.get("deadline_at_ms", (time.time() + 15.0) * 1000))
    if deadline_at_ms <= time.time() * 1000:
        raise RuntimeError("SMS task cleanup deadline expired")
    request_path = receipt_path.with_suffix(".request.json")
    request = {"context_dir": str(context.resolve()), "receipt_path": str(receipt_path.resolve()), "base_url": base_url,
               "user_id": user_id, "owned_agent_ids": sorted(owned_ids), "root_agent_ids": sorted(roots), "queue": queue,
               "bindings": [{"workflow_id": workflow, "first_run_id": first, "agent_id": agent}
                            for (workflow, first), agent in sorted(bindings.items())],
               "deadline_at_ms": deadline_at_ms, "outcome": {k:outcome.get(k) for k in ("name", "passed", "failure_reason", "benchmark_status")},
               "world_model_mode": os.environ.get("BENCHMARK_WORLD_MODEL_MODE", "real")}
    request_path.write_text(json.dumps(request, indent=2) + "\n"); request_path.chmod(0o600)
    env = os.environ.copy(); env.update({"DATABASE_URL": database_url, "DIRECT_URL": database_url})
    console_path = receipt_path.with_suffix(".console.log")
    remaining = (deadline_at_ms - time.time() * 1000) / 1000
    if remaining <= 0:
        raise RuntimeError("SMS task cleanup deadline expired before child launch")
    process = None
    native_identity = None
    tools = _process_identity_tools()
    with console_path.open("wb") as console:
        console_path.chmod(0o600)
        try:
            process = await asyncio.create_subprocess_exec(
                "node", "--import", "tsx", "scripts/finalize-sms-owned-cleanup.ts", str(request_path),
                cwd=REPO_ROOT / "back-end", env=env, stdout=console, stderr=asyncio.subprocess.STDOUT)
            if process.returncode is None:
                native_identity = tools["current_identity"](process.pid)
            async with asyncio.timeout((deadline_at_ms - time.time() * 1000) / 1000):
                await process.wait()
        finally:
            if process is not None and process.returncode is None:
                # Retire only this child, fenced by its captured native PID birth.
                if native_identity is None or tools["main"](["process-identity", "--expect", native_identity,
                                                            "--signal", "TERM", str(process.pid)]) != 0:
                    raise RuntimeError("SMS canonical drain child identity or retirement is unproved")
                retiring = asyncio.create_task(process.wait())
                retirement_deadline = time.monotonic() + 15.0
                while not retiring.done() and time.monotonic() < retirement_deadline:
                    try:
                        await asyncio.wait([retiring], timeout=max(0.0, retirement_deadline - time.monotonic()))
                    except asyncio.CancelledError:
                        continue
                if not retiring.done():
                    if tools["main"](["process-identity", "--expect", native_identity,
                                      "--signal", "KILL", str(process.pid)]) != 0:
                        retiring.cancel()
                        raise RuntimeError("SMS canonical drain exact child kill or retirement is unproved")
                    native_wait_deadline = time.monotonic() + 15.0
                    while not retiring.done() and time.monotonic() < native_wait_deadline:
                        try:
                            await asyncio.wait([retiring], timeout=max(0.0, native_wait_deadline - time.monotonic()))
                        except asyncio.CancelledError:
                            continue
                    if not retiring.done():
                        retiring.cancel()
                        raise RuntimeError("SMS canonical drain exact child retirement deadline expired")
                retiring.result()
    if process.returncode != 0 or not receipt_path.is_file():
        raise RuntimeError("SMS canonical obligation drain failed; private receipt retained")
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("verified") is not True or receipt.get("child_handles_retired") is not True:
        raise RuntimeError("SMS canonical obligation closure or child handles are unproved")
    return receipt
