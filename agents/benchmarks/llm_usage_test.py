from benchmarks.llm_usage import (
    aggregate_usage_items,
    classify_model,
    classify_usage_item,
    merge_usage_breakdowns,
)


def test_classifies_every_required_auth_path_and_openrouter_slot() -> None:
    assert classify_model("gpt-5.6-sol-gpt") == ("codex_token", "gpt-5.6-sol")
    assert classify_model("claude-sonnet-5-claude") == (
        "claude_oauth_token",
        "claude-sonnet-5",
    )
    assert classify_model("gpt-5.6-terra-openai") == ("gpt_api_key", "gpt-5.6-terra")
    assert classify_model("claude-fable-5-anthropic") == (
        "anthropic_api_key",
        "claude-fable-5",
    )
    assert classify_model("anthropic/claude-opus-4.8")[0] == "openrouter_model_1"
    assert classify_model("google/gemini-3.1-pro-preview")[0] == "openrouter_model_2"
    assert classify_usage_item(
        {
            "model": "rose-labs/rose-1-ultra",
            "provider": "Verifier (rose-labs/rose-1-ultra)",
        }
    ) == ("claude_oauth_token", "claude-fable-5")
    assert classify_usage_item({"model": None, "provider": "Rose 1 Browser Use"}) == (
        "claude_oauth_token",
        "claude-fable-5",
    )


def test_aggregates_calls_tokens_cost_by_provider_and_submodel() -> None:
    items = [
        {
            "type": "llm",
            "model": "gpt-5.6-sol-gpt",
            "tokens_in": 10,
            "cache_read_input_tokens": 5,
            "cache_creation_input_tokens": 2,
            "tokens_out": 3,
            "cost_cents": 0,
        },
        {
            "type": "llm",
            "model": "gpt-5.6-sol-gpt",
            "tokens_in": 20,
            "tokens_out": 4,
            "cost_cents": 0,
        },
        {
            "type": "llm",
            "model": "anthropic/claude-opus-4.8",
            "tokens_in": 100,
            "tokens_out": 10,
            "cost_cents": 12.5,
        },
        {"type": "service", "provider": "Perplexity", "cost_cents": 99},
    ]
    first = aggregate_usage_items(items)
    codex = first["codex_token"]
    assert codex == {
        "calls": 2,
        "input_tokens": 37,
        "output_tokens": 7,
        "cost_usd": 0.0,
        "models": {
            "gpt-5.6-sol": {
                "calls": 2,
                "input_tokens": 37,
                "output_tokens": 7,
                "cost_usd": 0.0,
            }
        },
    }
    merged = merge_usage_breakdowns([first, first])
    assert merged["openrouter_model_1"]["calls"] == 2
    assert merged["openrouter_model_1"]["cost_usd"] == 0.25
    assert list(merged) == [
        "codex_token",
        "claude_oauth_token",
        "gpt_api_key",
        "anthropic_api_key",
        "openrouter_model_1",
        "openrouter_model_2",
    ]
    assert merged["openrouter_model_2"] == {
        "calls": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "models": {},
    }
    assert "perplexity" not in merged
