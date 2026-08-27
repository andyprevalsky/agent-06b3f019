"""Tests for collect_tree_messages — the lightweight per-agent tree-message
capture that lets the archive render a fan-out (root + every spawned sub-agent),
not just the root."""

import asyncio

from benchmarks.logs import canonicalize_agent_tree, collect_tree_messages, tree_child_transcript_count


def _run(coro):
    return asyncio.run(coro)


def _fake_get_agent(store):
    async def _get(agent_id):
        return store.get(agent_id, {})

    return _get


def test_collect_tree_messages_captures_every_agent():
    root = "root-1"
    tree_agents = [
        {"agent_id": root, "parent_agent_id": None, "goal": "fan out", "status": "FAILED"},
        {"agent_id": "child-a", "parent_agent_id": root, "goal": "research A", "status": "COMPLETED"},
        {"agent_id": "child-b", "parent_agent_id": root, "goal": "research B", "status": "COMPLETED"},
    ]
    store = {
        root: {"messages": [{"role": "USER", "text": "fan out and research", "timestamp": "t0"}]},
        "child-a": {"messages": [{"role": "ASSISTANT", "text": "A done", "timestamp": "t1"}]},
        "child-b": {
            "messages": [
                {"role": "ASSISTANT", "text": "B1", "timestamp": "t2"},
                {"role": "ASSISTANT", "text": "B2", "timestamp": "t3"},
            ]
        },
    }
    tree = _run(collect_tree_messages(root, tree_agents, _fake_get_agent(store)))

    assert set(tree.keys()) == {root, "child-a", "child-b"}
    assert tree[root]["parent_agent_id"] is None
    assert tree["child-a"]["parent_agent_id"] == root
    assert tree["child-a"]["goal"] == "research A"
    assert tree["child-a"]["status"] == "COMPLETED"
    assert [m["message"] for m in tree["child-b"]["messages"]] == ["B1", "B2"]


def test_collect_tree_messages_skips_blank_ids():
    tree_agents = [
        {"agent_id": "", "parent_agent_id": None},
        {"agent_id": "real", "parent_agent_id": None, "goal": "g", "status": "COMPLETED"},
    ]
    tree = _run(collect_tree_messages("real", tree_agents, _fake_get_agent({"real": {"messages": []}})))
    assert set(tree.keys()) == {"real"}


def test_collect_tree_messages_tolerates_fetch_failure():
    # A per-agent fetch that raises must NOT drop the agent — it appears with an
    # empty transcript (best-effort), and never fails the whole capture.
    async def _boom(agent_id):
        raise RuntimeError("box unreachable")

    tree_agents = [{"agent_id": "x", "parent_agent_id": None, "goal": "g", "status": "ACTIVE"}]
    tree = _run(collect_tree_messages("x", tree_agents, _boom))
    assert tree["x"]["messages"] == []
    assert tree["x"]["status"] == "ACTIVE"


def test_canonicalize_agent_tree_drops_tool_usage_rollup():
    tree = canonicalize_agent_tree(
        {
            "root_agent_id": "root-1",
            "agent_count": 54,
            "tool_usage_count": 9,
            "llm_call_count": 4,
            "tokens_in": 1,
            "child-a": {
                "parent_agent_id": "root-1",
                "goal": "research A",
                "status": "COMPLETED",
                "messages": [{"role": "ASSISTANT", "message": "A done"}],
            },
        }
    )
    assert set(tree.keys()) == {"child-a"}
    assert tree_child_transcript_count(tree, "root-1") == 1
    assert canonicalize_agent_tree({"agent_count": 2, "tool_usage_count": 1}) == {}
    assert tree_child_transcript_count({"agent_count": 2}, "root-1") == 0


def test_collect_tree_messages_status_falls_back_to_agent_obj():
    # When the tree row omits status, fall back to the fetched agent's status.
    tree_agents = [{"agent_id": "x", "parent_agent_id": None, "goal": "g"}]
    store = {"x": {"agent": {"status": "FINISHED"}, "messages": []}}
    tree = _run(collect_tree_messages("x", tree_agents, _fake_get_agent(store)))
    assert tree["x"]["status"] == "FINISHED"


def test_collect_tree_messages_copies_response_schema_and_structured_output():
    tree_agents = [{"agent_id": "root-1", "parent_agent_id": None, "goal": "g", "status": "COMPLETED"}]
    store = {
        "root-1": {
            "agent": {
                "status": "COMPLETED",
                "response_schema": {"fields": [{"name": "positioning_statement", "type": "str"}]},
                "structured_output": {"positioning_statement": "Engineer approach"},
                "tokens_out": 29515,
                "context_size": 185193,
            },
            "messages": [{"role": "ASSISTANT", "text": "done", "timestamp": "t0"}],
        }
    }
    tree = _run(collect_tree_messages("root-1", tree_agents, _fake_get_agent(store)))
    assert tree["root-1"]["response_schema"]["fields"][0]["name"] == "positioning_statement"
    assert tree["root-1"]["structured_output"]["positioning_statement"] == "Engineer approach"
    assert tree["root-1"]["tokens_out"] == 29515
    assert tree["root-1"]["context_size"] == 185193


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
