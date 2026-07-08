import json

from benchmarks.archive_api import load_archive


def test_load_archive_maps_benchmark_run_to_agent_detail(tmp_path):
    run_path = tmp_path / "run.json"
    run_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-07-07T23:00:00+00:00",
                "tasks": [
                    {
                        "name": "chat-mode",
                        "passed": True,
                        "agent_id": "agent-1",
                        "duration_seconds": 12.5,
                        "cost_cents": 3.0,
                        "progress_score": 1,
                        "fast_mode_cache_enabled": False,
                        "world_model_mode": "simulate",
                        "logs": {
                            "messages": [
                                {
                                    "role": "USER",
                                    "message": "hello",
                                    "created_at": "2026-07-07T23:00:01Z",
                                },
                                {
                                    "role": "ASSISTANT",
                                    "message": "hi",
                                    "created_at": "2026-07-07T23:00:02Z",
                                    "metadata": {"title": "response"},
                                },
                            ]
                        },
                    }
                ],
            }
        )
    )

    archive = load_archive(run_path)
    entry = archive["agent-1"]

    assert entry.agent["agent_id"] == "agent-1"
    assert entry.agent["status"] == "COMPLETED"
    assert entry.agent["goal"] == "hello"
    assert entry.agent["temporal_workflow_id"] == "benchmark-archive-agent-1"
    assert entry.messages == [
        {
            "message_id": "agent-1-archive-message-0000",
            "timestamp": "2026-07-07T23:00:01Z",
            "text": "hello",
            "role": "USER",
            "metadata": {},
            "file_pointer": None,
        },
        {
            "message_id": "agent-1-archive-message-0001",
            "timestamp": "2026-07-07T23:00:02Z",
            "text": "hi",
            "role": "ASSISTANT",
            "metadata": {"title": "response"},
            "file_pointer": None,
        },
    ]

