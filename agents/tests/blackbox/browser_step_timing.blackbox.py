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
        "observe_state",
        "otp_wait",
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


async def test_prefetched_observe_state_only_reused_on_same_url():
    from types import SimpleNamespace

    from domains.spawn_browser_agent_v3.handler import _take_prefetched_observe_state

    def dom(url=None, error=None):
        async def get_current_page_url():
            if error:
                raise error
            return url

        return SimpleNamespace(session=SimpleNamespace(get_current_page_url=get_current_page_url))

    state = {"url": "https://shop.example/s?k=tv", "dom_text": "[1]<button>"}
    assert await _take_prefetched_observe_state(dom("https://shop.example/s?k=tv"), state) is state
    assert await _take_prefetched_observe_state(dom("https://shop.example/cart"), state) is None
    assert await _take_prefetched_observe_state(dom(error=RuntimeError("cdp gone")), state) is None
    assert await _take_prefetched_observe_state(dom("https://shop.example/s?k=tv"), None) is None
    assert await _take_prefetched_observe_state(None, state) is None


async def test_otp_fetch_failure_never_fails_step():
    from domains.spawn_browser_agent_v3.handler import _settle_otp_fetch

    async def ok():
        return 2

    async def boom():
        raise RuntimeError("backend 502")

    assert await _settle_otp_fetch(asyncio.create_task(ok())) == 2
    assert await _settle_otp_fetch(asyncio.create_task(boom())) == 0


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


async def test_browser_use_pending_request_probe_disabled():
    from browser_use.browser.watchdogs.dom_watchdog import DOMWatchdog

    from browser_tools.dom_service import disable_browser_use_pending_request_probe

    original = DOMWatchdog._get_pending_network_requests
    try:
        disable_browser_use_pending_request_probe()
        assert await DOMWatchdog._get_pending_network_requests(object()) == []
    finally:
        DOMWatchdog._get_pending_network_requests = original


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
    await r.record_async("prefetched_observe_same_url_only", test_prefetched_observe_state_only_reused_on_same_url)
    await r.record_async("otp_fetch_failure_never_fails_step", test_otp_fetch_failure_never_fails_step)
    await r.record_async("otp_sources_fetched_concurrently", test_otp_sources_fetched_concurrently)
    await r.record_async("pending_request_probe_disabled", test_browser_use_pending_request_probe_disabled)
    teardown_mock()
    return r.all_passed


if __name__ == "__main__":
    asyncio.run(run_all_tests())
