from argparse import Namespace

import benchmarks.run_benchmark as rb


def _args(*, task=None, suite=None, exclude_task=None):
    return Namespace(
        task=task or [],
        suite=suite,
        anon=False,
        exclude_task=exclude_task or [],
    )


def test_repeated_task_selects_exact_tasks_in_order():
    args = _args(task=["parallel-tool-calls", "spawn-sub-agents"])

    tasks = rb.resolve_tasks(args)

    assert [task.name for task in tasks] == ["parallel-tool-calls", "spawn-sub-agents"]


def test_comma_separated_task_selects_exact_tasks_in_order():
    args = _args(task=["parallel-tool-calls,spawn-sub-agents"])

    tasks = rb.resolve_tasks(args)

    assert [task.name for task in tasks] == ["parallel-tool-calls", "spawn-sub-agents"]


def test_suite_label_for_repeated_task_args_is_readable():
    args = _args(task=["parallel-tool-calls", "spawn-sub-agents"])

    assert rb.suite_name_for_error(args) == "--task parallel-tool-calls,spawn-sub-agents"
