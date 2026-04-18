"""Tests for validators.py - wraps validate_dependencies + task count check."""

from research.gepa.tests.fixtures import (
    INVALID_1_TASK,
    INVALID_9_TASKS,
    INVALID_CYCLE_AB,
    INVALID_CYCLE_ABC,
    INVALID_DEP_OUT_OF_RANGE,
    INVALID_SELF_DEP,
    VALID_DIAMOND_4,
    VALID_LINEAR_2,
    VALID_LINEAR_3,
    VALID_MAX_8,
    VALID_PARALLEL_2,
)
from research.gepa.validators import validate_decomposition


class TestValidDecompositions:
    def test_linear_chain_2_tasks(self):
        errors = validate_decomposition(VALID_LINEAR_2)
        assert errors == []

    def test_linear_chain_3_tasks(self):
        errors = validate_decomposition(VALID_LINEAR_3)
        assert errors == []

    def test_diamond_4_tasks(self):
        errors = validate_decomposition(VALID_DIAMOND_4)
        assert errors == []

    def test_parallel_2_tasks(self):
        errors = validate_decomposition(VALID_PARALLEL_2)
        assert errors == []

    def test_max_8_tasks(self):
        errors = validate_decomposition(VALID_MAX_8)
        assert errors == []


class TestInvalidTaskCount:
    def test_1_task_fails(self):
        errors = validate_decomposition(INVALID_1_TASK)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_TASK_COUNT'

    def test_9_tasks_fails(self):
        errors = validate_decomposition(INVALID_9_TASKS)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_TASK_COUNT'


class TestInvalidDependencyIndex:
    def test_dep_out_of_range(self):
        errors = validate_decomposition(INVALID_DEP_OUT_OF_RANGE)
        assert len(errors) == 1
        assert errors[0].type == 'INVALID_DEPENDENCY_INDEX'


class TestCycleDetected:
    def test_self_dependency(self):
        errors = validate_decomposition(INVALID_SELF_DEP)
        assert len(errors) == 1
        assert errors[0].type == 'CYCLE_DETECTED'

    def test_cycle_a_b(self):
        errors = validate_decomposition(INVALID_CYCLE_AB)
        assert len(errors) == 1
        assert errors[0].type == 'CYCLE_DETECTED'

    def test_cycle_a_b_c(self):
        errors = validate_decomposition(INVALID_CYCLE_ABC)
        assert len(errors) == 1
        assert errors[0].type == 'CYCLE_DETECTED'
