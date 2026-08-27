"""Owning-boundary tests for the OAi demo smoke rubric."""

from benchmarks.oai_demo_rubric import grade_oai_demo_rubric


def _gp_node(parent: str, creator: str, *, stub: bool = False) -> dict:
    if stub:
        messages = [
            {"role": "ASSISTANT", "message": "starting", "metadata": {}},
            {
                "role": "TOOL",
                "message": "Fast Mode cache trajectory ended; the task completed successfully based on prior tool evidence",
                "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"},
            },
        ]
        return {"parent_agent_id": parent, "goal": f"Creator: {creator}.", "status": "COMPLETED", "messages": messages}
    messages = [
        {"role": "ASSISTANT", "message": "research", "metadata": {}},
        {
            "role": "TOOL",
            "message": f"{creator} cadence",
            "metadata": {"toolName": "spawn_agent", "toolStatus": "FINISHED", "agentType": "explore"},
        },
        {
            "role": "TOOL",
            "message": "web",
            "metadata": {
                "toolName": "web_search",
                "toolStatus": "FINISHED",
                "usage": {"from_fast_cache": True},
            },
        },
        {
            "role": "TOOL",
            "message": "Fast Mode cache trajectory ended; prior tool evidence is sufficient to treat the goal as complete.",
            "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"},
        },
    ]
    return {
        "parent_agent_id": parent,
        "goal": f"You are analyzing ONE creator for Andy Prevalsky. Creator: {creator}.",
        "status": "COMPLETED",
        "messages": messages,
        "response_schema": {"fields": [{"name": "creator_name", "type": "str"}]},
        "structured_output": {"creator_name": creator},
    }


def _explore_node(parent: str, creator: str) -> dict:
    return {
        "parent_agent_id": parent,
        "goal": f"Research {creator} last 90 days",
        "status": "COMPLETED",
        "messages": [
            {"role": "ASSISTANT", "message": "search", "metadata": {}},
            {
                "role": "TOOL",
                "message": f"{creator} hits",
                "metadata": {"toolName": "web_search", "toolStatus": "FINISHED", "usage": {"from_fast_cache": True}},
            },
            {"role": "TOOL", "message": "page", "metadata": {"toolName": "web_fetch", "toolStatus": "FINISHED"}},
            {"role": "TOOL", "message": "done", "metadata": {"toolName": "attempt_completion", "toolStatus": "FINISHED"}},
        ],
    }


def _passing_tree() -> dict:
    from domains.spawn_agent.oai_demo_july import JULY_FOR_EACH_ITEMS

    tree = {
        "root": {
            "parent_agent_id": None,
            "goal": "I'm building a personal brand for Andy Prevalsky",  # pragma: allowlist secret
            "status": "COMPLETED",
            "messages": [
                {
                    "role": "TOOL",
                    "message": (
                        "Positioning statement for Andy's brand. 90-day calendar. "
                        "30 hooks. Weekly engage list. "
                        + ", ".join(item["name"] for item in JULY_FOR_EACH_ITEMS)
                    ),
                    "metadata": {"toolName": "attempt_completion", "action_type": "task_complete"},
                }
            ],
            "response_schema": {
                "fields": [
                    {"name": "positioning_statement", "type": "str"},
                    {"name": "content_calendar", "type": "str"},
                ]
            },
            "structured_output": {
                "positioning_statement": "Andy Prevalsky at health x longevity",
                "content_calendar": "90-day calendar",
            },
        }
    }
    for index, item in enumerate(JULY_FOR_EACH_ITEMS, start=1):
        gp_id = f"gp-{index}"
        explore_id = f"ex-{index}"
        tree[gp_id] = _gp_node("root", item["name"])
        tree[explore_id] = _explore_node(gp_id, item["name"])
    return tree


def test_oai_demo_rubric_passes_full_july_tree():
    tree = _passing_tree()
    data = {
        "agent": {
            "id": "root",
            "status": "COMPLETED",
            "response_schema": tree["root"]["response_schema"],
            "structured_output": tree["root"]["structured_output"],
        },
        "_benchmark": {"tree": tree, "all_agents": [{"agent_id": "root", "status": "COMPLETED"}]},
    }
    passed, reason = grade_oai_demo_rubric(data)
    assert passed, reason
    assert "T1" in reason and "PASS" in reason


def test_oai_demo_rubric_fails_stub_gp():
    tree = _passing_tree()
    tree["gp-25"] = _gp_node("root", "Sahil Bloom", stub=True)
    data = {
        "agent": {"id": "root", "status": "COMPLETED"},
        "_benchmark": {"tree": tree, "all_agents": []},
    }
    passed, reason = grade_oai_demo_rubric(data)
    assert not passed
    assert "T4 FAIL" in reason
    assert "T5 FAIL" in reason


def test_oai_demo_rubric_fails_live_spend_and_non_cache_tokens():
    """T5 fails closed on any live dollars or tokens that did not come from Fast Mode."""
    tree = _passing_tree()
    paid = {
        "agent": {
            "id": "root",
            "status": "COMPLETED",
            "response_schema": tree["root"]["response_schema"],
            "structured_output": tree["root"]["structured_output"],
        },
        "_benchmark": {
            "tree": tree,
            "all_agents": [],
            "usage": {"cost_cents": 19, "cache_creation_input_tokens": 0},
        },
    }
    passed, reason = grade_oai_demo_rubric(paid)
    assert not passed
    assert "T5 FAIL" in reason
    assert "$0" in reason

    live = {
        "agent": {
            "id": "root",
            "status": "COMPLETED",
            "response_schema": tree["root"]["response_schema"],
            "structured_output": tree["root"]["structured_output"],
        },
        "_benchmark": {"tree": tree, "all_agents": []},
    }
    live["_benchmark"]["tree"]["gp-1"]["messages"][2]["metadata"]["usage"] = {
        "from_fast_cache": False,
        "prompt_tokens": 80,
        "completion_tokens": 12,
    }
    passed, reason = grade_oai_demo_rubric(live)
    assert not passed
    assert "T5 FAIL" in reason
    assert "non-fast-cache" in reason


def test_oai_demo_rubric_fails_aman_and_empty_schema():
    tree = _passing_tree()
    tree["root"]["messages"][0]["message"] = "Aman Gottumukkala notes"
    tree["root"]["response_schema"] = None
    tree["root"]["structured_output"] = None
    data = {
        "agent": {"id": "root", "status": "COMPLETED"},
        "_benchmark": {"tree": tree, "all_agents": []},
    }
    passed, reason = grade_oai_demo_rubric(data)
    assert not passed
    assert "T1 FAIL" in reason
    assert "T9 FAIL" in reason
