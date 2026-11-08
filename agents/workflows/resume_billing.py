"""Billing and the cost limit for a resume run (code or browser) outside its owner's workflow.

The resume workflows inherit AgentWorkflow's own billing path (UsageTrackingMixin
._track_usage: pricing, ToolUsage rows, own_cost_cents) with ``own_cost_cents`` =
THIS RUN's absolute spend. The backend ledger is the single source of resume spend:

    usage ─▶ own_cost_cents (the run's total) ─▶ apply_resume_cost_activity(owner,
        "resume:<this workflow id>", total): one monotonic total per run key; the
        owner's and ancestors' tree cost grow by its growth (never own cost).
        Resends, reordered or older totals change nothing.
    no workflow is signalled resume spend: every tree-cost write adds the ledger's
        totals under that agent, and a root checks its limit against that stored tree
      ─▶ the owner root's limit ─▶ reached: _cost_limit_reached, is_paused

Only the run's total rides continue_as_new (``billing_state()``).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from helpers.update_tokens import apply_resume_cost_activity
    from workflows.usage_tracking import UsageTrackingMixin


class ResumeBillingMixin(UsageTrackingMixin):
    """Owner-billed usage for a resume run; host defines agent_id, user_id, model, is_paused."""

    def _init_billing(self, request: Dict[str, Any]) -> None:
        self.input_cents_per_1k = 0.0
        self.output_cents_per_1k = 0.0
        self.model_pricing_cache: Dict[str, Any] = {}
        self.children_cost_cents: Dict[str, float] = {}
        self.subtree_cost_cents = 0.0
        self._cost_limit_reached = False
        carried = request.get("billing") if isinstance(request.get("billing"), dict) else {}
        # The run's own total spend so far (carried across continue_as_new).
        self.own_cost_cents = float(carried.get("spend_cents") or 0)
        self._resume_cost_key = f"resume:{workflow.info().workflow_id}"

    def billing_state(self) -> Dict[str, Any]:
        """The billing to carry across continue_as_new: the run's total."""
        return {"spend_cents": self.own_cost_cents}

    def _usage_checkpoint(self) -> None:
        """No owner checkpoint: the owner's own durable high-water is its own workflow's."""
        return None

    def _maybe_arm_cost_limit_wrapup_after_browser(self, **_kwargs: Any) -> None:
        """AgentWorkflow's post-browser wrap-up allowance has no planner turn to wrap up here."""
        return None

    async def _update_cost_and_signal_parent(self, force: bool = False) -> None:
        try:
            result = await workflow.execute_activity(
                apply_resume_cost_activity,
                args=[self.agent_id, self._resume_cost_key, float(self.own_cost_cents)],
                start_to_close_timeout=timedelta(seconds=15),
                retry_policy=RetryPolicy(maximum_attempts=5),
            )
        except Exception as error:  # the next update reports the (larger) total again
            workflow.logger.warning(f"Failed to report the resume run's spend: {error}")
            return
        if (result or {}).get("limit_reached") is True and not self._cost_limit_reached:
            workflow.logger.warning("💰 Resume run stopped: its owner's root reached the cost limit")
            self._cost_limit_reached = True
            self.is_paused = True

    async def _check_owner_limit(self) -> None:
        """Before spending: an owner already at its limit stops the run at once."""
        await self._update_cost_and_signal_parent()

    async def _bill_event(self, event: Any, tool_name: str, call_site: str) -> None:
        """Route a spawn event's usage (``data["usage"]``) to the billing path."""
        data = getattr(event, "data", None)
        if isinstance(data, dict) and data.get("usage"):
            await self._track_usage(data["usage"], tool_name=tool_name, call_site=call_site)
