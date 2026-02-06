"""Tests for scoring modules: hard gates, soft penalties, final scorer."""

import math

import pytest

from research.gepa.scoring.hard_gates import hard_gate
from research.gepa.scoring.soft_penalties import soft_penalties, LAMBDA
from research.gepa.scoring.final_scorer import final_score
from research.gepa.tests.fixtures import VALID_LINEAR_2, INVALID_1_TASK, INVALID_CYCLE_AB


class TestHardGates:

    def test_valid_returns_zero(self):
        assert hard_gate(VALID_LINEAR_2) == 0.0

    def test_invalid_task_count_returns_neg_inf(self):
        assert hard_gate(INVALID_1_TASK) == -math.inf

    def test_cycle_returns_neg_inf(self):
        assert hard_gate(INVALID_CYCLE_AB) == -math.inf


class TestSoftPenalties:

    def test_all_pass(self):
        assert soft_penalties(me=True, ce=True, cx=True) == 0.0

    def test_me_fails(self):
        result = soft_penalties(me=False, ce=True, cx=True)
        assert result == pytest.approx(LAMBDA['ME'])

    def test_ce_fails(self):
        result = soft_penalties(me=True, ce=False, cx=True)
        assert result == pytest.approx(LAMBDA['CE'])

    def test_cx_fails(self):
        result = soft_penalties(me=True, ce=True, cx=False)
        assert result == pytest.approx(LAMBDA['CX'])

    def test_all_fail(self):
        result = soft_penalties(me=False, ce=False, cx=False)
        expected = LAMBDA['ME'] + LAMBDA['CE'] + LAMBDA['CX']
        assert result == pytest.approx(expected)


class TestFinalScorer:

    def test_basic_calculation(self):
        # critic=0.8, penalties=0.3, 2 tasks, depth=2
        # 0.8 - 0.3 - 0.02*2 - 0.01*2 = 0.8 - 0.3 - 0.04 - 0.02 = 0.44
        result = final_score(critic_score=0.8, penalties=0.3, num_tasks=2, depth=2)
        assert result == pytest.approx(0.44)

    def test_neg_inf_propagates(self):
        result = final_score(critic_score=-math.inf, penalties=0.0, num_tasks=2, depth=1)
        assert result == -math.inf

    def test_zero_penalties(self):
        result = final_score(critic_score=1.0, penalties=0.0, num_tasks=3, depth=1)
        # 1.0 - 0.0 - 0.02*3 - 0.01*1 = 1.0 - 0.06 - 0.01 = 0.93
        assert result == pytest.approx(0.93)

    def test_custom_lambdas(self):
        result = final_score(
            critic_score=1.0, penalties=0.0,
            num_tasks=4, depth=3,
            lambda_size=0.05, lambda_depth=0.03,
        )
        # 1.0 - 0.0 - 0.05*4 - 0.03*3 = 1.0 - 0.20 - 0.09 = 0.71
        assert result == pytest.approx(0.71)
