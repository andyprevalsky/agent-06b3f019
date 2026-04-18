"""Tests for scoring modules: hard gates, soft penalties, final scorer."""

import math

import pytest

from research.gepa.scoring.final_scorer import ALPHA, BETA, GAMMA, final_score
from research.gepa.scoring.hard_gates import hard_gate
from research.gepa.scoring.soft_penalties import LAMBDA, soft_penalties
from research.gepa.tests.fixtures import INVALID_1_TASK, INVALID_CYCLE_AB, VALID_LINEAR_2


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
    def test_critic_only(self):
        # No ME/CE/CX → defaults to 1.0 → pure critic score
        assert final_score(critic_score=0.8) == pytest.approx(0.8)

    def test_default_exponents(self):
        # Verify default exponents: α=1.0 (ME), β=1.5 (CE), γ=0.5 (CX)  # noqa: RUF003
        assert ALPHA == 1.0
        assert BETA == 1.5
        assert GAMMA == 0.5

    def test_multiplicative_with_defaults(self):
        # 0.8 × 0.9^1.0 × 0.7^1.5 × 0.95^0.5  # noqa: RUF003
        result = final_score(critic_score=0.8, me_score=0.9, ce_score=0.7, cx_score=0.95)
        expected = 0.8 * (0.9**ALPHA) * (0.7**BETA) * (0.95**GAMMA)
        assert result == pytest.approx(expected)

    def test_zero_dimension_collapses(self):
        # If any structural dimension is 0, entire score is 0
        assert final_score(critic_score=0.9, me_score=0.0, ce_score=1.0, cx_score=1.0) == 0.0
        assert final_score(critic_score=0.9, me_score=1.0, ce_score=0.0, cx_score=1.0) == 0.0
        assert final_score(critic_score=0.9, me_score=1.0, ce_score=1.0, cx_score=0.0) == 0.0

    def test_neg_inf_propagates(self):
        result = final_score(critic_score=-math.inf)
        assert result == -math.inf

    def test_perfect_scores(self):
        result = final_score(critic_score=1.0, me_score=1.0, ce_score=1.0, cx_score=1.0)
        assert result == pytest.approx(1.0)

    def test_custom_exponents(self):
        # 0.8 × 0.5^2.0 × 1.0^1.5 × 1.0^0.5 = 0.8 × 0.25 = 0.2  # noqa: RUF003
        result = final_score(critic_score=0.8, me_score=0.5, alpha=2.0)
        assert result == pytest.approx(0.8 * 0.25)

    def test_ce_weighted_heavier(self):
        # CE has β=1.5 so a low CE hurts more than a low ME (α=1.0)  # noqa: RUF003
        score_low_me = final_score(critic_score=1.0, me_score=0.7, ce_score=1.0, cx_score=1.0)
        score_low_ce = final_score(critic_score=1.0, me_score=1.0, ce_score=0.7, cx_score=1.0)
        # 0.7^1.0 = 0.7 > 0.7^1.5 ≈ 0.586 → low CE hurts more
        assert score_low_me > score_low_ce
