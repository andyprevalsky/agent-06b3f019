"""Blackbox tests for browser step phase timing (browser.step.phases)."""

import asyncio
import re
from pathlib import Path

from structlog.testing import capture_logs

from _test_utils import BlackboxResult, teardown_mock

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
    import inspect

    from domains.spawn_browser_agent_v3.handler import _spawn_browser_agent_activity_v3_real

    source = inspect.getsource(_spawn_browser_agent_activity_v3_real)
    assert "await otp_poll_task" not in source
    assert "_fetch_and_append_recent_otp_user_messages(" in source
    loop = source[source.index("while iteration < MAX_ITERATIONS:") :]
    harvest = loop.index("otp_poll_task = _harvest_otp_poll(otp_poll_task)")
    assert harvest < loop.index("browser_turn_messages.extend(otp_user_messages[otp_history_count:])")
    assert harvest < loop.index('step_timer.mark("llm_decision")')
    teardown = source[source.rindex("finally:") :]
    assert "otp_poll_task.cancel()" in teardown


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


async def test_dom_build_skips_serial_page_evaluates():
    from types import SimpleNamespace

    from browser_use.dom.service import DomService

    from browser_tools.dom_service import drop_browser_use_serial_dom_probes

    sent = []

    class _Domain:
        def __init__(self, name):
            self.name = name

        def __getattr__(self, method):
            async def call(params=None, session_id=None):
                sent.append(f"{self.name}.{method}")
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
        trees = await DomService._get_all_trees(service, "target-1")
    finally:
        DomService._get_all_trees = original
    assert not [call for call in sent if call.startswith("Runtime.")], sent
    assert sorted(sent) == ["DOM.getDocument", "DOMSnapshot.captureSnapshot"]
    assert trees.ax_tree == {"nodes": []}, "a failed AX tree must not fail the DOM build"
    assert trees.device_pixel_ratio == 2.0
    assert len(trees.snapshot["documents"]) == 2
    assert trees.js_click_listener_backend_ids is None


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
    teardown = source[source.rindex("finally:") :]
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
    try:
        with (
            patch.object(httpx, "AsyncClient", side_effect=no_new_clients),
            patch.object(config_module, "load_config", return_value=cfg),
            patch.object(update_status, "load_config", return_value=cfg),
        ):
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
    assert "/api/browser-session/task/t1/control" in seen
    assert "/api/agents/a1/messages" in seen
    assert "/api/agents/a1/status" in seen
    assert "/v1/chat/completions" in seen


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
    await r.record_async("otp_sources_fetched_concurrently", test_otp_sources_fetched_concurrently)
    await r.record_async("pending_request_probe_disabled", test_browser_use_pending_request_probe_disabled)
    await r.record_async("dom_build_skips_serial_evaluates", test_dom_build_skips_serial_page_evaluates)
    await r.record_async(
        "speculative_state_after_page_changes", test_speculative_state_only_after_page_changing_actions
    )
    await r.record_async(
        "speculative_state_rejected_on_change", test_speculative_state_rejected_when_page_or_session_changed
    )
    r.record("speculative_state_wiring", test_speculative_state_wired_after_step_start_mutations)
    r.record("step_observe_dom_only_for_consumers", test_step_observe_builds_dom_only_for_dom_consumers)
    await r.record_async(
        "light_observe_read_browser_state_builds_dom",
        test_light_step_observe_skips_dom_and_read_browser_state_builds_it,
    )
    await r.record_async("page_identity_cached_target_info", test_page_identity_reads_cached_target_info)
    await r.record_async("pooled_http_client_reused_per_loop", test_pooled_http_client_reused_per_loop)
    await r.record_async("step_calls_never_build_http_client", test_per_step_backend_and_llm_calls_never_build_a_client)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
