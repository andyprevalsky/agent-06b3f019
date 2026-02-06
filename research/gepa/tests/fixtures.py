"""Shared test fixtures for GEPA tests."""

from helpers.tool_schemas import PlannerResponse, PlannerTask, DependencyEntry


def make_planner_response(
    tasks: list[dict],
    deps: list[dict] | None = None,
    title: str = 'Test Plan',
    content: str = 'Test plan content',
    join: str = 'all',
) -> PlannerResponse:
    """Helper to build PlannerResponse from simple dicts."""
    planner_tasks = [
        PlannerTask(goal=t['goal'], tool_name=t.get('tool_name', 'web_search'), depends_on=t.get('depends_on', []))
        for t in tasks
    ]
    if deps is None:
        deps = [{'task_idx': str(i), 'depends_on': [str(d) for d in t.get('depends_on', [])]} for i, t in enumerate(tasks)]
    dep_entries = [DependencyEntry(task_idx=d['task_idx'], depends_on=d['depends_on']) for d in deps]
    return PlannerResponse(title=title, content=content, tasks=planner_tasks, dependencies_graph=dep_entries, join=join)


# --- Valid decompositions ---

VALID_LINEAR_2 = make_planner_response(
    tasks=[
        {'goal': 'Search for flights', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Book the cheapest flight', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
    ],
)

VALID_LINEAR_3 = make_planner_response(
    tasks=[
        {'goal': 'Research options', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Compare prices', 'tool_name': 'reasoning', 'depends_on': [0]},
        {'goal': 'Purchase best option', 'tool_name': 'spawn_browser_agent', 'depends_on': [1]},
    ],
)

VALID_DIAMOND_4 = make_planner_response(
    tasks=[
        {'goal': 'Initial research', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Check provider A', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
        {'goal': 'Check provider B', 'tool_name': 'spawn_browser_agent', 'depends_on': [0]},
        {'goal': 'Compare and decide', 'tool_name': 'reasoning', 'depends_on': [1, 2]},
    ],
)

VALID_PARALLEL_2 = make_planner_response(
    tasks=[
        {'goal': 'Search flights', 'tool_name': 'web_search', 'depends_on': []},
        {'goal': 'Search hotels', 'tool_name': 'web_search', 'depends_on': []},
    ],
)

VALID_MAX_8 = make_planner_response(
    tasks=[{'goal': f'Task {i}', 'tool_name': 'web_search', 'depends_on': []} for i in range(8)],
)


# --- Invalid decompositions ---

INVALID_1_TASK = make_planner_response(
    tasks=[{'goal': 'Only task', 'tool_name': 'web_search', 'depends_on': []}],
)

INVALID_9_TASKS = make_planner_response(
    tasks=[{'goal': f'Task {i}', 'tool_name': 'web_search', 'depends_on': []} for i in range(9)],
)

INVALID_SELF_DEP = make_planner_response(
    tasks=[
        {'goal': 'Task A', 'tool_name': 'web_search', 'depends_on': [0]},
        {'goal': 'Task B', 'tool_name': 'web_search', 'depends_on': []},
    ],
)

INVALID_CYCLE_AB = make_planner_response(
    tasks=[
        {'goal': 'Task A', 'tool_name': 'web_search', 'depends_on': [1]},
        {'goal': 'Task B', 'tool_name': 'web_search', 'depends_on': [0]},
    ],
)

INVALID_CYCLE_ABC = make_planner_response(
    tasks=[
        {'goal': 'Task A', 'tool_name': 'web_search', 'depends_on': [2]},
        {'goal': 'Task B', 'tool_name': 'web_search', 'depends_on': [0]},
        {'goal': 'Task C', 'tool_name': 'web_search', 'depends_on': [1]},
    ],
)

INVALID_DEP_OUT_OF_RANGE = make_planner_response(
    tasks=[
        {'goal': 'Task A', 'tool_name': 'web_search', 'depends_on': [5]},
        {'goal': 'Task B', 'tool_name': 'web_search', 'depends_on': []},
    ],
)
