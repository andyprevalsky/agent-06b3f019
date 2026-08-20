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
    # Slot models track POOL_REGISTRY. anthropic/claude-opus-4.8 and
    # openai/gpt-5.6-terra used to stand in here; both left the waterfalls when
    # rose-1-ultra/browser-use moved to gpt-5.6-sol -> kimi-k3, so a model that
    # is merely *a* pool's direct-auth choice no longer classifies as a slot.
    assert classify_model("openai/gpt-5.6-sol")[0] == "openrouter_model_1"
    assert classify_model("google/gemini-3.6-flash")[0] == "openrouter_model_1"
    assert classify_model("google/gemini-3-flash-preview")[0] == "openrouter_model_2"
    # kimi-k3 sits at slot 1 for lite/ultra/browser-use but slot 0 for the
    # single-layer rose-1-oss pool; the earliest matching slot wins.
    assert classify_model("moonshotai/kimi-k3")[0] == "openrouter_model_1"
    # Regression: rose-1-oss pins ONE open-weights layer, so slot 1 does not
    # exist for it. classify_model indexed every pool's waterfall unguarded and
    # raised IndexError as soon as a model reached the slot-1 pass without
    # matching an earlier pool -- `any()` short-circuiting on a longer pool had
    # been masking it, making the crash depend on registry ordering.
    assert classify_model("anthropic/claude-opus-4.8") == (
        "unclassified",
        "anthropic/claude-opus-4.8",
    )
    assert classify_model("openai/gpt-5.6-terra") == (
        "unclassified",
        "openai/gpt-5.6-terra",
    )
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
    assert classify_usage_item(
        {"model": "gpt-5.6-sol-gpt", "provider": "Rose 1 Browser Use"}
    ) == ("codex_token", "gpt-5.6-sol")
    # AgentWorkflow._track_usage fills a browser usage item's absent transport
    # model from the parent agent alias before persisting it. Provider identity
    # remains authoritative for the browser pool in this production shape.
    assert classify_usage_item(
        {
            "model": "rose-labs/rose-1-ultra",
            "provider": "Rose 1 Browser Use",
        }
    ) == ("claude_oauth_token", "claude-fable-5")


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
            # A current slot-0 waterfall model. Was anthropic/claude-opus-4.8
            # until rose-1-ultra/browser-use dropped the Anthropic layer.
            "type": "llm",
            "model": "openai/gpt-5.6-sol",
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
