"""Usage billing shared by AgentWorkflow and the resume workflows (moved verbatim from AgentWorkflow).

``_track_usage`` is THE single point where a workflow's tool / LLM usage is
priced, added to ``own_cost_cents``, written to ToolUsage and pushed into the
cost path (``_update_cost_and_signal_parent``, which each workflow defines: the
agent tree's relay + root limit for AgentWorkflow, the owner's limit for a
resume run). Host attributes: agent_id, user_id, model, input/output_cents_per_1k,
model_pricing_cache, own_cost_cents, children_cost_cents, subtree_cost_cents,
is_paused, _cost_limit_reached, _pause_signal_sequence, and the methods
_update_cost_and_signal_parent, _maybe_arm_cost_limit_wrapup_after_browser,
_usage_checkpoint.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Dict, Optional

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from helpers.model_pricing import get_default_pricing
    from helpers.save_tool_usage import save_tool_usage
    from providers.rose.pricing import get_model_pricing as get_in_process_model_pricing


class UsageTrackingMixin:
    async def _track_usage(
        self,
        usage: Optional[Dict] = None,
        tool_name: Optional[str] = None,
        call_site: Optional[str] = None,
        browser_completed: bool = False,
    ) -> None:
        """
        Track usage from any activity result.

        This is THE SINGLE POINT where all costs are:
        1. Calculated (LLM tokens → cost via pricing)
        2. Added to own_cost_cents
        3. Written to ToolUsage table (if tool_name provided)
        4. Signaled to parent for hierarchical relay

        Args:
            usage: Dict with "llm" and/or "service" lists
            tool_name: Tool name for ToolUsage table (optional for internal LLM calls)
            call_site: Label identifying the LLM call source (e.g., planner, explore_agent, browser_agent).
                       Falls back to tool_name if not provided.
        """
        if not usage:
            return

        paused_before = self.is_paused
        cost_limit_before = self._cost_limit_reached
        pause_sequence_before = self._pause_signal_sequence

        total_cost_cents = 0
        usage_items_for_db = []

        # Process LLM usage items
        for llm in usage.get("llm", []):
            tokens_in = llm.get("tokens_in", 0)
            tokens_out = llm.get("tokens_out", 0)
            model = llm.get("model") or self.model
            provider = llm.get("provider") or model
            effective_call_site = call_site or tool_name or "unknown"
            cache_read = llm.get("cache_read_input_tokens", 0)
            cache_write = llm.get("cache_creation_input_tokens", 0)
            cache_sequence_id = llm.get("cache_sequence_id")
            from_fast_cache = bool(llm.get("from_fast_cache"))

            if from_fast_cache:
                workflow.logger.info(
                    f"💰 $0 cost (fast cache replay): actual_model={model}, "
                    f"in={tokens_in}, out={tokens_out}, cache_read={cache_read}, call_site={effective_call_site}"
                )
                usage_items_for_db.append(
                    {
                        "type": "llm",
                        "cost_cents": 0,
                        "call_site": effective_call_site,
                        "provider": provider,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": model,
                        "cache_read_input_tokens": cache_read,
                        "cache_creation_input_tokens": cache_write,
                        "from_fast_cache": True,
                        **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
                    }
                )
                continue

            # own_cost_cents and price_limit_cents are the user's charge ledger.
            # Foundry's separate Azure bill is monitored through Azure billing;
            # it must not consume a user's $0 compute-token limit.
            if isinstance(model, str) and model.endswith(("-claude", "-gpt", "-foundry")):
                workflow.logger.info(
                    f"💰 $0 user charge: actual_model={model}, "
                    f"in={tokens_in}, out={tokens_out}, call_site={effective_call_site}"
                )
                usage_items_for_db.append(
                    {
                        "type": "llm",
                        "cost_cents": 0,
                        "call_site": effective_call_site,
                        "provider": provider,
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "model": model,
                        "cache_read_input_tokens": cache_read,
                        "cache_creation_input_tokens": cache_write,
                        **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
                    }
                )
                continue

            # Get pricing for this model (fetch if not cached)
            pricing = await self._get_model_pricing(model)
            if not pricing:
                workflow.logger.warning(
                    f"⚠️ No pricing for model {model}, skipping cost for {tokens_in}/{tokens_out} tokens"
                )
                continue

            input_rate = pricing["input_cents_per_1k"]
            output_rate = pricing["output_cents_per_1k"]

            # Apply provider-specific cache discounts if cache fields present
            is_anthropic = model and ("claude" in model.lower() or model.lower().endswith("-claude"))
            cache_read_mult = 0.1 if is_anthropic else 0.25
            cache_write_mult = 1.25 if is_anthropic else 1.0

            cost_cents = (
                (tokens_in * input_rate / 1000)
                + (cache_read * input_rate * cache_read_mult / 1000)
                + (cache_write * input_rate * cache_write_mult / 1000)
                + (tokens_out * output_rate / 1000)
            )
            usage_item = {
                "type": "llm",
                "cost_cents": cost_cents,
                "call_site": effective_call_site,
                "provider": provider,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "model": model,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
                **({"cache_sequence_id": cache_sequence_id} if cache_sequence_id else {}),
            }
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(
                    f"💰 LLM cost: +{cost_cents:.2f}c ({provider}, in={tokens_in}, out={tokens_out}, call_site={effective_call_site})"
                )
                usage_items_for_db.append(usage_item)

        # Process service usage items (pre-calculated costs)
        for svc in usage.get("service", []):
            cost_cents = svc.get("cost_cents", 0)
            provider = svc.get("provider", "Service")
            if cost_cents > 0:
                total_cost_cents += cost_cents
                workflow.logger.info(f"💰 Service cost: +{cost_cents}c ({provider})")
                effective_call_site = call_site or tool_name or "unknown"
                usage_items_for_db.append(
                    {
                        "type": "service",
                        "cost_cents": cost_cents,
                        "call_site": effective_call_site,
                        "provider": provider,
                    }
                )

        if total_cost_cents > 0:
            # Update workflow cost state
            self.own_cost_cents += total_cost_cents
            workflow.logger.info(f"💰 Total own_cost_cents: {self.own_cost_cents}c (+{total_cost_cents}c)")

            # Admit the verified terminal result before any persistence/signal
            # await can admit another child cost update and publish a cost stop.
            if browser_completed:
                self.subtree_cost_cents = self.own_cost_cents + sum(self.children_cost_cents.values())
                self._maybe_arm_cost_limit_wrapup_after_browser(
                    tool_name=tool_name,
                    result={"success": True},
                    paused_before=paused_before,
                    cost_limit_before=cost_limit_before or self._cost_limit_reached,
                    pause_sequence_before=pause_sequence_before,
                )
            await self._update_cost_and_signal_parent()

        # Write to ToolUsage table (if tool_name provided). This intentionally
        # includes zero-cost direct-token LLM rows so cache/accounting diagnostics
        # can see the same LLM calls that worker logs emit.
        effective_call_site = call_site or tool_name or "unknown"
        if tool_name and usage_items_for_db:
            try:
                await workflow.execute_activity(
                    save_tool_usage,
                    args=[
                        self.agent_id,
                        self.user_id,
                        effective_call_site,
                        usage_items_for_db,
                        self._usage_checkpoint(),
                    ],
                    start_to_close_timeout=timedelta(seconds=15),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as e:
                workflow.logger.warning(f"Failed to save tool usage to DB: {e}")

    async def _get_model_pricing(self, model: str) -> Optional[Dict[str, float]]:
        """Get pricing for a model, using cache or fetching if needed."""
        # Check if it's the workflow's primary model
        if model == self.model and (self.input_cents_per_1k > 0 or self.output_cents_per_1k > 0):
            return {
                "input_cents_per_1k": self.input_cents_per_1k,
                "output_cents_per_1k": self.output_cents_per_1k,
            }

        # Check cache
        if model in self.model_pricing_cache:
            return self.model_pricing_cache[model]

        # Pricing is an in-process constant table. Keep this on the workflow
        # path so cost accounting cannot stall user-visible tools behind the
        # activity queue under benchmark load.
        pricing = get_in_process_model_pricing(model)
        if pricing is None:
            pricing = get_default_pricing(model)
            workflow.logger.warning(f"💰 Using default pricing fallback for {model}: {pricing}")
        else:
            workflow.logger.info(f"💰 Resolved pricing for {model}: {pricing}")
        self.model_pricing_cache[model] = pricing
        return pricing
