"""Blackbox tests for browser step phase timing (browser.step.phases)."""

import asyncio
import gc
import re
import time
from pathlib import Path

from structlog.testing import capture_logs

from _test_utils import BlackboxResult, setup_mock_fn, teardown_mock

AGENTS_ROOT = Path(__file__).resolve().parents[2]
HANDLER = AGENTS_ROOT / "domains" / "spawn_browser_agent_v3" / "handler.py"


class _FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _timer(clock):
    from domains.spawn_browser_agent_v3.step_timing import StepPhaseTimer

    return StepPhaseTimer(agent_id="agent-1", task_id="task-1", clock=clock)


def test_phases_partition_step_wall_clock():
    clock = _FakeClock()
    timer = _timer(clock)
    timer.start_step(1)
    clock.advance(0.25)
    timer.mark("observe_state")
    clock.advance(3.0)
    timer.mark("llm_decision")
    clock.advance(1.5)
    timer.mark("execute_action")
    clock.advance(0.1)
    summary = timer.finish()

    assert summary["step"] == 1
    assert summary["phases_ms"] == {
        "observe_state": 250,
        "llm_decision": 3000,
        "execute_action": 1500,
        "unattributed": 100,
    }
    assert summary["total_ms"] == sum(summary["phases_ms"].values()) == 4850


def test_repeated_phase_accumulates_and_annotations_attach():
    clock = _FakeClock()
    timer = _timer(clock)
    timer.start_step(7)
    clock.advance(0.2)
    timer.mark("bookkeeping")
    clock.advance(0.3)
    timer.mark("bookkeeping")
    timer.annotate(action="click", llm_round_trip_ms=2900, llm_mode=None)
    summary = timer.finish()

    assert summary["phases_ms"]["bookkeeping"] == 500
    assert summary["action"] == "click"
    assert summary["llm_round_trip_ms"] == 2900
    assert "llm_mode" not in summary


def test_start_step_emits_previous_step_even_on_continue_paths():
    clock = _FakeClock()
    timer = _timer(clock)
    with capture_logs() as logs:
        timer.start_step(1)
        clock.advance(0.4)
        timer.mark("observe_state")
        clock.advance(0.6)
        timer.start_step(2)
        clock.advance(0.1)
        timer.finish()
        assert timer.finish() is None

    events = [entry for entry in logs if entry["event"] == "browser.step.phases"]
    assert [event["step"] for event in events] == [1, 2]
    assert events[0]["phases_ms"] == {"observe_state": 400, "unattributed": 600}
    assert events[0]["total_ms"] == 1000
    assert events[0]["agent_id"] == "agent-1"
    assert events[0]["task_id"] == "task-1"


def test_mark_before_start_is_noop():
    timer = _timer(_FakeClock())
    timer.mark("observe_state")
    timer.annotate(action="click")
    assert timer.finish() is None


def test_browser_loop_marks_every_core_phase():
    source = HANDLER.read_text()
    marked = set(re.findall(r'step_timer\.mark\("([a-z_]+)"\)', source))
    required = {
        "user_control_wait",
        "tab_rebind",
        "overlay_suppress",
        "otp_poll",
        "observe_state",
        "record_observation",
        "thinking_stream_start",
        "llm_decision",
        "thinking_stream_finish",
        "pre_action_bookkeeping",
        "execute_action",
        "post_action_bookkeeping",
    }
    assert required <= marked, f"missing step phases: {sorted(required - marked)}"
    assert "step_timer.start_step(iteration)" in source
    assert "step_timer.finish()" in source


def test_browser_loop_has_no_fixed_inter_step_sleep():
    """The loop must not pay a fixed delay between steps (was 0.5s/step)."""
    from domains.spawn_browser_agent_v3 import config as browser_config

    source = HANDLER.read_text()
    assert not hasattr(browser_config, "ACTION_LOOP_DELAY_SECONDS")
    assert "ACTION_LOOP_DELAY" not in source
    loop_tail = source.split('step_timer.mark("post_action_bookkeeping")')[-1].split("step_timer.finish()")[0]
    assert "asyncio.sleep" not in loop_tail


class _FakeCdpSession:
    def __init__(self, target_id, log):
        self.target_id = target_id
        self.log = log

    async def send(self, method):
        self.log.append(method)
        return {"targetInfo": {"targetId": self.target_id}}

    async def detach(self):
        return None


class _FakePage:
    def __init__(self, target_id):
        self.target_id = target_id
        self.front_calls = 0

    async def bring_to_front(self):
        self.front_calls += 1


class _FakeContext:
    def __init__(self, pages):
        self.pages = pages
        self.cdp_calls = []

    async def new_cdp_session(self, page):
        return _FakeCdpSession(page.target_id, self.cdp_calls)


async def _sync(cache, context, focused, current):
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3.handler import _synchronize_playwright_page_with_agent_focus

    return await _synchronize_playwright_page_with_agent_focus(
        dom_service=SimpleNamespace(session=SimpleNamespace(agent_focus_target_id=focused)),
        playwright_browser=SimpleNamespace(contexts=[context]),
        current_page=current,
        focus_cache=cache,
    )


async def test_tab_focus_cache_skips_repeat_cdp_and_foreground_calls():
    from domains.spawn_browser_agent_v3.handler import TabFocusCache

    page_a, page_b = _FakePage("target-a"), _FakePage("target-b")
    context = _FakeContext([page_a, page_b])
    cache = TabFocusCache()

    assert await _sync(cache, context, "target-a", page_a) is page_a
    first_lookups = len(context.cdp_calls)
    assert first_lookups == 1
    assert page_a.front_calls == 1

    for _ in range(5):
        assert await _sync(cache, context, "target-a", page_a) is page_a
    assert len(context.cdp_calls) == first_lookups
    assert page_a.front_calls == 1

    assert await _sync(cache, context, "target-b", page_a) is page_b
    assert page_b.front_calls == 1
    assert len(context.cdp_calls) == 2

    page_c = _FakePage("target-c")
    context.pages.append(page_c)
    assert await _sync(cache, context, "target-b", page_b) is page_b
    assert page_b.front_calls == 2, "a new tab may have stolen the foreground"

    cache.foreground = None
    assert await _sync(cache, context, "target-b", page_b) is page_b
    assert page_b.front_calls == 3, "user handoff resets the remembered foreground"


async def test_tab_focus_without_cache_always_resolves_and_foregrounds():
    page_a = _FakePage("target-a")
    context = _FakeContext([page_a])
    for _ in range(3):
        assert await _sync(None, context, "target-a", page_a) is page_a
    assert len(context.cdp_calls) == 3
    assert page_a.front_calls == 3


async def test_otp_poll_harvest_never_waits_or_fails_step():
    from domains.spawn_browser_agent_v3.handler import _harvest_otp_poll

    async def ok():
        return 2

    async def boom():
        raise RuntimeError("backend 502")

    release = asyncio.Event()

    async def slow():
        await release.wait()
        return 0

    assert _harvest_otp_poll(None) is None
    pending = asyncio.create_task(slow())
    assert _harvest_otp_poll(pending) is pending
    release.set()
    await pending
    assert _harvest_otp_poll(pending) is None
    for coro in (ok(), boom()):
        task = asyncio.create_task(coro)
        await asyncio.wait([task])
        assert _harvest_otp_poll(task) is None
    cancelled = asyncio.create_task(slow())
    cancelled.cancel()
    await asyncio.wait([cancelled])
    assert _harvest_otp_poll(cancelled) is None


async def test_slow_otp_poll_does_not_block_steps_and_codes_land_later():
    """Mirrors the loop's per-step OTP block: a backend poll slower than a step
    never delays the step, and its codes join the transcript on a later step."""
    from domains.spawn_browser_agent_v3.handler import _harvest_otp_poll

    release = asyncio.Event()
    otp_user_messages: list = []
    polls_started = 0

    async def slow_fetch():
        nonlocal polls_started
        polls_started += 1
        await release.wait()
        otp_user_messages.append({"role": "user", "content": "Code 481516 arrived"})
        return 1

    transcript: list = []
    otp_history_count = 0
    otp_poll_task = None

    async def step():
        nonlocal otp_poll_task, otp_history_count
        otp_poll_task = _harvest_otp_poll(otp_poll_task)
        if len(otp_user_messages) > otp_history_count:
            transcript.extend(otp_user_messages[otp_history_count:])
            otp_history_count = len(otp_user_messages)
        if otp_poll_task is None:
            otp_poll_task = asyncio.create_task(slow_fetch())

    for _ in range(3):
        await asyncio.wait_for(step(), timeout=0.05)
    assert polls_started == 1, "an in-flight poll is never duplicated"
    assert transcript == []

    release.set()
    await asyncio.sleep(0)
    await asyncio.wait_for(step(), timeout=0.05)
    assert transcript == [{"role": "user", "content": "Code 481516 arrived"}]
    assert polls_started == 2
    otp_poll_task.cancel()


def test_browser_loop_never_awaits_otp_poll():
    import ast
    import inspect

    from domains.spawn_browser_agent_v3.handler import _spawn_browser_agent_activity_v3_real

    source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    assert "await otp_poll_task" not in source
    assert "_fetch_and_append_recent_otp_user_messages(" in source
    loop = source[source.index("while iteration < MAX_ITERATIONS:") :]
    harvest = loop.index("otp_poll_task = _harvest_otp_poll(otp_poll_task)")
    assert harvest < loop.index("browser_turn_messages.extend(otp_user_messages[otp_history_count:])")
    assert harvest < loop.index('step_timer.mark("llm_decision")')
    activity = ast.parse(source).body[0]
    cleanup = next(node.finalbody for node in reversed(activity.body) if isinstance(node, ast.Try) and node.finalbody)
    teardown = ast.unparse(ast.Module(body=cleanup, type_ignores=[]))
    assert "await _drain_otp_poll(otp_poll_task)" in teardown


async def test_otp_poll_teardown_lets_inflight_writes_finish_then_cancels():
    from domains.spawn_browser_agent_v3.handler import _drain_otp_poll

    unretrieved = []
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: unretrieved.append(context))
    try:
        saved = []

        async def finishing_save():
            await asyncio.sleep(0.02)
            saved.append("credential-ref")
            return 1

        finishing = asyncio.create_task(finishing_save())
        await _drain_otp_poll(finishing, grace_s=1.0)
        assert saved == ["credential-ref"] and not finishing.cancelled()

        async def hung():
            await asyncio.Event().wait()

        stuck = asyncio.create_task(hung())
        started = time.monotonic()
        await _drain_otp_poll(stuck, grace_s=0.05)
        await asyncio.sleep(0)
        assert stuck.cancelled() and time.monotonic() - started < 0.5

        async def failing():
            raise RuntimeError("backend 502")

        failed = asyncio.create_task(failing())
        await asyncio.sleep(0)
        await _drain_otp_poll(failed)
        await _drain_otp_poll(None)
        del failed
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(previous_handler)
    assert not unretrieved, unretrieved


async def test_otp_credential_refs_survive_realm_rebind_mid_poll():
    """A realm transition rebinds credential_refs_by_secret_ref while a poll is in
    flight; refs the poll finds must still reach the dict execute_action reads."""
    import inspect

    from domains.spawn_browser_agent_v3.handler import (
        _append_new_otp_user_messages,
        _spawn_browser_agent_activity_v3_real,
    )
    from domains.spawn_browser_agent_v3.service_crypto import ExtractedOTP

    otp_credential_refs: dict = {}
    credential_refs_by_secret_ref = {"pw-ref": {"kind": "password", "id": "p1"}}
    release = asyncio.Event()

    async def poll():
        await release.wait()
        return await _append_new_otp_user_messages(
            otps=[ExtractedOTP("481516", "Shop", "now", 5, 600, credential_id="c-9")],
            seen_otp_codes=set(),
            otp_user_messages=[],
            credential_refs_by_secret_ref=otp_credential_refs,
            agent_id="a1",
            task_id=None,
        )

    task = asyncio.create_task(poll())
    await asyncio.sleep(0)
    credential_refs_by_secret_ref = {"pw-ref-2": {"kind": "password", "id": "p2"}}
    release.set()
    await task
    credential_refs_by_secret_ref.update(otp_credential_refs)
    assert credential_refs_by_secret_ref["481516"] == {"kind": "email_otp", "id": "c-9"}

    source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    loop = source[source.index("while iteration < MAX_ITERATIONS:") :]
    assert "credential_refs_by_secret_ref=otp_credential_refs" in loop
    merge = loop.index("credential_refs_by_secret_ref.update(otp_credential_refs)")
    assert loop.index("otp_poll_task = _harvest_otp_poll(otp_poll_task)") < merge
    assert merge < loop.index('step_timer.mark("execute_action")')


async def test_otp_source_failure_keeps_other_sources_codes():
    from datetime import datetime, timezone
    from unittest.mock import patch

    from domains.spawn_browser_agent_v3 import service_crypto

    async def email_down(*_args, **_kwargs):
        raise RuntimeError("gmail 502")

    async def sms(*_args, **_kwargs):
        now = datetime.now(timezone.utc).isoformat()
        return [{"id": "s1", "from": "+18885551234", "to": "me", "body": "Your code is 246810", "date": now}]

    async def no_imessages(*_args, **_kwargs):
        return []

    with (
        patch.object(service_crypto, "fetch_recent_emails", new=email_down),
        patch.object(service_crypto, "fetch_recent_sms_messages", new=sms),
        patch.object(service_crypto, "fetch_recent_imessages", new=no_imessages),
    ):
        otps = await service_crypto.fetch_recent_otps("user-1", "http://backend", "key")
    assert [otp.code for otp in otps] == ["246810"]


async def test_otp_sources_fetched_concurrently():
    from unittest.mock import patch

    from domains.spawn_browser_agent_v3 import service_crypto

    in_flight = 0
    peak = 0

    async def fetch(*_args, **_kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        return []

    with (
        patch.object(service_crypto, "fetch_recent_emails", new=fetch),
        patch.object(service_crypto, "fetch_recent_sms_messages", new=fetch),
        patch.object(service_crypto, "fetch_recent_imessages", new=fetch),
    ):
        await service_crypto.fetch_recent_otps("user-1", "http://backend", "key")
    assert peak == 3


def test_step_observe_builds_dom_only_for_dom_consumers():
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3.handler import _step_observe_needs_dom

    kernel = SimpleNamespace(uses_kernel_replay=True)
    file_recorder = SimpleNamespace(uses_kernel_replay=False)
    assert _step_observe_needs_dom(fast_mode_replay=False, browser_recorder=None) is False
    assert _step_observe_needs_dom(fast_mode_replay=False, browser_recorder=kernel) is False
    assert _step_observe_needs_dom(fast_mode_replay=False, browser_recorder=file_recorder) is True
    assert _step_observe_needs_dom(fast_mode_replay=True, browser_recorder=kernel) is True


class _ResumedActivityDom:
    """A DOMService as a resumed activity gets it: connected, no selector map yet."""

    def __init__(self):
        from unittest.mock import AsyncMock, MagicMock

        self.session = MagicMock()
        self.selector_map = {}
        self.full_builds = 0
        self.ensure_browser_overlays_suppressed = AsyncMock()

    async def get_browser_state(self, include_screenshot=False):
        self.full_builds += 1
        self.selector_map = {6: object()}
        return {
            "url": "https://shop.example/checkout",
            "title": "Checkout",
            "dom_tree": "[6]<input id=card-number />",
        }

    async def get_page_identity(self):
        return {"url": "https://shop.example/checkout", "title": "Checkout"}

    async def get_element_coordinates(self, index):
        return (10, 20) if index in self.selector_map else None


async def _observe_then_act_on_index(dom, *, transcript_restored):
    """The loop's step observe followed by an indexed action, as one step runs them."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    from domains.spawn_browser_agent_v3.handler import (
        _observe_step_page,
        _restored_indexes_unresolved,
        _step_observe_needs_dom,
    )
    from domains.spawn_browser_agent_v3.service_actions import execute_action

    needs_dom = _step_observe_needs_dom(
        fast_mode_replay=False,
        browser_recorder=SimpleNamespace(uses_kernel_replay=True),
        restored_indexes_unresolved=_restored_indexes_unresolved(dom, transcript_restored=transcript_restored),
    )
    await _observe_step_page(dom, needs_dom=needs_dom)
    action_history = MagicMock()
    action_history.record_action = AsyncMock()
    humanizer = MagicMock()
    humanizer.scroll = AsyncMock()
    result = await execute_action(
        dom,
        action_history,
        {"action": "scroll", "index": 6, "params": {"direction": "down", "amount": 100}},
        humanizer=humanizer,
    )
    return needs_dom, result


async def test_resumed_transcript_indexes_resolve_on_first_step():
    """agent-payment-setup-resume (agent c3cd93fd): the browser task paused for
    payment approval after read_browser_state showed [6]<input id=card-number>,
    resumed in a new activity, and its first action (input_text index 6) failed
    "Element with index 6 not found" because the URL/title-only step observe
    left the new connection's selector map empty.
    """
    dom = _ResumedActivityDom()
    needs_dom, result = await _observe_then_act_on_index(dom, transcript_restored=True)
    assert needs_dom is True
    assert dom.full_builds == 1
    assert result == {
        "success": True,
        "message": "",
        "document_scroll": {"scope": "document", "status": "unknown", "before": None, "after": None},
    }, result

    # The map is warm now (also true after an approved write-lock action was
    # replayed): later steps go back to the URL/title-only observe.
    needs_dom, result = await _observe_then_act_on_index(dom, transcript_restored=True)
    assert needs_dom is False
    assert dom.full_builds == 1
    assert result["success"] is True

    # A fresh task has cited no indexes, so its first observe stays light.
    fresh = _ResumedActivityDom()
    needs_dom, result = await _observe_then_act_on_index(fresh, transcript_restored=False)
    assert needs_dom is False
    assert fresh.full_builds == 0
    assert result == {"success": False, "error": "Element with index 6 not found"}


def test_resumed_transcript_observe_wired_once_per_activity():
    import inspect

    from domains.spawn_browser_agent_v3.handler import _spawn_browser_agent_activity_v3_real

    source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    setup, loop = source.split("while iteration < MAX_ITERATIONS:", 1)
    assert "restored_transcript_unobserved = bool(browser_turn_messages)" in setup
    assert setup.index("user_instruction_messages = _append_browser_user_instructions(") < setup.index(
        "restored_transcript_unobserved = bool(browser_turn_messages)"
    )
    observe = loop[loop.index("observe_needs_dom = _step_observe_needs_dom(") :]
    observe = observe[: observe.index('step_timer.mark("observe_state")')]
    assert "transcript_restored=restored_transcript_unobserved" in observe
    # Cleared only after the observe returned, so a timed-out observe retries it.
    assert observe.index("_observe_step_page(dom_service, needs_dom=observe_needs_dom)") < observe.index(
        "restored_transcript_unobserved = False"
    )
    assert loop.count("restored_transcript_unobserved = False") == 1


class _CountingDom:
    def __init__(self):
        self.full_builds = 0
        self.identity_reads = 0

    async def get_browser_state(self, include_screenshot=False):
        self.full_builds += 1
        return {"url": "https://shop.example/", "title": "Shop", "dom_tree": "[7]<a>Deals</a>"}

    async def get_page_identity(self):
        self.identity_reads += 1
        return {"url": "https://shop.example/", "title": "Shop"}


async def test_light_step_observe_skips_dom_and_read_browser_state_builds_it():
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3.handler import _observe_step_page
    from domains.spawn_browser_agent_v3.service_actions import _execute_read_browser_state

    dom = _CountingDom()
    light = await _observe_step_page(dom, needs_dom=False)
    assert light == {"url": "https://shop.example/", "title": "Shop"}
    assert (dom.full_builds, dom.identity_reads) == (0, 1)

    recorded = []

    async def record_action(**kwargs):
        recorded.append(kwargs["action"])

    context = SimpleNamespace(
        dom_service=dom,
        action_history=SimpleNamespace(record_action=record_action),
        thinking="",
        prefetched_browser_state=light,
    )
    result = await _execute_read_browser_state(context)
    assert dom.full_builds == 1, "a URL/title-only observe must not be served as the page state"
    assert "Deals" in result["formatted_state"]

    full = await _observe_step_page(dom, needs_dom=True)
    context.prefetched_browser_state = full
    await _execute_read_browser_state(context)
    assert dom.full_builds == 2, "a full observe is reused without a second DOM walk"
    assert recorded == ["read_browser_state", "read_browser_state"]


async def test_page_identity_reads_cached_target_info():
    from types import SimpleNamespace

    from browser_tools.dom_service import DOMService

    async def renderer_round_trip():
        raise AssertionError("step observe must not wait on the page's main thread")

    async def url():
        return "https://shop.example/cart"

    async def title():
        return "Cart"

    service = DOMService.__new__(DOMService)
    service._session = SimpleNamespace(
        agent_focus_target_id="target-1",
        get_current_page=renderer_round_trip,
        get_current_page_url=url,
        get_current_page_title=title,
    )
    assert await service.get_page_identity() == {"url": "https://shop.example/cart", "title": "Cart"}

    service._session.agent_focus_target_id = None
    try:
        await service.get_page_identity()
    except RuntimeError:
        pass
    else:
        raise AssertionError("a session with no focused tab must surface as an observe error")


async def test_browser_use_pending_request_probe_disabled():
    from browser_use.browser.watchdogs.dom_watchdog import DOMWatchdog

    from browser_tools.dom_service import disable_browser_use_pending_request_probe

    original = DOMWatchdog._get_pending_network_requests
    try:
        disable_browser_use_pending_request_probe()
        assert await DOMWatchdog._get_pending_network_requests(object()) == []
    finally:
        DOMWatchdog._get_pending_network_requests = original


async def _build_dom_trees(sent, *, delays=None):
    from types import SimpleNamespace

    from browser_use.dom.service import DomService

    from browser_tools.dom_service import drop_browser_use_serial_dom_probes

    class _Domain:
        def __init__(self, name):
            self.name = name

        def __getattr__(self, method):
            async def call(params=None, session_id=None):
                sent.append(f"{self.name}.{method}")
                await asyncio.sleep((delays or {}).get(method, 0))
                if method == "captureSnapshot":
                    return {"documents": [{"nodes": []}] * 3, "strings": []}
                return {"root": {"nodeId": 1}}

            return call

    cdp_session = SimpleNamespace(
        session_id="s-1",
        cdp_client=SimpleNamespace(
            send=SimpleNamespace(
                Runtime=_Domain("Runtime"), DOMSnapshot=_Domain("DOMSnapshot"), DOM=_Domain("DOM")
            )
        ),
    )

    async def get_or_create_cdp_session(target_id, focus):
        return cdp_session

    async def ax_tree(target_id):
        raise RuntimeError("AX stalled")

    async def viewport_ratio(target_id):
        return 2.0

    service = SimpleNamespace(
        browser_session=SimpleNamespace(get_or_create_cdp_session=get_or_create_cdp_session),
        _get_ax_tree_for_all_frames=ax_tree,
        _get_viewport_ratio=viewport_ratio,
        max_iframes=2,
    )
    original = DomService._get_all_trees
    try:
        drop_browser_use_serial_dom_probes()
        return await DomService._get_all_trees(service, "target-1")
    finally:
        DomService._get_all_trees = original


async def test_dom_build_skips_serial_page_evaluates():
    sent = []
    trees = await _build_dom_trees(sent)
    assert not [call for call in sent if call.startswith("Runtime.")], sent
    assert sorted(sent) == ["DOM.getDocument", "DOMSnapshot.captureSnapshot"]
    assert trees.ax_tree == {"nodes": []}, "a failed AX tree must not fail the DOM build"
    assert trees.device_pixel_ratio == 2.0
    assert len(trees.snapshot["documents"]) == 2
    assert trees.js_click_listener_backend_ids is None


async def test_slow_dom_tree_request_is_waited_on_not_resent():
    """A cancelled CDP request keeps running in the renderer; re-sending it after
    the first budget doubles the work on an already-stalled main thread."""
    from unittest.mock import patch

    from browser_tools import dom_service

    sent = []
    with (
        patch.object(dom_service, "DOM_TREES_TIMEOUT_SECONDS", 0.05),
        patch.object(dom_service, "DOM_TREES_GRACE_SECONDS", 0.5),
    ):
        trees = await _build_dom_trees(sent, delays={"captureSnapshot": 0.15})
    assert sent.count("DOMSnapshot.captureSnapshot") == 1, sent
    assert sent.count("DOM.getDocument") == 1, sent
    assert len(trees.snapshot["documents"]) == 2


class _PrefetchDom:
    def __init__(self, url="https://shop.example/s?k=tv", error=None, delay=0.0):
        self.url = url
        self.error = error
        self.delay = delay
        self.builds = 0

    async def get_browser_state(self, include_screenshot=False):
        self.builds += 1
        await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return {"url": self.url, "title": "Shop", "dom_tree": "[5]<button>Add</button>"}

    async def get_page_identity(self):
        return {"url": self.url, "title": "Shop"}


async def test_stalled_speculative_state_gives_up_at_soft_budget():
    """A stalled speculative build must not eat the step budget before the
    fresh read_browser_state build that replaces it."""
    from unittest.mock import patch

    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.state_prefetch import BrowserStatePrefetch

    stalled = _PrefetchDom(delay=30)
    prefetch = BrowserStatePrefetch(settle_s=0)
    prefetch.arm("click", success=True)
    prefetch.start(stalled)
    build = prefetch._task
    started = time.monotonic()
    with patch.object(handler, "BROWSER_STATE_SOFT_TIMEOUT_SECONDS", 0.05):
        assert await handler._take_speculative_browser_state(prefetch, stalled) is None
    assert time.monotonic() - started < 1.0
    await asyncio.sleep(0)
    assert build.cancelled() and not prefetch.in_flight

    ready = _PrefetchDom()
    prefetch.arm("click", success=True)
    prefetch.start(ready)
    with patch.object(handler, "BROWSER_STATE_SOFT_TIMEOUT_SECONDS", 0.05):
        state = await handler._take_speculative_browser_state(prefetch, ready)
    assert state["dom_tree"] == "[5]<button>Add</button>"


async def test_speculative_state_only_after_page_changing_actions():
    from domains.spawn_browser_agent_v3.state_prefetch import BrowserStatePrefetch

    dom = _PrefetchDom()
    prefetch = BrowserStatePrefetch(settle_s=0)
    for action, success in (("evaluate", True), ("read_browser_state", True), ("click", False), (None, True)):
        prefetch.arm(action, success=success)
        prefetch.start(dom)
        assert not prefetch.in_flight, action
    prefetch.start(dom)
    assert not prefetch.in_flight, "start without a preceding page-changing action must not build"
    await asyncio.sleep(0)
    assert dom.builds == 0

    prefetch.arm("click", success=True)
    prefetch.start(dom)
    assert prefetch.in_flight
    state = await prefetch.take(dom, "https://shop.example/s?k=tv")
    assert state["dom_tree"] == "[5]<button>Add</button>"
    assert dom.builds == 1
    assert await prefetch.take(dom, "https://shop.example/s?k=tv") is None, "a build is used at most once"


async def test_speculative_state_rejected_when_page_or_session_changed():
    from domains.spawn_browser_agent_v3.state_prefetch import BrowserStatePrefetch

    async def built(dom, live_url, *, take_dom=None):
        prefetch = BrowserStatePrefetch(settle_s=0)
        prefetch.arm("goto", success=True)
        prefetch.start(dom)
        return await prefetch.take(take_dom or dom, live_url)

    dom = _PrefetchDom()
    assert await built(dom, "https://shop.example/cart") is None
    assert await built(dom, None) is None
    assert await built(dom, "https://shop.example/s?k=tv", take_dom=_PrefetchDom()) is None
    assert await built(_PrefetchDom(error=RuntimeError("renderer frozen")), "https://shop.example/s?k=tv") is None

    slow = _PrefetchDom(delay=10)
    prefetch = BrowserStatePrefetch(settle_s=0)
    prefetch.arm("click", success=True)
    prefetch.start(slow)
    await asyncio.sleep(0)
    task = prefetch._task
    prefetch.discard()
    await asyncio.sleep(0)
    assert task.cancelled() and not prefetch.in_flight


def test_speculative_state_wired_after_step_start_mutations():
    import ast
    import inspect

    from domains.spawn_browser_agent_v3.handler import _spawn_browser_agent_activity_v3_real

    source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    loop = source[source.index("while iteration < MAX_ITERATIONS:") :]
    started = loop.index("state_prefetch.start(dom_service)")
    for step_start_mutation in (
        'step_timer.mark("realm_and_payment_prep")',
        'step_timer.mark("observe_state")',
        'step_timer.mark("passkey_usage")',
    ):
        assert loop.index(step_start_mutation) < started, step_start_mutation
    assert started < loop.index('step_timer.mark("thinking_stream_start")')
    pre_action = loop[loop.index("prefetched_browser_state = observe_page_state") :]
    pre_action = pre_action[: pre_action.index('step_timer.mark("pre_action_bookkeeping")')]
    assert 'action_name == "read_browser_state"' in pre_action
    assert "state_prefetch.discard()" in pre_action
    assert loop.index('step_timer.mark("execute_action")') < loop.index("state_prefetch.arm(")
    activity = ast.parse(source).body[0]
    cleanup = next(node.finalbody for node in reversed(activity.body) if isinstance(node, ast.Try) and node.finalbody)
    teardown = ast.unparse(ast.Module(body=cleanup, type_ignores=[]))
    assert "state_prefetch.discard()" in teardown


async def test_pooled_http_client_reused_per_loop():
    import httpx

    from helpers import http_client

    http_client._clients.clear()

    async def grab():
        return http_client.get_http_client(), http_client.get_http_client(), http_client.get_streaming_http_client()

    first, again, streaming = await grab()
    assert first is again
    assert streaming is not first
    await first.aclose()
    reopened = http_client.get_http_client()
    assert reopened is not first and not reopened.is_closed

    def other_loop():
        return asyncio.run(grab())[0]

    other = await asyncio.to_thread(other_loop)
    assert other is not reopened
    assert isinstance(other, httpx.AsyncClient)
    http_client._clients.clear()


async def test_pooled_http_clients_never_carry_cookies_between_accounts():
    """One pooled client serves every user's provider tokens; a Set-Cookie from
    account A's response must not ride on account B's next request."""
    import httpx

    from helpers import http_client

    def account_a_response():
        request = httpx.Request("GET", "https://chatgpt.com/backend-api/codex")
        return httpx.Response(200, headers={"set-cookie": "__cf_bm=account-a; Path=/"}, request=request)

    http_client._clients.clear()
    try:
        for client in (http_client.get_http_client(), http_client.get_streaming_http_client()):
            client.cookies.extract_cookies(account_a_response())
            next_request = client.build_request("GET", "https://chatgpt.com/backend-api/codex")
            assert "cookie" not in next_request.headers
            assert len(client.cookies.jar) == 0

        default_jar = httpx.AsyncClient()
        default_jar.cookies.extract_cookies(account_a_response())
        assert "cookie" in default_jar.build_request("GET", "https://chatgpt.com/backend-api/codex").headers, (
            "control: httpx replays stored cookies by default"
        )
        await default_jar.aclose()
    finally:
        for client, _ in list(http_client._clients.values()):
            await client.aclose()
        http_client._clients.clear()


async def test_recorder_transition_captures_queued_marks_on_outgoing_page():
    import os
    import tempfile

    from domains.spawn_browser_agent_v3.recording import BrowserAgentRecorder

    class _Context:
        pages: list = []

    class _Page:
        def __init__(self, name):
            self.url = f"https://{name}.example/"
            self.context = _Context()
            self.context.pages = [self]

        async def screenshot(self, **_kwargs):
            return b"frame"

    previous = {key: os.environ.get(key) for key in ("BROWSER_AGENT_RECORDINGS_DIR", "BROWSER_AGENT_KERNEL_REPLAY")}
    os.environ.pop("BROWSER_AGENT_KERNEL_REPLAY", None)
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["BROWSER_AGENT_RECORDINGS_DIR"] = temp_dir
            outgoing, promoted = _Page("steel-one"), _Page("steel-two")
            recorder = BrowserAgentRecorder(
                page=outgoing,
                agent_id="agent-1",
                task_id="task-1",
                session_id="steel-one",
                browser_url=outgoing.url,
                session_metadata={"provider": "steel"},
            )
            await recorder.mark("Click Place order", metadata={"step": 7})
            await recorder.transition_browser(
                page=promoted,
                session_id="steel-two",
                browser_url=promoted.url,
                session_metadata={"provider": "steel"},
            )
            marked = [frame for frame in recorder.frames if frame["label"] == "Click Place order"]
            assert [frame["tab_url"] for frame in marked] == [outgoing.url], recorder.frames
            await recorder.close(include_steel_media=False)
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


async def test_per_step_backend_and_llm_calls_never_build_a_client():
    """Each fresh httpx.AsyncClient builds an SSLContext (CA bundle parse) and a
    new TLS connection; py-spy put that at ~27% of a live browser worker's main
    thread, paid on every per-step message save, control poll, and LLM stream."""
    from types import SimpleNamespace
    from unittest.mock import patch

    import httpx

    import config as config_module
    from domains.spawn_browser_agent_v3 import repo
    from helpers import http_client, update_status
    from providers.rose import client as rose_client
    from providers.rose import transport
    from tools.base import MessageStatus

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"state": "agent"})

    loop = asyncio.get_running_loop()
    http_client._clients.clear()
    for name in ("default", "streaming"):
        http_client._clients[name] = (httpx.AsyncClient(transport=httpx.MockTransport(handler)), loop)

    def no_new_clients(*_a, **_k):
        raise AssertionError("per-call httpx.AsyncClient constructed on the browser step hot path")

    cfg = SimpleNamespace(backend=SimpleNamespace(api_url="http://backend", api_key="k"))
    setup_mock_fn(handler)
    try:
        with (
            patch.object(httpx, "AsyncClient", side_effect=no_new_clients),
            patch.object(config_module, "load_config", return_value=cfg),
            patch.object(update_status, "load_config", return_value=cfg),
            patch.object(rose_client, "load_config", return_value=cfg),
        ):
            rose_client._reset_gpt_api_key_cooldown_cache()
            assert await rose_client._gpt_api_key_on_cooldown() is False
            assert await repo.fetch_browser_control_state(cfg, "t1") == "agent"
            await repo.fetch_browser_captcha_telemetry(cfg, "t1")
            assert await repo.save_browser_action_message("a1", "Click", "msg", MessageStatus.IN_PROGRESS, "t1")
            await repo.save_browser_assistant_message("a1", "thinking", "t1")
            await update_status._update_agent_status_impl("a1", "ACTIVE", 0.5, "", 0, 0, 0)
            async with transport.post_cerebras_stream(body={"model": "m"}, cerebras_key="k", request_id="r") as resp:
                assert resp.status_code == 200
    finally:
        for client, _ in list(http_client._clients.values()):
            await client.aclose()
        http_client._clients.clear()
        teardown_mock()
    assert "/api/browser-session/task/t1/control" in seen
    assert "/api/agents/a1/messages" in seen
    assert "/api/agents/a1/status" in seen
    assert "/v1/chat/completions" in seen
    assert "/api/integrations/compute-code/gpt-key/cooldown" in seen


async def run_all_tests():
    print("browser-step-timing blackbox tests:")
    r = BlackboxResult()
    r.record("phases_partition_step_wall_clock", test_phases_partition_step_wall_clock)
    r.record("repeated_phase_accumulates", test_repeated_phase_accumulates_and_annotations_attach)
    r.record("start_step_emits_previous_step", test_start_step_emits_previous_step_even_on_continue_paths)
    r.record("mark_before_start_is_noop", test_mark_before_start_is_noop)
    r.record("browser_loop_marks_every_core_phase", test_browser_loop_marks_every_core_phase)
    r.record("no_fixed_inter_step_sleep", test_browser_loop_has_no_fixed_inter_step_sleep)
    await r.record_async(
        "tab_focus_cache_skips_repeat_calls", test_tab_focus_cache_skips_repeat_cdp_and_foreground_calls
    )
    await r.record_async("tab_focus_without_cache", test_tab_focus_without_cache_always_resolves_and_foregrounds)
    await r.record_async("otp_poll_harvest_never_waits", test_otp_poll_harvest_never_waits_or_fails_step)
    await r.record_async(
        "slow_otp_poll_does_not_block_steps", test_slow_otp_poll_does_not_block_steps_and_codes_land_later
    )
    r.record("browser_loop_never_awaits_otp_poll", test_browser_loop_never_awaits_otp_poll)
    await r.record_async(
        "otp_poll_teardown_drains_then_cancels", test_otp_poll_teardown_lets_inflight_writes_finish_then_cancels
    )
    await r.record_async("otp_refs_survive_realm_rebind", test_otp_credential_refs_survive_realm_rebind_mid_poll)
    await r.record_async("otp_source_failure_keeps_others", test_otp_source_failure_keeps_other_sources_codes)
    await r.record_async("otp_sources_fetched_concurrently", test_otp_sources_fetched_concurrently)
    await r.record_async("pending_request_probe_disabled", test_browser_use_pending_request_probe_disabled)
    await r.record_async("dom_build_skips_serial_evaluates", test_dom_build_skips_serial_page_evaluates)
    await r.record_async("slow_dom_tree_request_not_resent", test_slow_dom_tree_request_is_waited_on_not_resent)
    await r.record_async(
        "stalled_speculative_state_soft_budget", test_stalled_speculative_state_gives_up_at_soft_budget
    )
    await r.record_async(
        "speculative_state_after_page_changes", test_speculative_state_only_after_page_changing_actions
    )
    await r.record_async(
        "speculative_state_rejected_on_change", test_speculative_state_rejected_when_page_or_session_changed
    )
    r.record("speculative_state_wiring", test_speculative_state_wired_after_step_start_mutations)
    r.record("step_observe_dom_only_for_consumers", test_step_observe_builds_dom_only_for_dom_consumers)
    await r.record_async("resumed_transcript_indexes_resolve", test_resumed_transcript_indexes_resolve_on_first_step)
    r.record("resumed_transcript_observe_wiring", test_resumed_transcript_observe_wired_once_per_activity)
    await r.record_async(
        "light_observe_read_browser_state_builds_dom",
        test_light_step_observe_skips_dom_and_read_browser_state_builds_it,
    )
    await r.record_async("page_identity_cached_target_info", test_page_identity_reads_cached_target_info)
    await r.record_async("pooled_http_client_reused_per_loop", test_pooled_http_client_reused_per_loop)
    await r.record_async(
        "pooled_http_clients_reject_cookies", test_pooled_http_clients_never_carry_cookies_between_accounts
    )
    await r.record_async(
        "recorder_transition_flushes_marks", test_recorder_transition_captures_queued_marks_on_outgoing_page
    )
    await r.record_async("step_calls_never_build_http_client", test_per_step_backend_and_llm_calls_never_build_a_client)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
