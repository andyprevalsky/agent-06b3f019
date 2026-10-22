"""Offline tests for the CAPTCHA probe catalog and verdict logic (no stack, no LLM)."""

import json

import argparse
import asyncio

import pytest

from benchmarks import run_captcha_probe as probe_module
from benchmarks.run_captcha_probe import (
    _fe_link,
    build_judge_evidence,
    collect_antibot_events,
    compact_transcript,
    decide_verdict,
    grade,
    load_probes,
    load_saved_run,
    log_paths,
    save_run,
    summarize_events,
    tree_agent_ids,
)

ROOT = "84a6cb53-e3a0-43f6-83cd-a8237fa57758"
BROWSER = "5ef56c1d-e27a-49d5-873a-dfb3dce1e982"
OTHER = "22858ea0-b08f-4fa9-9bd5-da6e39359027"
USER = "1f85ff25-6e29-4c1b-8739-f917bd101a30"


def _line(event: str, **fields) -> str:
    return "2026-10-22 04:10:45 [info] " + json.dumps({"event": event, **fields})


STUCK_LOG = [
    _line("Challenge LLM classifier result", challenged=True, reason="Google /sorry", agent_id=BROWSER),
    _line(
        "antibot.episode",
        agent_id=BROWSER,
        host="www.google.com",
        cleared=False,
        recovery_invoked=True,
        recovery_outcome="failed: Browser storage capture timed out after 15s before challenge recovery.",
    ),
    _line("antibot.stuck", agent_id=BROWSER, host="www.google.com", final_url_host="www.google.com"),
    # Another agent on the same worker, and a user-scoped line: neither belongs to this run.
    _line("antibot.stuck", agent_id=OTHER, host="tinypng.com"),
    _line("antibot.episode", user_id=USER, host="example.com"),
    _line("Something unrelated", agent_id=BROWSER),
]

CLEARED_LOG = [
    _line("Challenge LLM classifier result", challenged=True, reason="DataDome", agent_id=BROWSER),
    _line("antibot.episode", agent_id=BROWSER, host="www.target.com", cleared=True, recovery_outcome="cleared_after_patience"),
]


def _summary(lines):
    return summarize_events(collect_antibot_events(lines, tree_agent_ids(ROOT, [{"child": BROWSER, "user": USER}], [USER])))


def test_log_collection_is_scoped_to_the_agent_tree():
    events = collect_antibot_events(STUCK_LOG, tree_agent_ids(ROOT, [{"child": BROWSER, "user": USER}], [USER]))
    assert [event["_event"] for event in events] == [
        "Challenge LLM classifier result",
        "antibot.episode",
        "antibot.stuck",
    ]
    summary = summarize_events(events)
    assert summary == {
        "episodes": 1,
        "stuck": 1,
        "recovery_failed": 1,
        "classifier_challenged": 1,
        "cleared": 0,
        "cleared_by_patience": 0,
        "cleared_by_recovery": 0,
        "last_stuck_host": "www.google.com",
    }


def test_unresolved_challenge_is_failed_even_when_judge_hedges():
    summary = _summary(STUCK_LOG)
    hedged = {"verdict": "INCONCLUSIVE", "reason": "agent stopped"}
    assert decide_verdict(hedged, summary, "agent COMPLETED")["verdict"] == "FAILED_CAPTCHA"
    unsupported_pass = {"verdict": "PASSED_CAPTCHA", "reason": "agent said done", "evidence_seen": ""}
    assert decide_verdict(unsupported_pass, summary, "agent COMPLETED")["verdict"] == "FAILED_CAPTCHA"


def test_failed_recovery_without_evidence_is_failed():
    summary = summarize_events(collect_antibot_events(STUCK_LOG[:2], [BROWSER]))
    assert summary["stuck"] == 0 and summary["recovery_failed"] == 1
    decided = decide_verdict({"verdict": "INCONCLUSIVE", "reason": ""}, summary, "cap reached")
    assert decided["verdict"] == "FAILED_CAPTCHA"


def test_cleared_wall_with_post_wall_evidence_passes():
    judged = {"verdict": "PASSED_CAPTCHA", "reason": "price visible", "evidence_seen": "iPad Air M3 $599.99"}
    assert decide_verdict(judged, _summary(CLEARED_LOG), "agent COMPLETED") == {
        "verdict": "PASSED_CAPTCHA",
        "reason": "price visible",
        "confidence": "low",  # the judge stated none
    }


def test_no_wall_and_evidence_reached_passes():
    judged = {"verdict": "passed_captcha", "reason": "results listed", "evidence_seen": "organic results"}
    assert decide_verdict(judged, _summary([]), "agent COMPLETED")["verdict"] == "PASSED_CAPTCHA"


def test_judge_failed_verdict_is_kept():
    judged = {"verdict": "FAILED_CAPTCHA", "reason": "Access Denied page at the end"}
    assert decide_verdict(judged, _summary([]), "agent COMPLETED")["verdict"] == "FAILED_CAPTCHA"


def test_non_captcha_stop_is_inconclusive_with_its_reason():
    judged = {"verdict": "INCONCLUSIVE", "reason": "agent asked which theater to use before navigating"}
    decided = decide_verdict(judged, _summary([]), "pending question/approval (not approved): Which theater?")
    assert (decided["verdict"], decided["reason"]) == (
        "INCONCLUSIVE",
        "agent asked which theater to use before navigating",
    )
    no_reason = decide_verdict({"verdict": "INCONCLUSIVE"}, _summary([]), "cap reached")
    assert (no_reason["verdict"], no_reason["reason"]) == ("INCONCLUSIVE", "cap reached")


def test_invalid_judge_reply_is_inconclusive_not_a_pass():
    decided = decide_verdict({"verdict": "maybe"}, _summary([]), "agent FAILED")
    assert decided["verdict"] == "INCONCLUSIVE" and "agent FAILED" in decided["reason"]


def test_probe_catalog_covers_every_production_site():
    probes = load_probes()
    assert len(probes) == 39
    held = sorted(name for name, probe in probes.items() if probe["hold"])
    assert held == ["nvidia-geforce-now-account", "uber-login"]
    assert {"kokkari-menu", "foreign-cinema-menu"} <= set(probes)
    for name, probe in probes.items():
        assert 'spawn_agent with type="browser"' in probe["goal"], name
        assert "Do not ask me any questions" in probe["goal"], name
        assert probe["post_wall_evidence"] and probe["where_captcha_hit"], name
        assert ("{frontend_url}" in probe["goal"]) == (name == "stripe-test-payment"), name
        if probe["hold"]:
            assert probe.get("hold_reason"), name


def test_every_worker_log_of_a_multi_worker_stack_is_read(tmp_path):
    """run-bench stacks write worker.log plus worker.1..7.log; the stuck line can land in any of them."""
    for name, lines in (("worker.log", STUCK_LOG[:2]), ("worker.3.log", STUCK_LOG[2:3]), ("backend.log", [])):
        (tmp_path / name).write_text("\n".join(lines) + "\n")
    (tmp_path / "unrelated.txt").write_text(STUCK_LOG[2])
    paths = log_paths([], [], str(tmp_path))
    assert [path.name for path in paths] == ["worker.3.log", "worker.log", "backend.log"]
    assert log_paths([str(tmp_path / "worker*.log")], [], "") == paths[:2]
    lines = [line for path in paths for line in path.read_text().splitlines()]
    summary = summarize_events(collect_antibot_events(lines, [BROWSER]))
    assert summary["stuck"] == 1 and summary["recovery_failed"] == 1


def test_stack_log_dir_finds_run_bench_and_run_sh_logs(tmp_path):
    """--stack-log-dir takes a run-bench context dir (logs/ inside) or a run.sh checkout root."""
    logs = tmp_path / "ctx" / "logs"
    logs.mkdir(parents=True)
    for name in ("worker.log", "worker.1.log", "worker.7.log", "backend.log"):
        (logs / name).write_text("")
    assert [path.name for path in log_paths([], [], str(tmp_path / "ctx"))] == [
        "worker.1.log",
        "worker.7.log",
        "worker.log",
        "backend.log",
    ]
    checkout = tmp_path / "checkout"
    (checkout / "agents").mkdir(parents=True)
    (checkout / "back-end").mkdir()
    (checkout / "agents" / "navi-worker-log.txt").write_text("")
    (checkout / "back-end" / "backend-logs.log").write_text("")
    assert [path.name for path in log_paths([], [], str(checkout))] == ["navi-worker-log.txt", "backend-logs.log"]


# ── judge input: a terse final answer must not starve the judge ──────────────

SNAPSHOT = (
    "Current URL: https://www.bing.com/search?q=OpenAI+official+website\nTitle: OpenAI official website - Search\n"
    + "Results:\n1. OpenAI https://openai.com/ - official site\n2. OpenAI - Wikipedia https://en.wikipedia.org/wiki/OpenAI\n" * 3
)


def _browser(index: int, text: str, tool: str = "spawn_browser_agent", url: str = "", title: str = "") -> dict:
    return {
        "role": "TOOL",
        "message": text,
        "metadata": {"toolName": tool, "browser_url": url, "title": title, "action_type": "step"},
    }


def _terse_run():
    root = [
        {"role": "USER", "message": "go to bing and report one result"},
        {"role": "TOOL", "message": "Browser agent finished", "metadata": {"toolName": "spawn_browser_agent"}},
        {"role": "ASSISTANT", "message": "Done."},
    ]
    children = [_browser(i, f"clicked element {i}", url="https://www.bing.com/search?q=x") for i in range(75)]
    children.append(
        _browser(75, SNAPSHOT, tool="read_browser_state", url="https://www.bing.com/search?q=OpenAI+official+website", title="OpenAI official website - Search")
    )
    return root, children


def test_old_window_dropped_the_root_final_answer_new_input_keeps_it():
    root, children = _terse_run()
    old = compact_transcript(root + children)  # the old window: root first, children after
    assert not any(item["text"].endswith("Done.") for item in old)
    evidence = build_judge_evidence(root, children)
    assert evidence["agent_final_answer"] == "Done."
    assert evidence["browser_tabs_at_end_most_recent_last"][-1] == {
        "url": "https://www.bing.com/search?q=OpenAI+official+website",
        "title": "OpenAI official website - Search",
    }
    last = evidence["last_browser_observations"][-1]
    assert last["tool"] == "read_browser_state" and "https://openai.com/ - official site" in last["text"]


def test_long_snapshots_are_truncated_not_dropped():
    root, children = _terse_run()
    children[-1]["message"] = "HEADER " + "x" * 20000 + " FINAL: AMC seat map with prices loaded"
    text = build_judge_evidence(root, children)["last_browser_observations"][-1]["text"]
    assert len(text) < 4100 and text.startswith("HEADER") and text.endswith("prices loaded")


def test_grade_gives_the_judge_the_final_state_and_reports_confidence():
    root, children = _terse_run()
    seen = {}

    async def fake_judge(probe, observed, summary, end_reason, user_id):
        seen["observed"] = json.dumps(observed)
        return {"verdict": "PASSED_CAPTCHA", "reason": "organic results listed", "evidence_seen": "openai.com result", "confidence": "high", "_model": "fake"}

    probe = load_probes()["bing-search"]
    result = asyncio.run(grade(probe, root, children, _summary([]), "agent COMPLETED", USER, judge=fake_judge))
    assert "Done." in seen["observed"] and "openai.com/ - official site" in seen["observed"]
    assert (result["verdict"], result["confidence"]) == ("PASSED_CAPTCHA", "high")
    assert result["judge_input"] == {"final_answer_chars": 5, "tabs": 2, "observations": 1}


def test_confidence_is_lowered_for_overrides_and_missing_evidence():
    stuck = _summary(STUCK_LOG)
    overridden = decide_verdict({"verdict": "INCONCLUSIVE", "reason": "x", "confidence": "high"}, stuck, "agent COMPLETED")
    assert (overridden["verdict"], overridden["confidence"]) == ("FAILED_CAPTCHA", "medium")
    no_evidence = decide_verdict({"verdict": "PASSED_CAPTCHA", "reason": "said so", "evidence_seen": "", "confidence": "high"}, _summary([]), "agent COMPLETED")
    assert no_evidence["confidence"] == "low"
    assert decide_verdict({"verdict": "FAILED_CAPTCHA", "reason": "x"}, _summary([]), "e")["confidence"] == "low"


def test_saved_transcripts_round_trip_and_raw_agent_records_load(tmp_path):
    root, children = _terse_run()
    path = save_run(str(tmp_path), {"probe": "bing-search", "agent_id": "1a9cff33-ad45", "end_reason": "agent COMPLETED", "antibot": {"episodes": 0}, "root_messages": root, "child_messages": children})
    loaded = load_saved_run(str(path))
    assert loaded["probe"] == "bing-search" and loaded["root"] == root and len(loaded["children"]) == 76
    flat = tmp_path / "agent.json"
    flat.write_text(json.dumps({"agent": {"id": ROOT, "messages": root + children}}))
    from_flat = load_saved_run(str(flat))
    assert [m["message"] for m in from_flat["root"]][-1] == "Done." and len(from_flat["children"]) == 76
    bench = tmp_path / "bench.json"
    bench.write_text(json.dumps({"agent": {"id": ROOT, "messages": root}, "_benchmark": {"tree": {ROOT: {"messages": root}, BROWSER: {"messages": children}}}}))
    assert len(load_saved_run(str(bench))["children"]) == 76


def test_rejudge_regrades_a_saved_transcript_without_running_anything(tmp_path, capsys, monkeypatch):
    root, children = _terse_run()
    path = save_run(str(tmp_path), {"probe": "bing-search", "agent_id": "1a9cff33-ad45", "end_reason": "agent COMPLETED", "antibot": _summary([]), "root_messages": root, "child_messages": children})

    async def fake_judge(probe, observed, summary, end_reason, user_id):
        assert observed["agent_final_answer"] == "Done."
        return {"verdict": "PASSED_CAPTCHA", "reason": "r", "evidence_seen": "results", "confidence": "medium", "_model": "fake"}

    monkeypatch.setattr(probe_module, "_judge", fake_judge)
    assert probe_module.main(["--rejudge", str(path)]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert (line["probe"], line["verdict"], line["confidence"], line["rejudged"]) == ("bing-search", "PASSED_CAPTCHA", "medium", True)


def test_frontend_link_uses_the_frontend_port():
    args = argparse.Namespace(base_url="http://localhost:3001/", frontend_url="")
    assert _fe_link(args, "abc") == "http://localhost:3002/?agent-id=abc"
    args.frontend_url = "http://localhost:5050/"
    assert _fe_link(args, "abc") == "http://localhost:5050/?agent-id=abc"


# ── rows shaped like the real stack: text is empty, the content is in metadata ───────────────

PAGE = "Current URL: https://www.ticketmaster.com/search?q=new+york\n3 events: Knicks vs Nets, Wicked, Hamilton\n" * 4


def _real_rows():
    root = [
        {"role": "USER", "text": "search ticketmaster", "metadata": {}},
        {"role": "TOOL", "text": "", "metadata": {"toolName": "spawn_browser_agent", "toolStatus": "FINISHED", "summary": "Reached the results page with 3 events."}},
        {"role": "ASSISTANT", "text": "", "metadata": {"sendMessageToUser": "Found 3 events: Knicks vs Nets, Wicked, Hamilton.", "toolCallId": "tc-1"}},
    ]
    children = [
        {"role": "TOOL", "text": "", "metadata": {"toolName": "scroll", "action_type": "scroll", "browser_url": "https://www.ticketmaster.com/search?q=new+york", "title": "Search"}}
        for _ in range(70)
    ]
    children.append(
        {
            "role": "TOOL",
            "text": "",
            "metadata": {
                "toolName": "read_browser_state",
                "browser_url": "https://www.ticketmaster.com/search?q=new+york",
                "title": "Ticketmaster search results",
                "output": PAGE,
                "auxiliary": {"screenshot": "data:image/png;base64," + "A" * 5000},
                "screenshot": "A" * 4000,
                "sessionToken": "must-not-appear-token",
                "toolCallId": "tc-obs",
            },
        }
    )
    return root, children


def test_metadata_only_rows_reach_the_judge():
    root, children = _real_rows()
    evidence = build_judge_evidence(root, children)
    assert evidence["agent_final_answer"].endswith("Knicks vs Nets, Wicked, Hamilton.") or "sendMessageToUser: Found 3 events" in evidence["agent_final_answer"]
    assert "Reached the results page with 3 events." in json.dumps(evidence["root_recent_tool_results"])
    observation = evidence["last_browser_observations"][-1]
    assert observation["tool"] == "read_browser_state" and "3 events: Knicks vs Nets" in observation["text"]
    assert evidence["browser_tabs_at_end_most_recent_last"][-1]["title"] == "Search" or observation["title"] == "Ticketmaster search results"
    dumped = json.dumps(evidence)
    assert "base64" not in dumped and "must-not-appear-token" not in dumped and "tc-obs" not in dumped
    assert "3 events" in compact_transcript(root + children)[-1]["text"]


def test_exported_agent_tree_and_probe_name_from_filename(tmp_path):
    """A lane export: the agent tree with a message list per agent; the probe name comes from the file name."""
    root, children = _real_rows()
    export = tmp_path / "ticketmaster-nyc.2.json"
    export.write_text(
        json.dumps(
            {
                "root_agent_id": ROOT,
                "agents": [
                    {"id": BROWSER, "parentId": ROOT, "messages": children},
                    {"id": ROOT, "parentId": None, "messages": root},
                ],
            }
        )
    )
    loaded = load_saved_run(str(export), load_probes())
    assert loaded["probe"] == "ticketmaster-nyc" and loaded["antibot"] is None
    assert loaded["root"] == root and loaded["children"] == children
    keyed = tmp_path / "keyed.json"
    keyed.write_text(json.dumps({"probe_name": "bing-search", "tree": {ROOT: {"messages": root}, BROWSER: {"messages": children, "parent": ROOT}}}))
    assert load_saved_run(str(keyed))["probe"] == "bing-search" and len(load_saved_run(str(keyed))["children"]) == 71


def test_rejudge_reports_when_no_log_facts_were_available(tmp_path, capsys, monkeypatch):
    root, children = _real_rows()
    export = tmp_path / "ticketmaster-nyc.1.json"
    export.write_text(json.dumps({"agents": [{"id": ROOT, "messages": root}, {"id": BROWSER, "parentId": ROOT, "messages": children}]}))

    async def fake_judge(probe, observed, summary, end_reason, user_id):
        assert "3 events: Knicks vs Nets" in json.dumps(observed)
        return {"verdict": "PASSED_CAPTCHA", "reason": "r", "evidence_seen": "3 events", "confidence": "high", "_model": "fake"}

    monkeypatch.setattr(probe_module, "_judge", fake_judge)
    assert probe_module.main(["--rejudge", str(export)]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert (line["probe"], line["verdict"], line["antibot_source"]) == ("ticketmaster-nyc", "PASSED_CAPTCHA", "none")


def test_recovery_clears_are_reported_apart_from_patience_clears():
    """Tilion-only recovery (recovery_outcome=config_selected) has cleared=False in its episode;
    it must not read as 'nothing happened'. stuck and recovery_failed keep their meaning."""
    lines = [
        _line("antibot.episode", agent_id=BROWSER, host="a.com", cleared=True, recovery_outcome="cleared_after_patience"),
        _line("antibot.episode", agent_id=BROWSER, host="b.com", cleared=False, recovery_invoked=True, recovery_outcome="config_selected"),
        _line("antibot.episode", agent_id=BROWSER, host="c.com", cleared=False, recovery_invoked=True, recovery_outcome="cookie_fix"),
        _line("antibot.episode", agent_id=BROWSER, host="d.com", cleared=False, recovery_invoked=True, recovery_outcome="failed: no config cleared it"),
    ]
    summary = summarize_events(collect_antibot_events(lines, [BROWSER]))
    assert (summary["episodes"], summary["cleared_by_patience"], summary["cleared_by_recovery"], summary["cleared"]) == (4, 1, 2, 3)
    assert (summary["stuck"], summary["recovery_failed"]) == (0, 1)
    only_recovery = summarize_events(collect_antibot_events(lines[1:2], [BROWSER]))
    assert (only_recovery["cleared_by_patience"], only_recovery["cleared_by_recovery"], only_recovery["stuck"]) == (0, 1, 0)


def test_browser_rows_inside_the_root_transcript_are_used_as_snapshots():
    """Saved runs on a real stack: child_messages is empty; the browser's steps are root TOOL rows
    (toolName spawn_browser_agent, metadata.subAgentId), the last one holding the page text."""
    root = [{"role": "USER", "text": "search ticketmaster", "metadata": {}}]
    root += [
        {"role": "TOOL", "text": "", "metadata": {"toolName": "spawn_browser_agent", "subAgentId": "task-1", "title": "scroll", "browser_url": "https://www.ticketmaster.com/search?q=ny"}}
        for _ in range(110)
    ]
    root.append({"role": "TOOL", "text": "", "metadata": {"toolName": "spawn_browser_agent", "subAgentId": "task-1", "title": "Read page", "browser_url": "https://www.ticketmaster.com/search?q=ny", "output": PAGE}})
    root.append({"role": "ASSISTANT", "text": "", "metadata": {"sendMessageToUser": "Done."}})
    evidence = build_judge_evidence(root, [])
    assert evidence["browser_tabs_at_end_most_recent_last"][-1]["url"] == "https://www.ticketmaster.com/search?q=ny"
    assert "3 events: Knicks vs Nets" in evidence["last_browser_observations"][-1]["text"]
    assert "Done." in evidence["agent_final_answer"]


def test_root_only_saved_run_reaches_high_confidence_when_the_snapshot_shows_evidence(tmp_path, capsys, monkeypatch):
    """--rejudge on a saved run shaped like lane G's (child_messages empty, browser rows in the root):
    the judge receives the final snapshot, so a judge that grades on it is not capped at low."""
    root = [
        {"role": "TOOL", "text": "", "metadata": {"toolName": "spawn_browser_agent", "subAgentId": "task-1", "browser_url": "https://www.ticketmaster.com/search?q=ny", "output": PAGE}},
        {"role": "ASSISTANT", "text": "", "metadata": {"sendMessageToUser": "Done."}},
    ]
    path = save_run(str(tmp_path), {"probe": "ticketmaster-nyc", "agent_id": "850070ab", "end_reason": "agent COMPLETED", "antibot": _summary(CLEARED_LOG), "root_messages": root, "child_messages": []})

    async def snapshot_judge(probe, observed, summary, end_reason, user_id):
        snapshots = observed["last_browser_observations"]
        shown = bool(snapshots) and "3 events" in snapshots[-1]["text"]
        return {
            "verdict": "PASSED_CAPTCHA" if shown else "INCONCLUSIVE",
            "reason": "results page" if shown else "final browser snapshots unavailable",
            "evidence_seen": "3 events listed" if shown else "",
            "confidence": "high" if shown else "low",
            "_model": "fake",
        }

    monkeypatch.setattr(probe_module, "_judge", snapshot_judge)
    assert probe_module.main(["--rejudge", str(path)]) == 0
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert (line["verdict"], line["confidence"], line["judge_input"]["observations"]) == ("PASSED_CAPTCHA", "high", 1)


def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


def test_assemble_builds_one_scorecard_run_context_from_lane_evidence(tmp_path):
    """--assemble: lanes' own runner lines, rejudges, transcripts and stack receipts -> one run context."""
    lane = tmp_path / "lanes" / "F"
    run_line = {"probe": "google-search", "verdict": "INCONCLUSIVE", "confidence": "low", "reason": "old judge",
                "agent_id": "ffb7cc3f-6073-446a-b32d-8ceae2b0f32d", "fe_link": "http://localhost:28121/?agent-id=ffb7cc3f",
                "duration_s": 1813.4}
    _write(lane / "results/google.log", "2026-10-22 [info] judge call\n" + json.dumps(run_line) + "\nEXIT=0\n")
    _write(lane / "regrades/google.log", "noise\n" + json.dumps(
        {"probe": "google-search", "verdict": "FAILED_CAPTCHA", "confidence": "high", "reason": "/sorry still blocking",
         "rejudged": True}) + "\n")
    _write(lane / "transcripts/google.json", {"probe": "google-search", "agent_id": run_line["agent_id"], "end_reason": "cap",
                                              "antibot": {}, "root_messages": [
                                                  {"role": "user", "text": "go", "timestamp": "2026-10-22T18:36:40Z"},
                                                  {"role": "assistant", "text": "done", "timestamp": "2026-10-22T19:06:50Z"}],
                                              "child_messages": []})
    _write(lane / "receipts/stack-f/local-stack-owner.json", {"token": "t"})
    _write(lane / "receipts/stack-f/local-stack-cleanup.status", "token=t\nstate=clean\n")
    _write(lane / "manifest.json", [{"probe": "google-search", "agent_id": run_line["agent_id"],
                                     "result_file": "results/google.log", "final_regrade_file": "regrades/google.log",
                                     "transcript_file": "transcripts/google.json", "source_sha": "stack b: 29ead6646 + copies",
                                     "stack_run_id": "stack-f"}])
    probes = {"google-search": {"name": "google-search", "hold": False},
              "uber-login": {"name": "uber-login", "hold": True},
              "bing-search": {"name": "bing-search", "hold": False}}
    run_dir = tmp_path / "round2"
    entries, stacks = probe_module.assemble_entries([str(lane / "manifest.json")], run_dir)
    probe_module.write_run_context(run_dir, entries, run_id="round2", probes=probes, stacks=stacks)

    card = json.loads((run_dir / "report-card.json").read_text())
    rows = {row["name"]: row for row in card["per_task"]}
    # The final verdict is the rejudge; agent, duration and FE link come from the run's own line.
    assert rows["google-search"]["status"] == "failed"
    assert rows["google-search"]["agent_id"] == run_line["agent_id"]
    assert rows["google-search"]["duration_s"] == 1813.4
    assert rows["google-search"]["agent_url"] == run_line["fe_link"]
    assert rows["uber-login"]["status"] == "skipped"  # held, never run
    assert rows["bing-search"]["status"] == "queued"  # no evidence: never invented
    assert card["tasks"]["total"] == 3
    assert card["source_sha"] is None  # a free-text source is not a recorded checkout sha
    assert card["started_at"] == 1792694200.0 and card["finished_at"] == 1792696010.0  # first and last message
    reasons = {task["name"]: task["failure_reason"] for task in json.loads((run_dir / "run.json").read_text())["tasks"]}
    assert reasons["google-search"] == "/sorry still blocking"
    assembled = json.loads((run_dir / "assembled-from.json").read_text())
    assert assembled["stacks"] == [{"lane": "F", "stack_run_id": "stack-f", "receipts": "sources/F/stack-f"}]
    assert (run_dir / "sources/F/stack-f/local-stack-cleanup.status").read_text() == "token=t\nstate=clean\n"


def test_assemble_accepts_a_manifest_with_entries(tmp_path):
    lane = tmp_path / "D"
    _write(lane / "r.json", json.dumps({"probe": "proton-signup", "verdict": "FAILED_CAPTCHA", "agent_id": "1abb9bc3", "duration_s": 841.0}))
    _write(lane / "manifest.json", {"entries": [{"probe": "proton-signup", "result_file": "r.json"}], "missing": []})
    entries, stacks = probe_module.assemble_entries([str(lane / "manifest.json")], tmp_path / "out")
    assert [(e["probe"], e["verdict"], e["agent_id"], e["provenance"]["lane"]) for e in entries] == [
        ("proton-signup", "FAILED_CAPTCHA", "1abb9bc3", "D")]
    assert stacks == []


def test_assemble_rejects_a_manifest_row_without_a_recorded_verdict(tmp_path):
    lane = tmp_path / "A2"
    _write(lane / "x.out", "no json here\n")
    _write(lane / "manifest.json", [{"probe": "hulu-the-pitt", "result_file": "x.out"}])
    with pytest.raises(ValueError, match="no recorded verdict line for hulu-the-pitt"):
        probe_module.assemble_entries([str(lane / "manifest.json")], tmp_path / "out")


def test_run_dir_keeps_the_latest_result_per_probe(tmp_path):
    probes = {"bing-search": {"name": "bing-search", "hold": False}}
    first = probe_module.probe_entry({"probe": "bing-search", "verdict": "FAILED_CAPTCHA", "agent_id": "a"}, started_at=1.0, finished_at=2.0)
    second = probe_module.probe_entry({"probe": "bing-search", "verdict": "PASSED_CAPTCHA", "agent_id": "b"}, started_at=3.0, finished_at=4.0)
    probe_module.write_run_context(tmp_path, [first, second], run_id="r", probes=probes)
    card = json.loads((tmp_path / "report-card.json").read_text())
    assert [(row["name"], row["status"], row["agent_id"]) for row in card["per_task"]] == [("bing-search", "passed", "b")]
    assert len((tmp_path / "results.jsonl").read_text().splitlines()) == 2  # every run kept; latest scored
    assert not (tmp_path / "assembled-from.json").exists()
