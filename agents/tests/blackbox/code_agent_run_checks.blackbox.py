"""Blackbox tests: the code-agent run checks the code-agent benchmark calls on a finished run.

benchmarks/code_agent_run_checks.py reads the agent-detail rows and the
sidebar's code-agent list. The incident-shaped run is root 1a3d495c ("Rose
Repo Status", 2026-11-06): one spawn made 3 code agents, a second spawn a
4th, and the root's send to /root/rose_repo_status failed. Both checks fail
on it; a healthy run (one spawn, one task, a delivered message the CLI shows)
passes both.
"""

import asyncio

from _test_utils import BlackboxResult

ROOT = "1a3d495c-826c-4eca-afe0-382fcbf72e82"
SPAWN = "toolu_01Dt3LaU11ViNtfGTtAHUNQG"
TASK = "9c3c19a0-5596-4854-acdc-1685da1ef942"
MESSAGE = "Please print your findings in your final reply and write them to /home/user/.rose/handoff.json."


def _spawn(call_id, task_name):
    return {
        "role": "ASSISTANT",
        "text": "",
        "metadata": {
            "tool_calls": [
                {"tool": "spawn_agent", "type": "code", "task_name": task_name, "tool_call_id": call_id, "goal": "g"}
            ]
        },
    }


def _code_row(call_id, task_id, text="", **extra):
    return {
        "role": "TOOL",
        "text": text,
        "metadata": {"toolName": "spawn_claude_code_agent", "toolCallId": call_id, "task_id": task_id, **extra},
    }


def _send(call_id, to):
    return {
        "role": "ASSISTANT",
        "text": "",
        "metadata": {
            "tool_calls": [{"tool": "send_message_to_agent", "to": to, "message": MESSAGE, "tool_call_id": call_id}]
        },
    }


def _send_result(call_id, status, text):
    return {
        "role": "TOOL",
        "text": text,
        "metadata": {"toolName": "send_message_to_agent", "toolCallId": call_id, "toolStatus": status},
    }


def _code_agent(task_id):
    return {"code_agent_id": task_id, "root_agent_id": ROOT, "owner_agent_id": ROOT, "status": "ACTIVE"}


def _started_row(task_id, startup=None):
    code_agent = {"state": "live", "task_id": task_id}
    if startup is not None:
        code_agent["startup"] = startup
    return _code_row(SPAWN, task_id, toolStatus="IN_PROGRESS", title="Claude Code Started", code_agent=code_agent)


def _incident_run():
    return {
        "root_agent_id": ROOT,
        "messages": [
            _spawn(SPAWN, "rose_repo_status"),
            _code_row(SPAWN, TASK, toolStatus="IN_PROGRESS", title="Claude Code Started"),
            _code_row(SPAWN, TASK, toolStatus="FINISHED", title="Task Incomplete"),
            _send("toolu_send", "/root/rose_repo_status"),
            _send_result(
                "toolu_send", "ERROR", "Message delivery failed: No agent or background task at /root/rose_repo_status"
            ),
            _spawn("toolu_second", "rose_repo_status2"),
            _code_row("toolu_second", "6f8f8f4d-c670-4bc8-b5df-e2c785c4a908", toolStatus="FINISHED"),
        ],
        "code_agents": [
            _code_agent("6f8f8f4d-c670-4bc8-b5df-e2c785c4a908"),
            _code_agent("631d4602-3370-4bfb-bc91-59f66094db15"),
            _code_agent(TASK),
            _code_agent("dd8ef6a8-84cb-4772-bebc-1356535e920d"),
        ],
    }


def _healthy_run():
    return {
        "root_agent_id": ROOT,
        "messages": [
            _spawn(SPAWN, "rose_repo_status"),
            _code_row(SPAWN, TASK, toolStatus="IN_PROGRESS", title="Claude Code Started"),
            _send("toolu_send", "/root/rose_repo_status"),
            _send_result("toolu_send", "FINISHED", "Message sent to /root/rose_repo_status."),
            {
                "role": "TOOL",
                "text": MESSAGE,
                "metadata": {
                    "a2a": {"direction": "received", "kind": "message", "text": MESSAGE},
                    "action_type": "agent_message",
                    "task_id": TASK,
                    "subAgentId": TASK,
                    "toolCallId": SPAWN,
                    "toolName": "spawn_claude_code_agent",
                },
            },
            _code_row(SPAWN, TASK, text=f"[Agent → Claude] Message from /root:\n{MESSAGE}", title="Transcript"),
            _code_row(SPAWN, TASK, toolStatus="FINISHED", title="✓ Task Completed"),
        ],
        "code_agents": [_code_agent(TASK)],
    }


def test_incident_run_fails_both_checks():
    from benchmarks.code_agent_run_checks import check_message_reached_code_agent, check_single_code_agent

    single = check_single_code_agent(_incident_run())
    assert single["passed"] is False
    assert "4 code agents under the root (expected 1)" in single["detail"], single
    assert "dd8ef6a8-84cb-4772-bebc-1356535e920d" in single["detail"], single
    reached = check_message_reached_code_agent(_incident_run())
    assert reached["passed"] is False
    assert "No agent or background task at /root/rose_repo_status" in reached["detail"], reached


def test_healthy_run_passes_both_checks():
    from benchmarks.code_agent_run_checks import check_message_reached_code_agent, check_single_code_agent

    single = check_single_code_agent(_healthy_run())
    assert single["passed"] is True, single
    assert single["code_agent_ids"] == [TASK]
    reached = check_message_reached_code_agent(_healthy_run())
    assert reached["passed"] is True, reached
    assert reached["sends"][0]["delivered"] is True and reached["sends"][0]["seen"] is True


def test_retried_sends_while_starting_are_tolerated_but_other_failures_are_not():
    from benchmarks.code_agent_run_checks import check_message_reached_code_agent

    not_started = "Message delivery failed: Code agent session has not started yet; send again once it runs"
    run = _healthy_run()
    # Two earlier sends were refused truthfully while the sandbox cloned its repo; the third was delivered.
    early = [
        _send("toolu_early1", "/root/rose_repo_status"),
        _send_result("toolu_early1", "ERROR", not_started),
        _send("toolu_early2", "/root/rose_repo_status"),
        _send_result("toolu_early2", "ERROR", not_started),
    ]
    run["messages"] = run["messages"][:2] + early + run["messages"][2:]
    ok = check_message_reached_code_agent(run)
    assert ok["passed"] is True and "2 earlier send(s) retried while starting" in ok["detail"], ok

    # Only pre-start refusals: nothing was ever delivered.
    only_refused = {
        "root_agent_id": ROOT,
        "messages": [_spawn(SPAWN, "rose_repo_status"), _code_row(SPAWN, TASK)] + early,
    }
    refused = check_message_reached_code_agent(only_refused)
    assert refused["passed"] is False and "no send was delivered" in refused["detail"], refused

    # A different failure is never tolerated, even next to a delivered send.
    run = _healthy_run()
    run["messages"] = (
        run["messages"][:2]
        + [
            _send("toolu_bad", "/root/rose_repo_status"),
            _send_result("toolu_bad", "ERROR", "Message delivery failed: Activity task failed"),
        ]
        + run["messages"][2:]
    )
    bad = check_message_reached_code_agent(run)
    assert bad["passed"] is False and "Activity task failed" in bad["detail"], bad


def test_undelivered_or_unseen_message_fails():
    from benchmarks.code_agent_run_checks import check_message_reached_code_agent

    run = _healthy_run()
    run["messages"] = [row for row in run["messages"] if "[Agent → " not in row["text"]]
    unseen = check_message_reached_code_agent(run)
    assert unseen["passed"] is False and "transcript never shows the message" in unseen["detail"], unseen
    run = _healthy_run()
    run["messages"] = [row for row in run["messages"] if not row["metadata"].get("a2a")]
    undelivered = check_message_reached_code_agent(run)
    assert undelivered["passed"] is False and "no delivered CLI turn" in undelivered["detail"], undelivered
    run = _healthy_run()
    run["messages"] = [row for row in run["messages"] if row["metadata"].get("toolName") != "send_message_to_agent"]
    run["messages"] = [row for row in run["messages"] if not row["metadata"].get("tool_calls", [{}])[0].get("to")]
    nothing = check_message_reached_code_agent(run)
    assert nothing["passed"] is False and "no send_message_to_agent" in nothing["detail"], nothing


def test_startup_phase_is_read_from_the_start_row():
    from benchmarks.code_agent_run_checks import check_startup_reported, startup_phases

    run = {
        "root_agent_id": ROOT,
        "messages": [
            _spawn(SPAWN, "rose_repo_status"),
            _started_row(TASK, {"ws_ready_ms": 183_450, "clone_ms": 181_900}),
        ],
        "code_agents": [_code_agent(TASK)],
    }
    assert startup_phases(run["messages"]) == [{"task_id": TASK, "ws_ready_ms": 183_450, "clone_ms": 181_900}]
    ok = check_startup_reported(run)
    assert ok["passed"] is True and "clone 181900ms" in ok["detail"], ok
    slow = check_startup_reported(run, max_ws_ready_ms=60_000)
    assert slow["passed"] is False and "took 183450ms to serve" in slow["detail"], slow
    # A resume has no clone: ws_ready_ms alone is a valid report.
    resumed = check_startup_reported(
        {"messages": [_spawn(SPAWN, "x"), _started_row(TASK, {"ws_ready_ms": 900, "clone_ms": None})]}
    )
    assert resumed["passed"] is True, resumed
    # No startup on the row (an older backend, or a create that never reported it) fails loudly.
    missing = check_startup_reported({"messages": [_spawn(SPAWN, "x"), _started_row(TASK)]})
    assert missing["passed"] is False and "reported no startup phases" in missing["detail"], missing


async def run_all_tests():
    print("code-agent-run-checks blackbox tests:")
    r = BlackboxResult()
    r.record("incident_run_fails_both_checks", test_incident_run_fails_both_checks)
    r.record("healthy_run_passes_both_checks", test_healthy_run_passes_both_checks)
    r.record("undelivered_or_unseen_message_fails", test_undelivered_or_unseen_message_fails)
    r.record("startup_phase_is_read_from_the_start_row", test_startup_phase_is_read_from_the_start_row)
    r.record(
        "retried_sends_while_starting_are_tolerated_but_other_failures_are_not",
        test_retried_sends_while_starting_are_tolerated_but_other_failures_are_not,
    )
    return r.summary()


if __name__ == "__main__":
    asyncio.run(run_all_tests())
