"""Tests for clarifar pipeline.

Stub tests verify the interface. Behavioral tests (xfail) define expected
behavior once run_agent is wired up in Phase B.
"""

import pytest

from research.gepa.pipelines.clarifar import clarifar, SetPlanTrap
from research.gepa.types import ClarifiedTask


class TestSetPlanTrap:

    def test_trap_stores_plan_args(self):
        plan_args = {'title': 'Test', 'tasks': []}
        trap = SetPlanTrap(plan_args)
        assert trap.plan_args == plan_args

    def test_trap_is_exception(self):
        assert issubclass(SetPlanTrap, Exception)


class TestClarifarStub:

    @pytest.mark.asyncio
    async def test_returns_clarified_task(self):
        result = await clarifar('Book a flight')
        assert isinstance(result, ClarifiedTask)

    @pytest.mark.asyncio
    async def test_preserves_raw_seed(self):
        result = await clarifar('Book a flight')
        assert result.raw_seed == 'Book a flight'

    @pytest.mark.asyncio
    async def test_has_id(self):
        result = await clarifar('Book a flight')
        assert result.id  # non-empty

    @pytest.mark.asyncio
    async def test_lists_initialized(self):
        result = await clarifar('Book a flight')
        assert isinstance(result.agent_context, list)


class TestClarifarBehavioral:

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='STUB: awaiting run_agent integration')
    async def test_captures_set_plan_args(self):
        result = await clarifar('Book a flight from NYC to LA')
        assert result.set_plan_args  # non-empty dict
        assert 'tasks' in result.set_plan_args or 'title' in result.set_plan_args

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='Behavioral: tools used derivable from agent_context')
    async def test_records_tools_used(self):
        result = await clarifar('Research the best restaurants in SF')
        # tools_used is derivable from agent_context, no longer a separate field
        assert len(result.agent_context) > 0

    @pytest.mark.asyncio
    @pytest.mark.xfail(reason='STUB: awaiting run_agent integration')
    async def test_has_conversation_context(self):
        result = await clarifar('Book a flight')
        assert len(result.agent_context) > 0
