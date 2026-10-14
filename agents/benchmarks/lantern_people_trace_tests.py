"""Owning benchmark regressions using the real people-search message formatter."""

from copy import deepcopy

from benchmarks.run_benchmark import _run_declared_static_check
from tools.base import format_tool_message
from tools.people_search.service import _normalize_person


def _person(index):
    return _normalize_person(
        {
            "name": f"Engineer {index}",
            "linkedinUrl": f"https://example.test/profiles/{index}",
            "title": "Software Engineer",
            "company": "Example",
            "sourceRecordId": f"co:source-{index}",
            "sourceRetrievedAt": "2026-10-14T00:00:00Z",
        },
        None,
    )


def _tool(params, people, call_id, generation="co:index-v2", cursor=None):
    result = {
        "query": params["query"],
        "mode_used": params["mode"],
        "provider_used": "lantern",
        "providers_attempted": ["lantern"],
        "results": people,
        "generation": generation,
        "warnings": [],
    }
    if cursor:
        result["next_cursor"] = cursor
    return {
        "role": "TOOL",
        "timestamp": f"2026-10-14T00:00:{call_id:02d}Z",
        "message": format_tool_message(params, result, 0.1, 0),
        "metadata": {
            "toolName": "people_search",
            "toolStatus": "FINISHED",
            "toolCallId": f"call-{call_id}",
            "subAgentId": "explore-1",
            "taskId": "explore-1",
            "agentType": "explore",
        },
    }


def _final(people, generation="co:index-v2"):
    rows = [
        {
            "name": p["name"],
            "profile_url": p["profile_url"],
            "current_title": p.get("title"),
            "current_company": p.get("company"),
            "source_record_id": p["source"]["record_id"],
            "retrieved_at": p["source"]["retrieved_at"],
            "generation": generation,
        }
        for p in people
    ]
    return {
        "role": "TOOL",
        "timestamp": "2026-10-14T00:01:00Z",
        "metadata": {
            "toolName": "completion_summary",
            "toolStatus": "FINISHED",
            "toolCallId": "complete",
            "isFinalSummary": True,
            "completionSummary": {"outputs": [{"key": "people", "value": rows}]},
        },
    }


def _fixture(scenario):
    params = {
        "tool": "people_search",
        "query": "engineer",
        "mode": "discover",
        "provider": "lantern",
        "titles": ["Software Engineer"],
        "limit": 5,
        "cursor": None,
    }
    check = {
        "type": "lantern_people_trace",
        "scenario": scenario,
        "query": "engineer",
        "min_records": 5,
        "required_titles": ["Software Engineer"],
        "page_size": 5,
    }
    people = [_person(i) for i in range(5)]
    if scenario == "discovery":
        tools = [_tool(params, [], 1), _tool(params, people, 2)]
    elif scenario == "enrichment":
        check = {
            "type": "lantern_people_trace",
            "scenario": scenario,
            "query": "engineer",
            "min_records": 1,
            "page_size": 1,
            "required_titles": ["Software Engineer"],
            "required_fields": ["current_title", "current_company", "linkedin_url"],
        }
        params["limit"] = 1
        prior = [_person(0)]
        people = deepcopy(prior)
        people[0].update(title="Senior Software Engineer", company="Fresh Company")
        people[0]["source"]["retrieved_at"] = "2026-10-14T00:00:02Z"
        people[0]["profile"].update(
            title=people[0]["title"],
            company=people[0]["company"],
            sourceRetrievedAt=people[0]["source"]["retrieved_at"],
        )
        people[0]["attributes"] = {
            "current_title": people[0]["title"],
            "current_company": people[0]["company"],
            "linkedin_url": people[0]["profile_url"],
        }
        enrich = {
            "query": "engineer",
            "mode": "enrich",
            "provider": "lantern",
            "source_record_id": prior[0]["source"]["record_id"],
            "generation": "co:index-v2",
            "fields": check["required_fields"],
        }
        tools = [_tool(params, prior, 1), _tool(enrich, people, 2)]
    else:
        check.update(min_records=4, page_size=2)
        params["limit"] = 2
        people = people[:4]
        tools = [
            _tool(params, people[:2], 1, cursor="native-cursor-2"),
            _tool({**params, "cursor": "native-cursor-2"}, people[2:], 2),
        ]
    final = _final(people)
    # Native tree evidence only; parent-visible duplicates must not double count.
    spawn = {
        "role": "TOOL",
        "timestamp": "2026-10-14T00:00:50Z",
        "metadata": {
            "toolName": "spawn_agent",
            "toolStatus": "FINISHED",
            "toolCallId": "spawn-1",
            "taskId": "explore-1",
            "agentType": "explore",
        },
    }
    data = {
        "messages": [spawn, final],
        "_benchmark": {"tree": {"root": {"messages": [spawn, final]}, "explore": {"messages": tools}}},
    }
    return check, data, tools, people


def _run(check, data):
    return _run_declared_static_check({"checks": [check]}, data)


def _rewrite(row, change_params=None, change_result=None):
    from benchmarks.lantern_people_trace import _formatted

    params, result = _formatted(row)
    if change_params:
        change_params(params)
    if change_result:
        change_result(result)
    row["message"] = format_tool_message(params, result, 0.1, 0)


def test_lantern_native_scenarios_and_final_grounding():
    for scenario in ("discovery", "enrichment", "pagination"):
        check, data, tools, _ = _fixture(scenario)
        assert _run(check, data)[0], _run(check, data)
        data["messages"] = tools + data["messages"]
        assert _run(check, data)[0], "duplicate hydrated evidence must not count twice"
        for field in (
            "name",
            "profile_url",
            "current_title",
            "current_company",
            "source_record_id",
            "retrieved_at",
            "generation",
        ):
            bad = deepcopy(data)
            final = bad["messages"][-1]["metadata"]["completionSummary"]["outputs"][0]["value"]
            final[0][field] = "fabricated"
            assert not _run(check, bad)[0], (scenario, field)
        for role in ("USER", "ASSISTANT"):
            bad = deepcopy(data)
            for node in bad["_benchmark"]["tree"].values():
                for row in node["messages"]:
                    row["role"] = role
            for row in bad["messages"]:
                row["role"] = role
            assert not _run(check, bad)[0], "narration is not tool evidence"
        bad = deepcopy(data)
        bad["messages"].append({"role": "TOOL", "metadata": {"toolName": "web_search", "toolStatus": "ERROR"}})
        assert not _run(check, bad)[0], "forbidden web attempts fail even after native success"


def test_lantern_discovery_constraint_and_provenance_rejections():
    for mutation in (
        lambda p: p.update(titles=None),
        lambda p: p.update(titles=["Founder"]),
        lambda p: p.update(query="founder"),
        lambda p: p.update(limit=25),
    ):
        check, data, tools, _ = _fixture("discovery")
        _rewrite(tools[-1], mutation)
        assert not _run(check, data)[0]
    for mutate in (
        lambda r: r.update(provider_used="exa"),
        lambda r: r.pop("generation"),
        lambda r: r["results"][0]["source"].pop("record_id"),
        lambda r: r["results"][0]["source"].pop("retrieved_at"),
        lambda r: r["results"].append(deepcopy(r["results"][0])),
    ):
        check, data, tools, _ = _fixture("discovery")
        _rewrite(tools[-1], change_result=mutate)
        assert not _run(check, data)[0]
    check, data, tools, _ = _fixture("discovery")
    tools[-1]["message"] = "Narration claiming five Lantern engineers"
    assert not _run(check, data)[0]


def test_lantern_enrichment_requires_native_lineage_and_fresh_values():
    for mutate in (
        lambda p: p.update(source_record_id="https://example.test/fabricated"),
        lambda p: p.update(generation="other-generation"),
        lambda p: p.update(fields=[]),
    ):
        check, data, tools, _ = _fixture("enrichment")
        _rewrite(tools[-1], change_params=mutate)
        assert not _run(check, data)[0]
    for mutate in (
        lambda r: r.update(results=[]),
        lambda r: r.update(generation="other-generation"),
        lambda r: r["results"][0]["attributes"].update(current_title="fabricated"),
        lambda r: r["results"].append(deepcopy(r["results"][0])),
    ):
        check, data, tools, _ = _fixture("enrichment")
        _rewrite(tools[-1], change_result=mutate)
        assert not _run(check, data)[0]
    check, data, tools, _ = _fixture("enrichment")
    tools[0]["timestamp"], tools[1]["timestamp"] = tools[1]["timestamp"], tools[0]["timestamp"]
    assert not _run(check, data)[0], "discovery must precede enrichment"
    check, data, _, _ = _fixture("enrichment")
    data["messages"][-1]["metadata"]["completionSummary"]["outputs"][0]["value"][0]["current_company"] = "Example"
    assert not _run(check, data)[0], "old discovery values cannot replace fresh enrichment"


def test_lantern_pagination_requires_exact_native_cursor_and_constraints():
    for mutate in (
        lambda p: p.update(cursor="guessed"),
        lambda p: p.update(query="other-query"),
        lambda p: p.update(titles=["Founder"]),
        lambda p: p.update(limit=3),
        lambda p: p.update(location="another place"),
    ):
        check, data, tools, _ = _fixture("pagination")
        _rewrite(tools[-1], change_params=mutate)
        assert not _run(check, data)[0]
    for mutate in (
        lambda r: r.update(generation="other-generation"),
        lambda r: r["results"][0]["source"].update(record_id="co:source-0"),
        lambda r: r.update(results=r["results"][:1]),
    ):
        check, data, tools, _ = _fixture("pagination")
        _rewrite(tools[-1], change_result=mutate)
        assert not _run(check, data)[0]


def test_lantern_config_missing_final_and_null_native_fields():
    check, data, tools, people = _fixture("discovery")
    for bad in (
        {},
        {**check, "scenario": "other"},
        {**check, "min_records": True},
        {**check, "required_titles": "Software Engineer"},
        {**check, "page_size": 0},
    ):
        assert not _run(bad, data)[0]
    assert not _run(check, {"messages": []})[0]
    people[0].update(title=None, company=None)
    people[0]["profile"].update(title=None, company=None)
    _rewrite(tools[-1], change_result=lambda r: r.update(results=people))
    data["messages"][-1] = _final(people)
    assert _run(check, data)[0], "unavailable native title/company remain null"


def test_lantern_reviewer_owner_constraint_and_native_counterexamples():
    for scenario in ("discovery", "enrichment", "pagination"):
        check, data, tools, _ = _fixture(scenario)
        _rewrite(tools[0 if scenario == "enrichment" else -1], change_params=lambda p: p.update(limit=25))
        assert not _run(check, data)[0], (scenario, "wrong limit")
        check, data, tools, _ = _fixture(scenario)
        _rewrite(tools[0 if scenario == "enrichment" else -1], change_params=lambda p: p.update(titles=None))
        assert not _run(check, data)[0], (scenario, "missing titles")
        check, data, tools, _ = _fixture(scenario)
        data["messages"] = data["messages"][-1:]
        data["_benchmark"]["tree"].pop("root")
        assert not _run(check, data)[0], "standalone rows lack real explore attribution"
        for changed in ("world_model_simulated", "providers_attempted", "profile"):
            check, data, tools, _ = _fixture(scenario)
            if changed == "world_model_simulated":
                _rewrite(tools[-1], change_result=lambda r: r.update(world_model_simulated=True))
            elif changed == "providers_attempted":
                _rewrite(tools[-1], change_result=lambda r: r.update(providers_attempted=[]))
            else:
                _rewrite(
                    tools[-1],
                    change_result=lambda r: r["results"][0]["profile"].update(sourceRecordId="another-native-id"),
                )
            assert not _run(check, data)[0], (scenario, changed)
    check, data, tools, people = _fixture("enrichment")
    people[0].update(title=None, company=None)
    people[0]["profile"].update(title=None, company=None)
    people[0]["attributes"].update(current_title=None, current_company=None)
    _rewrite(tools[-1], change_result=lambda r: r.update(results=people))
    data["messages"][-1] = _final(people)
    assert _run(check, data)[0], "honest nullable fresh enrichment values are supported"
    check, data, tools, _ = _fixture("discovery")
    _rewrite(tools[-1], change_result=lambda r: r["results"][0]["source"].update(retrieved_at="2026-10-14T00:00:00"))
    assert not _run(check, data)[0], "naive provenance timestamp rejected"


def test_lantern_latest_completion_and_cache_evidence_are_strict():
    for outputs in (
        [],
        [{"key": "other", "value": []}],
        [{"key": "people", "value": "invented"}],
        [{"key": "people", "value": []}],
    ):
        check, data, _, _ = _fixture("discovery")
        later = deepcopy(data["messages"][-1])
        later["metadata"]["completionSummary"]["outputs"] = outputs
        data["messages"].append(later)
        assert not _run(check, data)[0], "latest canonical completion must win"
    for marker in ("_fast_cache_hit", "from_fast_cache"):
        check, data, tools, _ = _fixture("discovery")
        _rewrite(tools[-1], change_result=lambda r: r.update({marker: True}))
        assert not _run(check, data)[0], "cached result does not prove native LIVE research"
    check, data, _, people = _fixture("discovery")
    attempt = _final(people)
    attempt["metadata"] = {
        "toolName": "attempt_completion",
        "toolStatus": "FINISHED",
        "structured_response": {"people": attempt["metadata"]["completionSummary"]["outputs"][0]["value"]},
    }
    data["messages"][-1]["metadata"]["completionSummary"]["outputs"] = []
    data["messages"].append(attempt)
    assert not _run(check, data)[0], "arbitrary attempt output cannot override final root card"
    check, data, tools, people = _fixture("discovery")
    params = {
        "query": "engineer",
        "mode": "discover",
        "provider": "lantern",
        "titles": ["Software Engineer"],
        "limit": 5,
    }
    data["_benchmark"]["tree"]["explore"]["messages"] = [_tool(params, people[:3], 1), _tool(params, people[3:], 2)]
    assert not _run(check, data)[0], "partial discoveries cannot be stitched into one successful five-person response"
    check, data, _, _ = _fixture("discovery")
    data["messages"][0]["timestamp"] = "2026-10-14T00:02:00Z"
    assert not _run(check, data)[0], "explore proof cannot be borrowed from after final completion"
    check, data, _, _ = _fixture("discovery")
    later = deepcopy(data["messages"][-1])
    later["metadata"].update(toolStatus="ERROR")
    data["messages"].append(later)
    assert not _run(check, data)[0], "latest failed canonical final supersedes older success"
    check, data, _, _ = _fixture("discovery")
    final = data["messages"][-1]
    final["metadata"] = {
        "toolName": "attempt_completion",
        "toolStatus": "FINISHED",
        "structured_response": {"people": final["metadata"]["completionSummary"]["outputs"][0]["value"]},
    }
    assert not _run(check, data)[0], "a completed verifier attempt is not the authoritative final"
