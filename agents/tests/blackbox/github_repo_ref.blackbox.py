"""Blackbox tests: new agents and code agents keep (or explicitly select) their GitHub repo.

User report: "Whenever I create a new rose agent, it loses the ref to the gh project."

Observable surface (task 4, repository-aware code agent creation):
  - spawn_agent accepts ``github_repo_ref`` (canonical ``gh:owner/repo``, a GitHub URL,
    ``owner/repo`` or a Rose project id). The agent side forwards it verbatim; the
    backend resolves it and owns the precedence (providers/githubRepos/resolve.ts):
    explicit ref > trusted server repo > explicit project's repo > parent's ref >
    inherited project's repo.
  - Sub-agent create (single POST /api/agents and batch POST /api/agents/batch) sends
    the explicit ref; without one it sends only ``parent_agent_id`` so the backend
    inherits the parent's persisted ref. The returned ``github_repo_ref`` is surfaced.
  - Code-session create carries the explicit ref (not overridden by the project
    restore). A ``code_session_id`` resume keeps the session's own repo: the ref is
    not sent with it.
  - An unconnected or disconnected ref fails naming the ref: 404 at agent create
    (non-retryable for a batch), 403 GITHUB_ACCESS_DENIED at session create
    (non-retryable typed error, ERROR tool row). Never a silent fallback to another repo.

The fake backend below implements that documented contract (canonical refs, spellings,
precedence, 404 / 403) so each case checks what the agent side sends and surfaces; the
backend's own resolution is covered by back-end/src/tests/unit/agent-repo-ref-propagation.test.ts.
"""

import asyncio
import json
import re
from contextlib import contextmanager
from unittest.mock import patch

import httpx
from _test_utils import BlackboxResult, get_captured_requests, setup_mock_fn, teardown_mock
from temporalio.exceptions import ActivityError, ApplicationError, RetryState

ROSE_REF = "gh:rose-ai-labs/rose"
ROSE_URL = "https://github.com/Rose-Ai-Labs/rose"
ROSE_PROJECT_ID = "0b6c3a1e-5d2f-4c4b-9a51-2f0f6f6c1d10"
OTHER_REF = "gh:acme/other"
OTHER_URL = "https://github.com/acme/other"
# Connected once, then disconnected (the backend keeps a NOT_CONNECTED tombstone).
STALE_REF = "gh:acme/disconnected"
SCHEMA = {"fields": [{"name": "summary", "type": "str", "description": "What changed", "required": True}]}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class FakeBackend:
    """The foundation's agent-create and code-session-create repo contract."""

    def __init__(self, parent_ref=ROSE_REF, agent_project_repo=OTHER_URL):
        self.connections = {ROSE_REF: ROSE_URL, OTHER_REF: OTHER_URL}
        self.projects = {ROSE_PROJECT_ID: ROSE_URL}
        self.parent_ref = parent_ref
        self.agent_project_repo = agent_project_repo
        self.sessions = {"5d0f9a43-6a1b-4a0e-8d55-0d0c1c2b3a4f": OTHER_URL}

    def resolve(self, ref):
        value = ref.strip()
        project_id = value[len("rose-project:") :] if value.startswith("rose-project:") else value
        if UUID.match(project_id):
            url = self.projects.get(project_id)
            return self.resolve(url) if url else None
        match = re.match(r"^(?:gh:|https?://github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", value, re.I)
        if not match:
            return None
        canonical = f"gh:{match.group(1)}/{match.group(2)}".lower()
        return canonical if canonical in self.connections else None

    def create_agent(self, body):
        if "github_repo_ref" in body:
            explicit = body["github_repo_ref"]
            if explicit is None:
                return None
            canonical = self.resolve(explicit)
            if canonical is None:
                raise LookupError(explicit)
            return canonical
        return self.parent_ref if body.get("parent_agent_id") else None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        body = json.loads(request.content or b"{}")
        try:
            if url.endswith("/api/agents"):
                ref = self.create_agent(body)
                return httpx.Response(
                    201,
                    json={
                        "agent_id": body.get("agent_id", "child-1"),
                        "temporal_workflow_id": "wf-child-1",
                        "goal": body["goal"],
                        "model": body["model"],
                        "status": "STARTING_UP",
                        "github_repo_ref": ref,
                    },
                )
            if url.endswith("/api/agents/batch"):
                results = [
                    {
                        "agent_id": item["agent_id"],
                        "status": "STARTING_UP",
                        "temporal_workflow_id": item["agent_id"],
                        "goal": item["goal"],
                        "model": item["model"],
                        "github_repo_ref": self.create_agent(item),
                    }
                    for item in body["agents"]
                ]
                return httpx.Response(201, json={"results": results})
        except LookupError:
            return httpx.Response(404, json={"error": "GitHub repo not connected", "code": "GITHUB_REPO_NOT_CONNECTED"})
        if url.endswith("/api/claude-code-session/create"):
            if body.get("code_session_id"):
                repo = self.sessions[body["code_session_id"]]
            elif body.get("github_repo_ref"):
                canonical = self.resolve(body["github_repo_ref"])
                if canonical is None:
                    return httpx.Response(
                        403,
                        json={
                            "error": f"GitHub repo {body['github_repo_ref']} is not connected for this user",
                            "code": "GITHUB_ACCESS_DENIED",
                        },
                    )
                repo = self.connections[canonical]
            else:
                repo = self.agent_project_repo  # the project restore
            return httpx.Response(
                200,
                json={
                    "task_id": "task-1",
                    "sandbox_id": "sbx-1",
                    "ws_url": "wss://sbx-1",
                    "github_repo_url": repo,
                    "code_session_id": body.get("code_session_id") or "cs-new",
                },
            )
        return httpx.Response(404, json={"error": f"No mock for {url}"})


def _bodies(path_suffix):
    return [
        json.loads(call["requestBody"])
        for call in get_captured_requests()
        if call["url"].endswith(path_suffix) and call["requestBody"]
    ]


@contextmanager
def _backend(fake):
    teardown_mock()
    setup_mock_fn(fake)
    from domains.spawn_sub_agents import service

    # Outside a worker, heartbeats have no activity context.
    with patch.object(service.activity, "heartbeat"):
        yield fake
    teardown_mock()


async def _spawn_one(agent_cfg):
    from domains.spawn_sub_agents.service import spawn_sub_agent_activity

    return await spawn_sub_agent_activity(
        "u-1", [agent_cfg], "parent-agent", "wf-parent", 1, False, parent_attachments={}
    )


# ── 1. new agent creation keeps the connected repo (each path) ─────────────────


async def test_nested_spawn_inherits_connected_repo_ref():
    with _backend(FakeBackend(parent_ref=ROSE_REF)):
        result = await _spawn_one({"goal": "child", "output_schema": SCHEMA})
        body = _bodies("/api/agents")[0]
    assert result["agents"][0]["github_repo_ref"] == ROSE_REF, result
    # Inheritance is the backend's: the parent id is sent, never a guessed ref.
    assert body["parent_agent_id"] == "parent-agent"
    assert "github_repo_ref" not in body, body


async def test_nested_spawn_explicit_spellings_persist_canonical_ref():
    for spelling in (
        ROSE_REF,
        ROSE_URL + ".git",
        "Rose-Ai-Labs/rose",
        ROSE_PROJECT_ID,
        f"rose-project:{ROSE_PROJECT_ID}",
    ):
        with _backend(FakeBackend(parent_ref=None)):
            result = await _spawn_one({"goal": "child", "output_schema": SCHEMA, "github_repo_ref": f" {spelling} "})
            body = _bodies("/api/agents")[0]
        assert body["github_repo_ref"] == spelling, body
        assert result["agents"][0]["github_repo_ref"] == ROSE_REF, (spelling, result)


async def test_batch_for_each_create_returns_canonical_ref():
    from domains.spawn_sub_agents.service import spawn_sub_agents_batch_activity

    cfgs = [
        {"goal": "item 0", "output_schema": SCHEMA, "github_repo_ref": "Rose-Ai-Labs/rose"},
        {"goal": "item 1", "output_schema": SCHEMA},
    ]
    with _backend(FakeBackend(parent_ref=ROSE_REF)):
        result = await spawn_sub_agents_batch_activity(
            "u-1", cfgs, "parent-agent", "wf-parent", 1, False, parent_attachments={}, child_agent_ids=["c0", "c1"]
        )
        batch = _bodies("/api/agents/batch")[0]["agents"]
    assert [a["github_repo_ref"] for a in result["agents"]] == [ROSE_REF, ROSE_REF], result
    assert batch[0]["github_repo_ref"] == "Rose-Ai-Labs/rose" and "github_repo_ref" not in batch[1], batch
    assert all(item["parent_agent_id"] == "parent-agent" for item in batch)


async def test_spawn_agent_routes_forward_explicit_ref():
    import domains.spawn_agent.handler as handler

    captured = {}

    class _Manager:
        def __init__(self, key):
            self.key = key

        async def execute_tool(self, _instance, tool_call, _tool_call_id, **_kwargs):
            captured[self.key] = tool_call
            return
            yield

    class _Instance:
        world_model_mode = "real"

    manager = handler.SpawnAgentManager()
    call = {"goal": "g", "output_schema": SCHEMA, "github_repo_ref": "  gh:rose-ai-labs/rose ", "task_name": "t"}
    with (
        patch.object(handler, "get_code_manager", lambda: _Manager("code")),
        patch.object(handler, "get_sub_agent_manager", lambda: _Manager("sub")),
    ):
        async for _ in manager._spawn_code(_Instance(), dict(call), "tc-code"):
            pass
        async for _ in manager._spawn_sub_agent(_Instance(), dict(call), "tc-sub"):
            pass
        async for _ in manager._spawn_code(_Instance(), {"goal": "g", "output_schema": SCHEMA}, "tc-none"):
            pass
    assert captured["sub"]["sub_agent"]["github_repo_ref"] == ROSE_REF, captured
    # The last _spawn_code (no ref) replaced captured["code"]: it carries none.
    assert "github_repo_ref" not in captured["code"], captured


async def test_spawn_agent_code_route_keeps_ref_next_to_legacy_link():
    import domains.spawn_agent.handler as handler

    seen = []

    class _Manager:
        async def execute_tool(self, _instance, tool_call, _tool_call_id, **_kwargs):
            seen.append(tool_call)
            return
            yield

    class _Instance:
        world_model_mode = "real"

    with patch.object(handler, "get_code_manager", lambda: _Manager()):
        async for _ in handler.SpawnAgentManager()._spawn_code(
            _Instance(),
            {"goal": "g", "output_schema": SCHEMA, "github_repo_link": OTHER_URL, "github_repo_ref": ROSE_REF},
            "tc-code",
        ):
            pass
    assert seen[0]["github_repo_ref"] == ROSE_REF and seen[0]["github_repo_link"] == OTHER_URL, seen


class _Stop(Exception):
    pass


async def test_for_each_route_puts_ref_on_every_child_cfg():
    import domains.spawn_agent.handler as handler

    batch_args = []

    class _Info:
        workflow_id = "wf-parent"

    class _Workflow:
        @staticmethod
        def info():
            return _Info()

        @staticmethod
        def uuid4():
            return f"child-{len(batch_args)}-{id(object())}"

        @staticmethod
        async def execute_activity(fn, args=None, **_kwargs):
            if fn.__name__ == "fetch_parent_attachments_activity":
                return {}
            batch_args.append(args)
            raise _Stop()

    class _Instance:
        user_id = "u-1"
        agent_id = "parent-agent"
        depth = 0
        bus_id = "bus-1"
        is_paused = False
        fast_mode_cache_enabled = False

        def __init__(self):
            self.child_tool_ids, self.pending_children, self.child_workflow_ids = {}, set(), {}

    async def _no_wait(*_args, **_kwargs):
        return None

    call = {"goal": "do {item}", "items": ["a", "b"], "output_schema": SCHEMA, "github_repo_ref": OTHER_REF}
    with (
        patch.object(handler, "workflow", _Workflow),
        patch.object(handler, "wait_condition_or_generation_handoff", _no_wait),
    ):
        try:
            async for _ in handler.SpawnAgentManager()._spawn_for_each(_Instance(), call, "tc-each"):
                pass
            raise AssertionError("expected the batch activity to be scheduled")
        except _Stop:
            pass
    cfgs = batch_args[0][1]
    assert [cfg.get("github_repo_ref") for cfg in cfgs] == [OTHER_REF, OTHER_REF], cfgs


# ── 2. explicit selection reaches the code-session create (not the project restore) ─


async def test_code_session_create_carries_explicit_ref_over_project_restore():
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    with _backend(FakeBackend(agent_project_repo=OTHER_URL)):
        session = await create_e2b_session(agent_id="a-1", goal="fix", user_id="u-1", github_repo_ref=ROSE_REF)
        payload = _bodies("/api/claude-code-session/create")[0]
    assert payload["github_repo_ref"] == ROSE_REF, payload
    assert session["github_repo_url"] == ROSE_URL, session

    # Without a ref the project restore stays in charge (legacy behaviour unchanged).
    with _backend(FakeBackend(agent_project_repo=OTHER_URL)):
        session = await create_e2b_session(agent_id="a-1", goal="fix", user_id="u-1")
        payload = _bodies("/api/claude-code-session/create")[0]
    assert "github_repo_ref" not in payload and session["github_repo_url"] == OTHER_URL


class _Handle:
    def __init__(self, raise_exc):
        self._raise_exc = raise_exc

    def done(self):
        return True

    def cancel(self):
        pass

    def __await__(self):
        async def _inner():
            raise self._raise_exc

        return _inner().__await__()


class _CodeWorkflow:
    class ActivityCancellationType:
        TRY_CANCEL = "TRY_CANCEL"
        WAIT_CANCELLATION_COMPLETED = "WAIT_CANCELLATION_COMPLETED"

    def __init__(self, handle):
        self._handle = handle
        self.started = []

    def start_activity(self, fn, args=None, **kwargs):
        self.started.append((fn.__name__, args))
        return self._handle

    async def wait_condition(self, predicate):
        return None

    @staticmethod
    def now():
        from datetime import datetime, timezone

        return datetime(2026, 11, 12, tzinfo=timezone.utc)

    async def execute_activity(self, fn, args=None, **kwargs):
        if fn.__name__ == "resolve_code_agent_provider_activity":
            return args[0]
        raise AssertionError(f"unexpected activity {fn.__name__}")


class _CodeInstance:
    def __init__(self):
        self.user_id = "u-1"
        self.agent_id = "agent-repo-ref"
        self.model = "rose-labs/rose-1-flash"
        self.is_paused = False


def _denied_activity_error(ref):
    from helpers.github_repo_ref import GITHUB_REPO_REF_DENIED_CODE, repo_ref_denied_message

    cause = ApplicationError(
        repo_ref_denied_message(ref, f"GitHub repo {ref} is not connected for this user"),
        type=GITHUB_REPO_REF_DENIED_CODE,
        non_retryable=True,
    )
    error = ActivityError(
        "Activity task failed",
        scheduled_event_id=1,
        started_event_id=2,
        identity="w",
        activity_type="spawn_claude_code_activity",
        activity_id="1",
        retry_state=RetryState.NON_RETRYABLE_FAILURE,
    )
    error.__cause__ = cause
    return error


async def _run_code_tool(tool_call, error):
    import domains.spawn_claude_code_agent.handler as handler
    from domains.spawn_claude_code_agent.handler import SpawnClaudeCodeAgentManager

    fake = _CodeWorkflow(_Handle(error))
    with patch.object(handler, "workflow", fake):
        events = [e async for e in SpawnClaudeCodeAgentManager().execute_tool(_CodeInstance(), tool_call, "tc-ref")]
    return fake, events


async def test_code_tool_schedules_explicit_ref_in_session_request():
    fake, _ = await _run_code_tool(
        {"goal": "fix", "output_schema": SCHEMA, "github_repo_ref": f" {ROSE_REF} ", "github_repo_link": OTHER_URL},
        _denied_activity_error(ROSE_REF),
    )
    name, args = fake.started[0]
    assert name == "spawn_claude_code_activity"
    # args[16] is code_session_request: the ref rides there, positional args unchanged.
    assert args[16]["github_repo_ref"] == ROSE_REF, args[16]
    assert args[7] == OTHER_URL


# ── 3. explicit ref wins over a different inherited ref ───────────────────────────


async def test_explicit_ref_wins_over_parent_ref_deterministically():
    for _ in range(3):
        with _backend(FakeBackend(parent_ref=OTHER_REF)):
            result = await _spawn_one({"goal": "child", "output_schema": SCHEMA, "github_repo_ref": ROSE_REF})
            body = _bodies("/api/agents")[0]
        assert body["github_repo_ref"] == ROSE_REF and body["parent_agent_id"] == "parent-agent", body
        assert result["agents"][0]["github_repo_ref"] == ROSE_REF, result
    # Same parent, no explicit ref: inherits the parent's (different) repo.
    with _backend(FakeBackend(parent_ref=OTHER_REF)):
        inherited = await _spawn_one({"goal": "child", "output_schema": SCHEMA})
    assert inherited["agents"][0]["github_repo_ref"] == OTHER_REF, inherited


# ── 4. unconnected / stale refs fail clearly, no fallback ─────────────────────────


async def test_agent_create_unconnected_ref_fails_naming_ref_without_fallback():
    with _backend(FakeBackend(parent_ref=ROSE_REF)):
        result = await _spawn_one({"goal": "child", "output_schema": SCHEMA, "github_repo_ref": STALE_REF})
        bodies = _bodies("/api/agents")
    child = result["agents"][0]
    assert child["status"] == "FAILED" and result["failed"] == 1, result
    assert STALE_REF in child["error"] and "not connected" in child["error"] and "HTTP 404" in child["error"], child
    # One request, still carrying the ref: no retry, no re-post without it.
    assert len(bodies) == 1 and bodies[0]["github_repo_ref"] == STALE_REF, bodies


async def test_batch_unconnected_ref_is_non_retryable_and_names_ref():
    from domains.spawn_sub_agents.service import spawn_sub_agents_batch_activity

    with _backend(FakeBackend(parent_ref=ROSE_REF)):
        try:
            await spawn_sub_agents_batch_activity(
                "u-1",
                [{"goal": "i0", "output_schema": SCHEMA, "github_repo_ref": STALE_REF}],
                "parent-agent",
                "wf-parent",
                1,
                False,
                parent_attachments={},
            )
            raise AssertionError("expected GITHUB_REPO_NOT_CONNECTED")
        except ApplicationError as error:
            assert error.type == "GITHUB_REPO_NOT_CONNECTED" and error.non_retryable is True
            assert STALE_REF in error.message and "HTTP 404" in error.message, error.message
        assert len(_bodies("/api/agents/batch")) == 1


async def test_code_session_unconnected_ref_raises_typed_403():
    from domains.spawn_claude_code_agent.repo import create_e2b_session

    with _backend(FakeBackend()):
        try:
            await create_e2b_session(agent_id="a-1", goal="fix", user_id="u-1", github_repo_ref=STALE_REF)
            raise AssertionError("expected GITHUB_REPO_REF_DENIED")
        except ApplicationError as error:
            assert error.type == "GITHUB_REPO_REF_DENIED" and error.non_retryable is True
            assert STALE_REF in error.message and "GITHUB_ACCESS_DENIED" in error.message, error.message
        assert len(_bodies("/api/claude-code-session/create")) == 1


async def test_code_tool_ref_denial_is_error_row_not_fallback():
    from tools.base import MessageStatus

    fake, events = await _run_code_tool(
        {"goal": "fix", "output_schema": SCHEMA, "github_repo_ref": STALE_REF}, _denied_activity_error(STALE_REF)
    )
    terminal = events[-1]
    assert terminal.status == MessageStatus.ERROR, terminal.status
    assert STALE_REF in terminal.message and "not started on any other repo" in terminal.message, terminal.message
    assert terminal.metadata["error_code"] == "GITHUB_REPO_REF_DENIED"
    assert terminal.metadata["code_agent"]["state"] == "failed"
    assert len(fake.started) == 1
    text = " ".join(e.message or "" for e in events)
    # Not the clone-denial soft-fail, whose advice is to drop the repo.
    assert "Do not pass" not in text and "API-only" not in text, text


async def test_code_tool_local_target_with_ref_fails_without_starting():
    from tools.base import MessageStatus

    fake, events = await _run_code_tool(
        {"goal": "fix", "output_schema": SCHEMA, "github_repo_ref": ROSE_REF, "target": "local"},
        _denied_activity_error(ROSE_REF),
    )
    terminal = events[-1]
    assert terminal.status == MessageStatus.ERROR, terminal.status
    assert ROSE_REF in terminal.message and "target='local'" in terminal.message, terminal.message
    assert terminal.metadata["error_code"] == "GITHUB_REPO_REF_DENIED"
    assert terminal.metadata["code_agent"]["state"] == "failed"
    # Neither the local-target lookup nor a code session ran: nothing was silently dropped.
    assert fake.started == [], fake.started


async def test_not_connected_classifier_reads_the_typed_code():
    from helpers.github_repo_ref import is_repo_not_connected_response

    typed = json.dumps({"error": "GitHub repo not connected", "code": "GITHUB_REPO_NOT_CONNECTED"})
    assert is_repo_not_connected_response(404, typed)
    # Same words without the typed code (e.g. a missing folder or route) are not this error.
    assert not is_repo_not_connected_response(404, json.dumps({"error": "GitHub repo not connected"}))
    assert not is_repo_not_connected_response(404, json.dumps({"error": "Folder not found"}))
    assert not is_repo_not_connected_response(403, typed)
    assert not is_repo_not_connected_response(404, "<html>Cannot POST /api/agents</html>")


# ── resume: a code_session_id keeps the session's own repo ────────────────────────


async def test_resume_with_conflicting_ref_keeps_session_repo():
    from domains.spawn_claude_code_agent.repo import create_e2b_session
    from workflows.code_agent_resume import resume_tool_call

    session_id = "5d0f9a43-6a1b-4a0e-8d55-0d0c1c2b3a4f"
    saved = {
        "spawn_args": {"type": "code", "goal": "old", "output_schema": SCHEMA, "github_repo_ref": ROSE_REF},
        "execution": {"code_session_id": session_id},
        "cli_settings": {"model": "m", "reasoning_effort": "high", "speed": "standard"},
    }
    tool_call = resume_tool_call({"message": "continue", "code_session_id": session_id}, saved)
    assert tool_call["code_session_id"] == session_id and tool_call["github_repo_ref"] == ROSE_REF

    with _backend(FakeBackend()):
        session = await create_e2b_session(
            agent_id="a-1",
            goal="continue",
            user_id="u-1",
            code_session_id=tool_call["code_session_id"],
            github_repo_ref=tool_call["github_repo_ref"],
        )
        payload = _bodies("/api/claude-code-session/create")[0]
    assert payload["code_session_id"] == session_id and "github_repo_ref" not in payload, payload
    # The session keeps its own repo (acme/other), not the conflicting explicit ref.
    assert session["github_repo_url"] == OTHER_URL, session

    # Even an unconnected ref cannot fail a resume.
    with _backend(FakeBackend()):
        session = await create_e2b_session(
            agent_id="a-1", goal="continue", user_id="u-1", code_session_id=session_id, github_repo_ref=STALE_REF
        )
    assert session["code_session_id"] == session_id


async def test_spawn_schema_documents_github_repo_ref():
    from utils.tool_schemas import SpawnAgentTool, SpawnAgentToolNoGP

    for tool in (SpawnAgentTool, SpawnAgentToolNoGP):
        description = tool.model_json_schema()["properties"]["github_repo_ref"]["description"]
        for needle in (
            "Normally the project id or 'gh:owner/repo' ref shown in # Available projects",
            "gh:owner/repo",
            "Explicit selection wins over inherited",
            "never falls back",
            "code_session_id",
        ):
            assert needle in description, (tool.__name__, needle)
    parsed = SpawnAgentTool(
        tool="spawn_agent", type="code", task_name="fix_bug", goal="g", output_schema=SCHEMA, github_repo_ref=ROSE_REF
    )
    assert parsed.github_repo_ref == ROSE_REF


async def run_all_tests():
    print("github-repo-ref blackbox tests:")
    r = BlackboxResult()
    await r.record_async("nested_spawn_inherits_connected_ref", test_nested_spawn_inherits_connected_repo_ref)
    await r.record_async("nested_spawn_explicit_spellings", test_nested_spawn_explicit_spellings_persist_canonical_ref)
    await r.record_async("batch_for_each_returns_canonical_ref", test_batch_for_each_create_returns_canonical_ref)
    await r.record_async("spawn_agent_routes_forward_ref", test_spawn_agent_routes_forward_explicit_ref)
    await r.record_async("spawn_agent_code_ref_and_link", test_spawn_agent_code_route_keeps_ref_next_to_legacy_link)
    await r.record_async("for_each_ref_on_every_child", test_for_each_route_puts_ref_on_every_child_cfg)
    await r.record_async(
        "code_session_ref_over_project", test_code_session_create_carries_explicit_ref_over_project_restore
    )
    await r.record_async("code_tool_schedules_ref", test_code_tool_schedules_explicit_ref_in_session_request)
    await r.record_async("explicit_ref_wins_over_parent", test_explicit_ref_wins_over_parent_ref_deterministically)
    await r.record_async(
        "agent_create_unconnected_404", test_agent_create_unconnected_ref_fails_naming_ref_without_fallback
    )
    await r.record_async("batch_unconnected_non_retryable", test_batch_unconnected_ref_is_non_retryable_and_names_ref)
    await r.record_async("code_session_unconnected_403", test_code_session_unconnected_ref_raises_typed_403)
    await r.record_async("code_tool_denial_error_row", test_code_tool_ref_denial_is_error_row_not_fallback)
    await r.record_async(
        "code_tool_local_target_ref_refused", test_code_tool_local_target_with_ref_fails_without_starting
    )
    await r.record_async("not_connected_typed_code", test_not_connected_classifier_reads_the_typed_code)
    await r.record_async("resume_keeps_session_repo", test_resume_with_conflicting_ref_keeps_session_repo)
    await r.record_async("schema_documents_ref", test_spawn_schema_documents_github_repo_ref)
    teardown_mock()
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
