"""World clock semantics (V4, V5, V7, V8, V10, V11), run by the WMH blackbox gate."""

import asyncio

import pytest

from benchmarks.wmh_world_clock import WorldClock

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
