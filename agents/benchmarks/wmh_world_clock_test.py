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


# The agent's own clock (simulated_now: what wait_for measures from and what
# simulated actions are stamped with) must read the agent's shared world time.
# World time advances only by predicted action durations, so it can fall behind
# the wall clock (Run12/Run16: 48 and 36 simulated minutes in 60 wall minutes).
# Repro of 2026-10-15-shared-world-clock-wait-and-acknowledgement-diverged.
PINNED = datetime(2026, 10, 12, 23, 0, tzinfo=timezone.utc)
MINUTE = 60_000


def _ms(value):
    return int(value.timestamp() * 1000)


def _registered_agent(monkeypatch):
    """A simulated agent registered on a world pinned before today's wall date."""
    import workflows.agent_workflow as m

    wf = types.SimpleNamespace(
        world_model_mode='simulate', agent_id='child', parent_agent_id='root',
        _world_clock_events=set(), simulated_clock_offset_seconds=0,
    )

    async def register(*_a, **_kw):
        return {'agent_id': 'child', 'time_ms': _ms(PINNED)}

    monkeypatch.setattr(m, 'workflow', types.SimpleNamespace(execute_activity=register, now=lambda: NOW))
    asyncio.run(m.AgentWorkflow._world_clock_event(wf, 'register'))
    return wf


def _shared_world(monkeypatch, module, *, wall_now, world_ms_after):
    """Patch one handler's workflow and the shared wait helper; return the wait calls."""
    import importlib

    shared = importlib.import_module(module._wait_on_world_clock.__module__)
    calls = []

    async def activity(fn, **kw):
        calls.append(kw['args'])
        wait = kw['args'][3]
        return {'resumed': True, 'time_ms': world_ms_after(wait), 'deadline_ms': world_ms_after(wait)}

    fake = types.SimpleNamespace(execute_activity=activity, now=lambda: wall_now, logger=types.SimpleNamespace(error=lambda *a: None))
    monkeypatch.setattr(shared, 'workflow', fake)
    monkeypatch.setattr(module, 'workflow', fake)
    return calls


def test_after_a_shared_wait_the_agent_clock_equals_the_acknowledged_world_time(monkeypatch):
    from domains.wait_seconds import handler as m
    from utils.simulated_clock import simulated_now

    wf = _registered_agent(monkeypatch)
    assert simulated_now(wf, NOW) == PINNED
    # One wall hour later the agent's world time is only 10 minutes past the pin.
    wall = NOW + timedelta(hours=1)
    world_before = _ms(PINNED) + 10 * MINUTE
    calls = _shared_world(monkeypatch, m, wall_now=wall, world_ms_after=lambda wait: world_before + wait['duration_ms'])

    async def wait():
        return [e async for e in m.WaitSecondsManager().execute_tool(wf, {'seconds': 300}, 'wait-1')]

    events = asyncio.run(wait())
    assert calls == [['wait', 'child', None, {'wait_id': 'wait-1', 'duration_ms': 300_000}]]
    acknowledged = datetime.fromtimestamp((world_before + 300_000) / 1000, timezone.utc)
    assert events[-1].status.name == 'FINISHED'
    assert simulated_now(wf, wall) == acknowledged, (
        f'agent clock {simulated_now(wf, wall).isoformat()} != shared world acknowledgement {acknowledged.isoformat()}'
    )


def test_wait_for_a_future_world_timestamp_waits_on_the_shared_clock(monkeypatch):
    from domains.wait_for import handler as m

    wf = _registered_agent(monkeypatch)
    wall = NOW + timedelta(hours=1)
    target = PINNED + timedelta(minutes=30)  # 20 world minutes ahead of this agent
    calls = _shared_world(monkeypatch, m, wall_now=wall, world_ms_after=lambda wait: wait['until_ms'])
    monkeypatch.setattr(m, 'skip_wait_wall_clock_for_fast_mode_replay', lambda _wf: False)

    async def wait():
        return [e async for e in m.WaitForManager().execute_tool(wf, {'until_timestamp': target.isoformat()}, 'wait-2')]

    events = asyncio.run(wait())
    assert events[-1].status.name == 'FINISHED', events[-1].message
    assert calls == [['wait', 'child', None, {'wait_id': 'child:wait-2', 'until_ms': _ms(target)}]]


def test_when_every_agent_waits_or_holds_on_children_all_jump_to_the_earliest_wait():
    """Parents blocked on their children never hold time; waiters wake in deadline order at once."""
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        clock.commit("root", started_ms=0, elapsed_ms=1 * DAY)
        clock.register("mid", parent="root")  # root now holds on its child, not a wait_for
        clock.commit("mid", started_ms=1 * DAY, elapsed_ms=1 * DAY)
        for leaf in ("x", "y"):
            clock.register(leaf, parent="mid")  # mid holds on its children too
        clock.register("z", parent="root")
        deadlines = {"x": 9 * DAY, "y": 4 * DAY, "z": 7 * DAY}
        woke = []

        async def waiter(agent):
            result = await clock.wait(agent, "w", until_ms=deadlines[agent], poll_seconds=5)
            woke.append((agent, result["time_ms"], clock.shared_time()))
            clock.finish(agent)

        loop = asyncio.get_running_loop()
        started = loop.time()
        await asyncio.wait_for(asyncio.gather(*(waiter(a) for a in deadlines)), 1)
        assert loop.time() - started < 0.5, "world jumps must not wait in real time"
        assert [(a, t) for a, t, _ in woke] == [("y", 4 * DAY), ("z", 7 * DAY), ("x", 9 * DAY)]
        assert woke[0][2] == 4 * DAY  # the jump goes to min(Ti), not past it
        clock.finish("mid")
        assert clock.time_of("mid") == 9 * DAY and clock.time_of("root") == 9 * DAY

    run(scenario())


# World-time cursor contract (approved clock fix). Fakes route the workflow's
# world_clock_activity calls straight into a real WorldClock.
def _clock_activity(clock, calls=None):
    async def execute_activity(fn, **kw):
        operation, agent_id, *rest = kw['args']
        if calls is not None:
            calls.append(operation)
        if operation == 'register':
            return {'agent_id': agent_id, 'time_ms': clock.register(agent_id, rest[0] if rest else None)}
        if operation == 'time':
            return {'agent_id': agent_id, 'time_ms': clock.time_of(agent_id)}
        if operation == 'finish':
            clock.finish(agent_id)
            return {'agent_id': agent_id, 'time_ms': clock.time_of(agent_id)}
        raise AssertionError(operation)
    return execute_activity


def _simulated_workflow(agent_id, parent=None, mode='simulate'):
    from workflows.agent_workflow import AgentWorkflow

    wf = AgentWorkflow.__new__(AgentWorkflow)  # the real methods, without a Temporal runtime
    wf.__dict__.update(
        world_model_mode=mode, agent_id=agent_id, parent_agent_id=parent,
        _world_clock_events=set(), simulated_clock_offset_seconds=0, simulated_world_time_ms=None,
        _deployment_resume=False,
    )
    return wf


def _patch_workflows(monkeypatch, activity, sleeps=None):
    import importlib

    import workflows.agent_workflow as m

    async def sleep(duration):
        if sleeps is not None:
            sleeps.append(duration)

    fake = types.SimpleNamespace(execute_activity=activity, now=lambda: NOW, sleep=sleep,
                                 logger=types.SimpleNamespace(error=lambda *a: None))
    monkeypatch.setattr(m, 'workflow', fake)
    shared = importlib.import_module(m._refresh_world_time_cursor.__module__)
    monkeypatch.setattr(shared, 'workflow', fake)
    return m


def test_a_child_starts_at_its_parents_world_time_cursor(monkeypatch):
    from utils.simulated_clock import simulated_now

    clock = WorldClock(start_ms=_ms(PINNED))
    m = _patch_workflows(monkeypatch, _clock_activity(clock))
    root, child = _simulated_workflow('root'), _simulated_workflow('child', 'root')
    asyncio.run(m.AgentWorkflow._register_on_world_clock(root))
    clock.commit('root', started_ms=clock.action_time('root'), elapsed_ms=DAY)  # one simulated day of work
    asyncio.run(m.AgentWorkflow._register_on_world_clock(child))
    assert child.simulated_world_time_ms == _ms(PINNED) + DAY == clock.time_of('root')
    assert simulated_now(child, NOW) == PINNED + timedelta(days=1)


def test_simulated_actions_and_a_child_result_move_the_parent_cursor(monkeypatch):
    from utils.simulated_clock import simulated_now, simulated_timestamp_ms

    clock = WorldClock(start_ms=_ms(PINNED))
    m = _patch_workflows(monkeypatch, _clock_activity(clock))
    root, child = _simulated_workflow('root'), _simulated_workflow('child', 'root')
    asyncio.run(m.AgentWorkflow._register_on_world_clock(root))

    async def tool(self, name, args, call_id):
        # Stand-ins for the WMH committing what this tool did on the world clock.
        if name == 'web_search':
            clock.commit('root', started_ms=clock.action_time('root'), elapsed_ms=90 * MINUTE)
        if name == 'spawn_agent':
            await m.AgentWorkflow._register_on_world_clock(child)
            clock.commit('child', started_ms=clock.action_time('child'), elapsed_ms=2 * DAY)
            await m.AgentWorkflow._world_clock_event(child, 'finish')
        return {'success': True}

    monkeypatch.setattr(m.AgentWorkflow, '_execute_tool_once', tool, raising=False)
    asyncio.run(m.AgentWorkflow._execute_tool(root, 'web_search', {}, 'c1'))
    assert root.simulated_world_time_ms == _ms(PINNED) + 90 * MINUTE  # thinking is free; the action costs 90 min
    asyncio.run(m.AgentWorkflow._execute_tool(root, 'spawn_agent', {}, 'c2'))
    finished = _ms(PINNED) + 90 * MINUTE + 2 * DAY
    assert clock.time_of('child') == finished
    assert root.simulated_world_time_ms == finished, 'the parent receives the result at the child finish'
    assert simulated_timestamp_ms(root, NOW) == finished
    assert simulated_now(root, NOW) == PINNED + timedelta(minutes=90, days=2)


def test_a_simulated_agent_without_a_world_session_fails_closed(monkeypatch):
    calls, sleeps = [], []

    async def no_world(fn, **kw):
        calls.append(kw['args'][0])
        return {'skipped': 'no_world_session'}

    m = _patch_workflows(monkeypatch, no_world, sleeps)
    root = _simulated_workflow('root')
    asyncio.run(m.AgentWorkflow._register_on_world_clock(root))
    assert calls == ['register'] * m.WORLD_CLOCK_REGISTER_ATTEMPTS, 'a missing world retries a bounded number of times'
    assert len(sleeps) == m.WORLD_CLOCK_REGISTER_ATTEMPTS - 1
    assert m.AgentWorkflow._world_clock_missing(root), 'the agent must not start or plan on the real date'
    assert root.simulated_world_time_ms is None and 'world' in m.WORLD_CLOCK_UNAVAILABLE_MESSAGE.lower()
    # A world that appears on the retry is used; a resumed generation keeps its restored cursor.
    clock = WorldClock(start_ms=_ms(PINNED))
    results = iter([{'skipped': 'no_world_session'}])

    async def late_world(fn, **kw):
        return next(results, None) or await _clock_activity(clock)(fn, **kw)

    m = _patch_workflows(monkeypatch, late_world)
    late = _simulated_workflow('late')
    asyncio.run(m.AgentWorkflow._register_on_world_clock(late))
    assert late.simulated_world_time_ms == _ms(PINNED) and not m.AgentWorkflow._world_clock_missing(late)
    resumed = _simulated_workflow('resumed')
    resumed._deployment_resume = True
    assert not m.AgentWorkflow._world_clock_missing(resumed)


@pytest.mark.parametrize('mode', ['real', 'shadow'])
def test_non_simulated_agents_keep_the_wall_clock_and_make_no_clock_calls(monkeypatch, mode):
    from utils.simulated_clock import advance_simulated_clock, simulated_now, simulated_timestamp_ms

    calls, sleeps = [], []

    async def forbidden(fn, **kw):
        calls.append(kw['args'][0])
        raise AssertionError('non-simulated agents must not touch the world clock')

    m = _patch_workflows(monkeypatch, forbidden, sleeps)
    wf = _simulated_workflow('prod', mode=mode)
    wf.simulated_world_time_ms = _ms(PINNED)  # even a stray cursor is ignored outside simulate
    asyncio.run(m.AgentWorkflow._register_on_world_clock(wf))

    async def tool(self, name, args, call_id):
        return {'success': True, 'name': name}

    monkeypatch.setattr(m.AgentWorkflow, '_execute_tool_once', tool, raising=False)
    assert asyncio.run(m.AgentWorkflow._execute_tool(wf, 'web_search', {}, 'c1')) == {'success': True, 'name': 'web_search'}
    from helpers.wait_on_world_clock import hold_on_children, release_children

    asyncio.run(hold_on_children(wf, 'spawn-1:child'))
    asyncio.run(release_children(wf, 'spawn-1:child', ['child']))
    assert calls == [] and sleeps == [] and not m.AgentWorkflow._world_clock_missing(wf)
    assert simulated_now(wf, NOW) == NOW and simulated_timestamp_ms(wf, NOW) == _ms(NOW)
    assert advance_simulated_clock(wf, 300) == 0 and simulated_now(wf, NOW) == NOW


def test_each_child_result_reaches_the_parent_at_that_childs_finish():
    clock = WorldClock(start_ms=0)
    clock.register("root")
    clock.register("fast", parent="root")
    clock.register("slow", parent="root")
    clock.commit("fast", started_ms=0, elapsed_ms=2 * DAY)
    clock.commit("slow", started_ms=0, elapsed_ms=6 * DAY)
    clock.finish("fast")
    # The parent may act on the first result while the other child still runs.
    assert clock.time_of("root") == 2 * DAY
    assert clock.action_time("root") == 2 * DAY
    clock.finish("slow")
    # Now acting, the parent reaches the slow child's finish only on receipt.
    assert clock.time_of("root") == 2 * DAY
    assert clock.receive("root", ["slow"]) == 6 * DAY


def test_an_acting_parent_reaches_a_childs_finish_only_when_it_receives_the_result():
    clock = WorldClock(start_ms=0)
    clock.register("root")
    clock.register("child", parent="root")
    clock.commit("root", started_ms=clock.action_time("root"), elapsed_ms=1 * DAY)  # acting beside its child
    clock.commit("child", started_ms=0, elapsed_ms=5 * DAY)
    clock.finish("child")
    assert clock.time_of("root") == 1 * DAY, "a child's finish must not pull an acting parent forward"
    started = clock.action_time("root")
    assert started == 1 * DAY
    clock.commit("root", started_ms=started, elapsed_ms=3 * 3_600_000)
    assert clock.time_of("root") == 1 * DAY + 3 * 3_600_000
    assert clock.receive("root", ["child"]) == 5 * DAY
    assert clock.receive("root", ["child", "stranger"]) == 5 * DAY  # idempotent; unknown ids ignored


def test_a_parent_blocked_awaiting_its_child_holds_on_children_without_deadlock():
    """The parent acted, spawned, then blocks on its child; waits must still advance world time."""
    async def scenario():
        clock = WorldClock(start_ms=0)
        clock.register("root")
        clock.commit("root", started_ms=0, elapsed_ms=1 * DAY)
        clock.register("child", parent="root")
        clock.register("other", parent="root")
        clock.commit("root", started_ms=clock.action_time("root"), elapsed_ms=0)  # acted beside its children
        assert clock.shared_time() == 1 * DAY, "an acting parent holds shared time"
        clock.hold("root", "spawn-1:child")  # now blocked awaiting the child's result
        clock.hold("root", "spawn-1:child")  # idempotent on activity retry
        woke = []

        async def waiter(agent, until):
            result = await clock.wait(agent, "w", until_ms=until, poll_seconds=5)
            woke.append((agent, result["time_ms"]))
            clock.finish(agent)

        loop = asyncio.get_running_loop()
        started = loop.time()
        await asyncio.wait_for(asyncio.gather(waiter("child", 10 * DAY), waiter("other", 7 * DAY)), 1)
        assert loop.time() - started < 0.5, "world jumps must not wait in real time"
        assert woke == [("other", 7 * DAY), ("child", 10 * DAY)]
        assert clock.time_of("root") == 1 * DAY, "the held parent receives the result only on release"
        assert clock.release("root", "spawn-1:child", ["child"]) == 10 * DAY
        assert {a["agent_id"]: a["state"] for a in clock.snapshot()["agents"]}["root"] == "running"

    run(scenario())


def test_the_blocking_spawn_call_holds_and_releases_the_parent_on_the_world_clock(monkeypatch):
    """End to end: _execute_tool -> the real blocking spawn wait -> hold/release -> cursor refresh."""
    import importlib

    from domains.spawn_sub_agents import handler as spawn
    from utils.simulated_clock import simulated_now

    clock = WorldClock(start_ms=_ms(PINNED))
    calls = []
    base = _clock_activity(clock, calls)

    async def activity(fn, **kw):
        if getattr(fn, '__name__', '') != 'world_clock_activity':
            return None  # terminal-result reconciliation: the completion signal has not arrived yet
        operation, agent_id, _parent, payload = (list(kw['args']) + [None, None])[:4]
        if operation in ('hold', 'release'):
            calls.append(operation)
            if operation == 'hold':
                return {'agent_id': agent_id, 'time_ms': clock.hold(agent_id, payload['hold_id'])}
            return {'agent_id': agent_id, 'time_ms': clock.release(agent_id, payload['hold_id'], payload['children'])}
        return await base(fn, **kw)

    async def wait_condition(predicate, timeout=None):
        while not predicate():
            await asyncio.sleep(0)

    m = _patch_workflows(monkeypatch, activity)
    fake = types.SimpleNamespace(
        execute_activity=activity, now=lambda: NOW, wait_condition=wait_condition,
        logger=types.SimpleNamespace(error=lambda *a: None),
    )
    monkeypatch.setattr(spawn, 'workflow', fake)
    monkeypatch.setattr(importlib.import_module('helpers.wait_on_world_clock'), 'workflow', fake)

    async def no_handoff(_wf):
        return None

    monkeypatch.setattr(importlib.import_module('helpers.wait_condition_or_handoff'), 'live_handoff_queue', no_handoff)
    root = _simulated_workflow('root')
    root.__dict__.update(child_tool_ids={}, child_results={}, pending_children=set(), child_workflow_ids={})

    async def post_message(*_a, **_kw):
        return None

    root._post_message = post_message
    asyncio.run(m.AgentWorkflow._register_on_world_clock(root))

    woke = []

    async def scenario():
        clock.commit('root', started_ms=clock.action_time('root'), elapsed_ms=DAY)  # the parent acts until 1d
        clock.register('child', parent='root')
        clock.register('other', parent='root')
        clock.commit('root', started_ms=clock.action_time('root'), elapsed_ms=0)  # still acting after spawning

        async def child_runs():
            woke.append(('child', (await clock.wait('child', 'w', until_ms=_ms(PINNED) + 10 * DAY, poll_seconds=5))['time_ms']))
            clock.finish('child')
            root.child_results['child'] = {'status': 'completed', 'summary': 'done'}  # child_completed signal

        async def other_runs():
            woke.append(('other', (await clock.wait('other', 'w', until_ms=_ms(PINNED) + 7 * DAY, poll_seconds=5))['time_ms']))
            clock.finish('other')

        async def blocking_spawn(self, name, args, call_id):  # the tool call blocks in the real spawn wait
            gen = spawn.SpawnSubAgentManager().finalize_child(
                self, {'agent_id': 'child', 'goal': 'g'}, {'goal': 'g'}, call_id, 'bus')
            return [event async for event in gen]

        monkeypatch.setattr(m.AgentWorkflow, '_execute_tool_once', blocking_spawn, raising=False)

        async def parent_blocks():
            return await m.AgentWorkflow._execute_tool(root, 'spawn_agent', {}, 'spawn-1')

        loop = asyncio.get_running_loop()
        started = loop.time()
        events, *_ = await asyncio.wait_for(asyncio.gather(parent_blocks(), child_runs(), other_runs()), 1)
        assert loop.time() - started < 0.5, 'no deadlock and no real-time waiting'
        return events

    events = asyncio.run(scenario())
    assert events[-1].status.name == 'FINISHED'
    assert calls.count('hold') == 1 and calls.count('release') == 1
    assert calls.index('hold') < calls.index('release') < len(calls) - 1 and calls[-1] == 'time'
    assert woke == [('other', _ms(PINNED) + 7 * DAY), ('child', _ms(PINNED) + 10 * DAY)], 'world time jumps 7d, then 10d'
    assert root.simulated_world_time_ms >= _ms(PINNED) + 10 * DAY
    assert simulated_now(root, NOW) >= PINNED + timedelta(days=10)


def test_leaving_a_blocking_child_wait_without_the_result_releases_the_hold(monkeypatch):
    """A generation handoff (or any error) mid-wait must not leave the parent held."""
    import importlib

    from domains.spawn_sub_agents import handler as spawn
    from helpers.generation_handoff import GenerationHandoffRequested

    clock = WorldClock(start_ms=0)
    calls = []

    async def activity(fn, **kw):
        if getattr(fn, '__name__', '') != 'world_clock_activity':
            return None  # terminal-result reconciliation finds nothing yet
        operation, agent_id, _parent, payload = (list(kw['args']) + [None, None])[:4]
        calls.append((operation, payload))
        if operation == 'hold':
            return {'agent_id': agent_id, 'time_ms': clock.hold(agent_id, payload['hold_id'])}
        if operation == 'release':
            return {'agent_id': agent_id, 'time_ms': clock.release(agent_id, payload['hold_id'], payload['children'])}
        raise AssertionError(operation)

    fake = types.SimpleNamespace(execute_activity=activity, now=lambda: NOW, logger=types.SimpleNamespace(error=lambda *a: None))
    monkeypatch.setattr(spawn, 'workflow', fake)
    monkeypatch.setattr(importlib.import_module('helpers.wait_on_world_clock'), 'workflow', fake)

    async def handoff(_wf):
        return 'new-queue'

    monkeypatch.setattr(importlib.import_module('helpers.wait_condition_or_handoff'), 'live_handoff_queue', handoff)
    clock.register('root')
    clock.register('child', parent='root')
    clock.commit('root', started_ms=clock.action_time('root'), elapsed_ms=DAY)
    root = _simulated_workflow('root')
    # A delivered generation_handoff_available signal makes the park read the pointer.
    importlib.import_module('helpers.wait_condition_or_handoff').note_generation_handoff(root, 'new-queue', 'old-queue')
    root.__dict__.update(child_tool_ids={}, child_results={}, pending_children=set(), child_workflow_ids={},
                         simulated_world_time_ms=DAY)

    async def post_message(*_a, **_kw):
        return None

    root._post_message = post_message

    async def blocking_spawn():
        gen = spawn.SpawnSubAgentManager().finalize_child(root, {'agent_id': 'child', 'goal': 'g'}, {'goal': 'g'}, 'spawn-1', 'bus')
        return [event async for event in gen]

    with pytest.raises(GenerationHandoffRequested):
        asyncio.run(blocking_spawn())
    clock_calls = [call for call in calls if call[0] in ('hold', 'release')]
    assert clock_calls == [('hold', {'hold_id': 'spawn-1:child'}), ('release', {'hold_id': 'spawn-1:child', 'children': []})]
    assert {a['agent_id']: a['state'] for a in clock.snapshot()['agents']}['root'] == 'running'
    assert clock.time_of('root') == DAY, 'no child result was delivered'


@pytest.mark.parametrize('cancelled_at', ['hold', 'wait'])
def test_cancelling_a_blocking_child_wait_releases_the_hold_and_keeps_the_cancellation(monkeypatch, cancelled_at):
    """PR #1538 review: asyncio.CancelledError bypassed ``except Exception`` and left the parent held."""
    import importlib

    from domains.spawn_sub_agents import handler as spawn

    clock = WorldClock(start_ms=0)
    calls = []

    async def activity(fn, **kw):
        if getattr(fn, '__name__', '') != 'world_clock_activity':
            return None  # terminal-result reconciliation finds nothing yet
        operation, agent_id, _parent, payload = (list(kw['args']) + [None, None])[:4]
        calls.append((operation, payload))
        if operation == 'hold':
            time_ms = clock.hold(agent_id, payload['hold_id'])
            if cancelled_at == 'hold':
                raise asyncio.CancelledError  # cancelled while the hold request was in flight
            return {'agent_id': agent_id, 'time_ms': time_ms}
        if operation == 'release':
            return {'agent_id': agent_id, 'time_ms': clock.release(agent_id, payload['hold_id'], payload['children'])}
        raise AssertionError(operation)

    fake = types.SimpleNamespace(execute_activity=activity, now=lambda: NOW, logger=types.SimpleNamespace(error=lambda *a: None))
    monkeypatch.setattr(spawn, 'workflow', fake)
    monkeypatch.setattr(importlib.import_module('helpers.wait_on_world_clock'), 'workflow', fake)

    async def cancelled(_wf):
        raise asyncio.CancelledError

    monkeypatch.setattr(importlib.import_module('helpers.wait_condition_or_handoff'), 'live_handoff_queue', cancelled)
    clock.register('root')
    clock.register('child', parent='root')
    clock.commit('root', started_ms=clock.action_time('root'), elapsed_ms=DAY)
    root = _simulated_workflow('root')
    # A delivered generation_handoff_available signal makes the park read the pointer.
    importlib.import_module('helpers.wait_condition_or_handoff').note_generation_handoff(root, 'new-queue', 'old-queue')
    root.__dict__.update(child_tool_ids={}, child_results={}, pending_children=set(), child_workflow_ids={},
                         simulated_world_time_ms=DAY)

    async def post_message(*_a, **_kw):
        return None

    root._post_message = post_message

    async def blocking_spawn():
        gen = spawn.SpawnSubAgentManager().finalize_child(root, {'agent_id': 'child', 'goal': 'g'}, {'goal': 'g'}, 'spawn-1', 'bus')
        return [event async for event in gen]

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(blocking_spawn())
    clock_calls = [call for call in calls if call[0] in ('hold', 'release')]
    assert clock_calls == [('hold', {'hold_id': 'spawn-1:child'}), ('release', {'hold_id': 'spawn-1:child', 'children': []})]
    assert {a['agent_id']: a['state'] for a in clock.snapshot()['agents']}['root'] == 'running', 'the hold was released'


def test_a_wait_acknowledgment_never_moves_the_cursor_backwards(monkeypatch):
    """PR #1538 review: an earlier failed wait advanced the cursor locally; a later, older ack must not rewind it."""
    import importlib

    from helpers.wait_on_world_clock import _wait_on_world_clock

    async def older_ack(fn, **kw):
        return {'resumed': True, 'time_ms': 5 * DAY}

    fake = types.SimpleNamespace(execute_activity=older_ack, now=lambda: NOW, logger=types.SimpleNamespace(error=lambda *a: None))
    monkeypatch.setattr(importlib.import_module('helpers.wait_on_world_clock'), 'workflow', fake)
    wf = _simulated_workflow('root')
    wf.simulated_world_time_ms = 6 * DAY  # advanced on the agent's own clock after a failed wait
    assert asyncio.run(_wait_on_world_clock(wf, 'w-2', duration_ms=1)) == 6 * DAY
    assert wf.simulated_world_time_ms == 6 * DAY
    wf.simulated_world_time_ms = 4 * DAY
    assert asyncio.run(_wait_on_world_clock(wf, 'w-3', duration_ms=1)) == 5 * DAY
    assert wf.simulated_world_time_ms == 5 * DAY


def test_unacknowledged_hold_and_release_are_reported_and_release_rereads_world_time(monkeypatch):
    """PR #1538 review: a failed hold/release returned None and the caller resumed without an acknowledgment."""
    import importlib

    from helpers.wait_on_world_clock import hold_on_children, release_children

    calls = []

    async def failing(fn, **kw):
        operation = kw['args'][0]
        calls.append(operation)
        if operation in ('hold', 'release'):
            raise RuntimeError('WMH unavailable')  # every activity attempt failed
        return {'agent_id': 'root', 'time_ms': 3 * DAY}

    fake = types.SimpleNamespace(execute_activity=failing, now=lambda: NOW, logger=types.SimpleNamespace(error=lambda *a: None))
    monkeypatch.setattr(importlib.import_module('helpers.wait_on_world_clock'), 'workflow', fake)
    wf = _simulated_workflow('root')
    wf.simulated_world_time_ms = DAY
    assert asyncio.run(hold_on_children(wf, 'spawn-1:child')) is False
    assert asyncio.run(release_children(wf, 'spawn-1:child', ['child'])) is False
    assert calls == ['hold', 'release', 'time'], 'a failed release re-reads the world time instead of resuming blind'
    assert wf.simulated_world_time_ms == 3 * DAY
    real = _simulated_workflow('prod', mode='real')
    calls.clear()
    assert asyncio.run(hold_on_children(real, 'h')) is True and asyncio.run(release_children(real, 'h', [])) is True
    assert calls == [], 'outside a world nothing is held and nothing is called'


@pytest.mark.parametrize('mode', ['simulate', 'real'])
def test_a_resumed_agent_without_a_persisted_cursor_recovers_its_world_time(monkeypatch, mode):
    """PR #1538 review: continuation state from before the cursor existed resumed on the real date."""
    calls = []

    async def activity(fn, **kw):
        calls.append(kw['args'][0])
        if mode != 'simulate':
            raise AssertionError('non-simulated agents must not touch the world clock')
        return {'agent_id': 'resumed', 'time_ms': _ms(PINNED) + DAY}

    m = _patch_workflows(monkeypatch, activity)
    resumed = _simulated_workflow('resumed', mode=mode)
    resumed._deployment_resume = True
    asyncio.run(m.AgentWorkflow._recover_world_time_cursor(resumed))
    if mode == 'simulate':
        assert calls == ['time'] and resumed.simulated_world_time_ms == _ms(PINNED) + DAY
        calls.clear()
        asyncio.run(m.AgentWorkflow._recover_world_time_cursor(resumed))
        assert calls == [], 'a persisted cursor is kept without another clock call'
    else:
        assert calls == [] and resumed.simulated_world_time_ms is None


@pytest.mark.parametrize('failures', [2, 3])
def test_a_failed_post_tool_cursor_read_is_retried_before_the_agent_continues(monkeypatch, failures):
    """PR #1538 review: a failed refresh after a tool let the next consumer read the pre-action time."""
    calls, sleeps, errors = [], [], []

    async def activity(fn, **kw):
        calls.append(kw['args'][0])
        if len(calls) <= failures:
            raise RuntimeError('WMH clock unavailable')
        return {'agent_id': 'root', 'time_ms': 2 * DAY}

    m = _patch_workflows(monkeypatch, activity, sleeps)
    m.workflow.logger = types.SimpleNamespace(error=lambda *a: errors.append(a))
    wf = _simulated_workflow('root')
    wf.simulated_world_time_ms = DAY

    async def tool(self, name, args, call_id):
        return {'success': True}

    monkeypatch.setattr(m.AgentWorkflow, '_execute_tool_once', tool, raising=False)
    assert asyncio.run(m.AgentWorkflow._execute_tool(wf, 'web_search', {}, 'c1')) == {'success': True}
    attempts = m.WORLD_CLOCK_REFRESH_ATTEMPTS
    if failures < attempts:
        assert calls == ['time'] * (failures + 1) and wf.simulated_world_time_ms == 2 * DAY
        assert len(sleeps) == failures and not any('could not refresh' in str(e) for e in errors)
    else:
        assert calls == ['time'] * attempts and len(sleeps) == attempts - 1
        assert wf.simulated_world_time_ms == DAY, 'keeps the last acknowledged world time'
        assert any('could not refresh its world time' in str(e) for e in errors)
