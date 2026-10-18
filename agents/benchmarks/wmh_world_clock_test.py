"""World clock semantics (V4, V5, V7, V8, V10, V11), run by the WMH blackbox gate."""

import asyncio
import types
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from benchmarks.wmh_world_clock import WorldClock

NOW = datetime(2026, 10, 15, tzinfo=timezone.utc)
DAY = 86_400_000


def run(coro):
    return asyncio.run(coro)


def test_a_lone_waiter_jumps_to_its_deadline_without_real_waiting():  # V4
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        result = await asyncio.wait_for(clock.wait("root", "w1", duration_ms=14 * DAY, poll_seconds=5), 1)
        assert result == {"resumed": True, "time_ms": 14 * DAY, "deadline_ms": 14 * DAY}
        # A retried wait (same invocation) does not wait again or move time.
        assert (await clock.wait("root", "w1", duration_ms=14 * DAY))["time_ms"] == 14 * DAY

    run(scenario())


def test_a_waiter_never_overtakes_a_running_agent():  # V5
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        clock.register("a", parent="root")
        clock.register("b", parent="root")
        clock.commit("b", started_ms=0, elapsed_ms=4 * DAY)
        waiting = asyncio.create_task(clock.wait("a", "w", until_ms=10 * DAY, poll_seconds=5))
        await asyncio.sleep(0.01)
        assert not waiting.done() and clock.shared_time() == 4 * DAY
        clock.commit("b", started_ms=4 * DAY, elapsed_ms=5 * DAY)  # b at day 9
        await asyncio.sleep(0.01)
        assert not waiting.done()
        clock.commit("b", started_ms=9 * DAY, elapsed_ms=2 * DAY)  # b passes day 10
        assert (await asyncio.wait_for(waiting, 1))["time_ms"] == 10 * DAY

    run(scenario())


@pytest.mark.parametrize("release", ["waits_beyond", "finishes"])
def test_a_waiter_resumes_when_the_other_agent_waits_beyond_or_finishes(release):  # V5
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        clock.register("a", parent="root")
        clock.register("b", parent="root")
        waiting = asyncio.create_task(clock.wait("a", "w", until_ms=10 * DAY, poll_seconds=5))
        await asyncio.sleep(0.01)
        assert not waiting.done()
        other = None
        if release == "waits_beyond":
            other = asyncio.create_task(clock.wait("b", "w", until_ms=12 * DAY, poll_seconds=5))
        else:
            clock.finish("b")
        assert (await asyncio.wait_for(waiting, 1))["time_ms"] == 10 * DAY
        if other is not None:
            assert not other.done()
            other.cancel()

    run(scenario())


def test_all_waiting_jumps_to_the_earliest_deadline_and_ties_wake_together():  # V7
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        for agent in ("a", "b", "c"):
            clock.register(agent, parent="root")
        a = asyncio.create_task(clock.wait("a", "w", until_ms=10 * DAY, poll_seconds=5))
        b = asyncio.create_task(clock.wait("b", "w", until_ms=6 * DAY, poll_seconds=5))
        c = asyncio.create_task(clock.wait("c", "w", until_ms=6 * DAY, poll_seconds=5))
        done, _ = await asyncio.wait({b, c}, timeout=1)
        assert done == {b, c} and not a.done()
        assert {t.result()["time_ms"] for t in done} == {6 * DAY}
        clock.finish("b")
        clock.commit("c", started_ms=6 * DAY, elapsed_ms=5 * DAY)
        assert (await asyncio.wait_for(a, 1))["time_ms"] == 10 * DAY

    run(scenario())


def test_children_start_at_the_parent_time_and_the_parent_resumes_at_the_last_finish():  # V8
    clock = WorldClock(start_ms=0)
    clock.register("root")
    clock.commit("root", started_ms=0, elapsed_ms=1 * DAY)
    clock.register("c1", parent="root")
    clock.register("c2", parent="root")
    assert clock.time_of("c1") == clock.time_of("c2") == 1 * DAY
    # A parent waiting on live children does not hold back shared time.
    clock.commit("c1", started_ms=1 * DAY, elapsed_ms=2 * DAY)
    clock.commit("c2", started_ms=1 * DAY, elapsed_ms=4 * DAY)
    assert clock.shared_time() == 3 * DAY
    clock.finish("c1")
    clock.finish("c2")
    assert clock.time_of("root") == 5 * DAY and clock.shared_time() == 5 * DAY


def test_a_parent_that_keeps_acting_beside_its_children_holds_shared_time():
    """Run 4 (2026-10-11): roots act while a spawned child runs; they must not be overtaken."""
    clock = WorldClock(start_ms=0)
    clock.register("root")
    clock.register("child", parent="root")
    clock.commit("child", started_ms=0, elapsed_ms=10 * DAY)
    # Spawned and idle: the parent waits on its child.
    assert clock.shared_time() == 10 * DAY
    started = clock.action_time("root")
    clock.commit("root", started_ms=started, elapsed_ms=1 * DAY)
    # Acting beside its child: the parent's own time holds shared time back.
    assert clock.shared_time() == 1 * DAY
    assert {a["agent_id"]: a["state"] for a in clock.snapshot()["agents"]}["root"] == "running"
    clock.register("second", parent="root")
    # Spawning again makes it idle on its children until it acts.
    assert clock.shared_time() == 1 * DAY  # "second" starts at the parent's time
    clock.commit("second", started_ms=1 * DAY, elapsed_ms=20 * DAY)
    assert clock.shared_time() == 10 * DAY


def test_parallel_actions_advance_an_agent_by_the_longest_not_the_sum():
    clock = WorldClock(start_ms=0)
    clock.register("root")
    for elapsed in (20, 30, 10):
        clock.commit("root", started_ms=0, elapsed_ms=elapsed * 60_000)
    assert clock.time_of("root") == 30 * 60_000


def test_an_unregistered_agent_starts_at_shared_time_and_snapshot_is_complete():
    clock = WorldClock(start_ms=1_000)
    clock.register("root")
    clock.commit("root", started_ms=1_000, elapsed_ms=500)
    assert clock.action_time("stray") == 1_500
    snapshot = clock.snapshot()
    assert snapshot["start_ms"] == 1_000 and snapshot["shared_time_ms"] == 1_500
    assert {agent["agent_id"] for agent in snapshot["agents"]} == {"root", "stray"}


def test_waiting_never_deadlocks_when_every_agent_waits():  # V10
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        for index in range(5):
            clock.register(f"c{index}", parent="root")
        waiters = [
            asyncio.create_task(clock.wait(f"c{index}", "w", until_ms=(index + 1) * DAY, poll_seconds=5))
            for index in range(5)
        ]
        times = []
        for task in waiters:
            result = await asyncio.wait_for(task, 1)
            times.append(result["time_ms"])
            clock.finish(f"c{len(times) - 1}")
        assert times == [day * DAY for day in range(1, 6)]

    run(scenario())


def test_a_wait_poll_returns_unresumed_instead_of_blocking_forever():
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        clock.register("a", parent="root")
        clock.register("b", parent="root")
        result = await asyncio.wait_for(clock.wait("a", "w", until_ms=DAY, poll_seconds=0.05), 1)
        assert result == {"resumed": False, "time_ms": 0, "deadline_ms": DAY}
        clock.finish("b")
        assert (await asyncio.wait_for(clock.wait("a", "w", until_ms=DAY, poll_seconds=5), 1))["resumed"]

    run(scenario())


def test_ten_thousand_agents_update_in_logarithmic_time():  # V11
    import time

    clock = WorldClock(start_ms=0)
    clock.register("root")
    for index in range(10_000):
        clock.register(f"a{index}", parent="root")
    started = time.perf_counter()
    for index in range(10_000):
        clock.commit(f"a{index}", started_ms=0, elapsed_ms=index + 1)
        clock.shared_time()
    # Ten thousand heap-backed updates stay far below a quadratic scan.
    assert time.perf_counter() - started < 2.0
    assert clock.shared_time() == 1


# Owning cross-boundary clock and activity policy regressions.

@pytest.mark.parametrize('mode',['real','simulate','shadow'])
def test_phone_actual_activity_options_preserve_real_and_wmh_policy(monkeypatch,mode):
 from domains.call_phone_number import handler as m
 from helpers.wmh_activity_policy import wmh_activity_timeout_options
 captured=[]
 async def execute(fn,**kwargs):captured.append(kwargs);return {'success':True,'duration':0,'message':'offline'}
 monkeypatch.setattr(m,'handle_tool_event',AsyncMock())
 asyncio.run(m.CallPhoneNumberManager().execute_tool(execute,{'to':'+15555550100','system_prompt':'offline'},'call','agent','user',mode))
 assert len(captured)==1;kw=captured[0];expected=wmh_activity_timeout_options(mode,timedelta(minutes=m.ACTIVITY_TIMEOUT_MINUTES))
 if mode=='real':expected['heartbeat_timeout']=timedelta(seconds=m.HEARTBEAT_TIMEOUT_SECONDS)
 assert {k:v for k,v in kw.items() if k.endswith('_timeout')}==expected
 assert kw['retry_policy'].maximum_attempts==m.MAX_RETRY_ATTEMPTS
 assert kw['retry_policy'].backoff_coefficient==m.RETRY_BACKOFF_COEFFICIENT
 assert kw['retry_policy'].initial_interval==timedelta(seconds=m.RETRY_INITIAL_INTERVAL_SECONDS)
 assert kw['retry_policy'].maximum_interval==timedelta(seconds=m.RETRY_MAX_INTERVAL_SECONDS)
 assert len(kw['args'])==(6 if mode=='real' else 7)

def test_negative_pinned_date_offset_survives_and_real_is_unchanged():
 from utils.simulated_clock import simulated_now,advance_simulated_clock,simulated_clock_offset_seconds
 wf=types.SimpleNamespace(world_model_mode='simulate',simulated_clock_offset_seconds=-86400)
 assert simulated_now(wf,NOW)==NOW-timedelta(days=1)
 assert advance_simulated_clock(wf,60)==-86340
 real=types.SimpleNamespace(world_model_mode='real',simulated_clock_offset_seconds=-86400)
 assert simulated_clock_offset_seconds(real)==0

@pytest.mark.parametrize('available',[True,False])
def test_wait_seconds_uses_actual_shared_wait_and_retains_fallback(monkeypatch,available):
 from domains.wait_seconds import handler as m
 import importlib
 shared = importlib.import_module(m._wait_on_world_clock.__module__)
 from utils.simulated_clock import simulated_clock_offset_seconds
 wf=types.SimpleNamespace(world_model_mode='simulate',agent_id='a',simulated_clock_offset_seconds=0)
 calls=[]
 async def activity(fn,**kw):calls.append(kw);return {'time_ms':int(NOW.timestamp()*1000)+300000} if available else {'skipped':'no_world_session'}
 monkeypatch.setattr(shared,'workflow',types.SimpleNamespace(execute_activity=activity,now=lambda:NOW,logger=types.SimpleNamespace(error=lambda *a:None)))
 async def run():return [e async for e in m.WaitSecondsManager().execute_tool(wf,{'seconds':300},'wait-id')]
 events=asyncio.run(run());assert len(calls)==1;assert calls[0]['args']==['wait','a',None,{'wait_id':'wait-id','duration_ms':300000}]
 assert simulated_clock_offset_seconds(wf)==300
 assert events[-1].metadata['simulatedSkipSeconds']==300

@pytest.mark.parametrize('operation',['register','finish'])
@pytest.mark.parametrize('first',['exception','skipped','malformed','success'])
def test_world_clock_ack_retry_and_concurrent_duplicates(monkeypatch,first,operation):
 import workflows.agent_workflow as m
 async def run():
  wf=types.SimpleNamespace(world_model_mode='simulate',agent_id='a',parent_agent_id=None,_world_clock_events=set(),simulated_clock_offset_seconds=0)
  calls=[];entered=asyncio.Event();release=asyncio.Event()
  async def activity(*a,**kw):
   calls.append(kw);entered.set();await release.wait()
   if len(calls)==1 and first=='exception':raise RuntimeError('offline transient')
   if len(calls)==1 and first=='skipped':return {'skipped':'no_world_session'}
   if len(calls)==1 and first=='malformed':return {'time_ms':True}
   return {'agent_id':'a','time_ms':int(NOW.timestamp()*1000)-86400000}
  monkeypatch.setattr(m,'workflow',types.SimpleNamespace(execute_activity=activity,now=lambda:NOW))
  one=asyncio.create_task(m.AgentWorkflow._world_clock_event(wf,operation));await entered.wait()
  two=asyncio.create_task(m.AgentWorkflow._world_clock_event(wf,operation));await asyncio.sleep(0)
  assert len(calls)==1 and not two.done(),'duplicate must join in-flight operation'
  release.set();await asyncio.gather(one,two)
  assert (operation in wf._world_clock_events)==(first=='success')
  await m.AgentWorkflow._world_clock_event(wf,operation)
  assert len(calls)==(1 if first=='success' else 2)
  assert wf.simulated_clock_offset_seconds==(-86400 if operation=='register' else 0)
 asyncio.run(run())
