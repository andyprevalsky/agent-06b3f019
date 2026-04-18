"""Shared pytest fixtures and heavy-dependency stubs for the gepa domain.

The gepa domain re-exports from ``research.gepa.*`` which transitively pulls
in dspy, modal, openai, and the ``agents/helpers``/``agents/tools`` packages.
None of these should be loaded during unit tests — every LLM/network/file-IO
call must be mocked.

This conftest installs lightweight stand-in modules in ``sys.modules`` BEFORE
any gepa import happens so the entire dependency graph resolves against
fakes.
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

# --- Make the worktree's research/ and agents/ dirs importable ------------

REPO_ROOT = Path(__file__).resolve().parents[4]
RESEARCH_ROOT = REPO_ROOT / 'research'
AGENTS_ROOT = REPO_ROOT / 'agents'

for p in (str(REPO_ROOT), str(RESEARCH_ROOT), str(AGENTS_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

# --- Provide placeholder env vars so any stray os.environ reads succeed ----

for key, default in {
    'TEMPORAL_API_KEY': 'x',
    'TEMPORAL_ADDRESS': 'x',
    'TEMPORAL_NAMESPACE': 'x',
    'TEMPORAL_TASK_QUEUE': 'x',
    'OPENROUTER_API_KEY': 'x',
    'ROSE_API_KEY': 'x',
    'SUPABASE_ANON_KEY': 'x',
}.items():
    os.environ.setdefault(key, default)


def _install_stub(name: str, attrs: dict | None = None) -> types.ModuleType:
    """Register a stub module at ``name`` (creating parent packages as needed)."""

    if name in sys.modules:
        mod = sys.modules[name]
    else:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    for k, v in (attrs or {}).items():
        setattr(mod, k, v)
    return mod


# --- Stub agents/helpers.* (config.load_config touches os.environ) ---------

helpers_pkg = _install_stub('helpers')
helpers_pkg.__path__ = []  # mark as a package


# helpers.tool_schemas — provide minimal pydantic models mirroring the real ones
import pydantic  # noqa: E402


class _PlannerTask(pydantic.BaseModel):
    goal: str
    tool_name: str = 'spawn_explore_agent'
    depends_on: list[int] = []


class _DependencyEntry(pydantic.BaseModel):
    task_idx: str
    depends_on: list[str] = []


class _PlannerResponse(pydantic.BaseModel):
    title: str = 'Test'
    content: str = 'Content'
    tasks: list[_PlannerTask]
    dependencies_graph: list[_DependencyEntry] = []
    join: str = 'all'


_install_stub(
    'helpers.tool_schemas',
    {
        'PlannerResponse': _PlannerResponse,
        'PlannerTask': _PlannerTask,
        'DependencyEntry': _DependencyEntry,
    },
)


# helpers.prompts
def _build_planner_system_prompt(tools_desc: str = '') -> str:
    return (
        'INTRO TEXT\n'
        'TWO-AXIS PLANNING FRAMEWORK\n'
        'do the thing\n'
        'SPAWN_SUB_AGENT TOOL\n'
        f'tools: {tools_desc}\n'
        'AVAILABLE TOOLS\nOUTPUT CONTRACT\n'
    )


_install_stub('helpers.prompts', {'build_planner_system_prompt': _build_planner_system_prompt})


# helpers.llm
async def _call_llm_structured_streaming(*args, **kwargs):  # pragma: no cover - unused in tests
    raise RuntimeError('call_llm_structured_streaming should not be invoked in tests')


_install_stub(
    'helpers.llm',
    {
        'call_llm_structured_streaming': _call_llm_structured_streaming,
        'call_llm': lambda *a, **k: None,
        'prepare_schema_for_openai': lambda schema: schema,
    },
)


# --- Stub research.gepa.pipelines.benchmark (has heavy deps: httpx, scipy, numpy) ---


async def _stub_eval(goal, pr, ctx):
    return types.SimpleNamespace(score=1.0), {}


_install_stub(
    'research.gepa.pipelines.benchmark',
    {
        '_eval_me': _stub_eval,
        '_eval_ce': _stub_eval,
        '_eval_cx': _stub_eval,
    },
)

# --- Stub agents/tools.* ---------------------------------------------------

tools_pkg = _install_stub('tools')
tools_pkg.__path__ = []


def _validate_dependencies(task_indices, deps_dict):
    valid = set(task_indices)
    for idx, deps in deps_dict.items():
        for d in deps:
            if d == idx:
                return f'Task {idx} depends on itself'
            if d not in valid:
                return f'Task {idx} depends on unknown task {d}'
    # Kahn's algorithm for cycle detection
    in_degree = {i: 0 for i in task_indices}
    for idx, deps in deps_dict.items():
        in_degree[idx] = len(deps)
    queue = [i for i, d in in_degree.items() if d == 0]
    visited = 0
    while queue:
        node = queue.pop(0)
        visited += 1
        for idx, deps in deps_dict.items():
            if node in deps:
                in_degree[idx] -= 1
                if in_degree[idx] == 0:
                    queue.append(idx)
    if visited < len(task_indices):
        return 'cycle detected'
    return None


def _get_planner_tools_description() -> str:
    return 'stub tools description'


_install_stub(
    'tools.set_plan',
    {
        'validate_dependencies': _validate_dependencies,
        '_get_planner_tools_description': _get_planner_tools_description,
    },
)


# --- Stub modal (critic uses modal.Function.from_name/.Cls.from_name) ------


class _ModalRemote:
    def __init__(self, *args, **kwargs):
        pass

    def remote(self, *args, **kwargs):
        return {'model_id': 'stub', 'train_loss': 0.0, 'num_examples': 0, 'metrics': {}}


class _ModalScorer:
    def __init__(self, *args, **kwargs):
        self.score = _ModalRemote()


class _ModalCls:
    @classmethod
    def from_name(cls, *args, **kwargs):
        return lambda: _ModalScorer()


class _ModalFunction:
    @classmethod
    def from_name(cls, *args, **kwargs):
        return _ModalRemote()


_install_stub('modal', {'Function': _ModalFunction, 'Cls': _ModalCls})


# --- Stub openai (embeddings.py touches OpenAI at import time inside embed_texts
# but only when called; still stub to be safe). --------------------------


class _OpenAIStub:
    def __init__(self, *args, **kwargs):
        pass


_install_stub('openai', {'OpenAI': _OpenAIStub})


# --- Stub dotenv ----------------------------------------------------------

_install_stub('dotenv', {'load_dotenv': lambda *a, **k: False})


# --- Stub dspy (gepa_optimizer and runtime/run_full_pipeline import it lazily
# inside functions; still some top-level imports from submodules exist). --


class _DspySignatureBase:
    pass


def _dspy_input_field(**kwargs):
    return None


def _dspy_output_field(**kwargs):
    return None


class _DspyPredict:
    def __init__(self, signature=None):
        self.signature = types.SimpleNamespace(instructions='stub-strategy')
        self.demos = []

    def __call__(self, **kwargs):
        return types.SimpleNamespace(plan_json='{}')


class _DspyModule:
    def __init__(self):
        self.planner = _DspyPredict()

    def forward(self, *args, **kwargs):
        return self.planner(**kwargs)


class _DspyLM:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs


def _dspy_configure(**kwargs):
    return None


class _DspyExample:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

    def with_inputs(self, *names):
        return self


class _DspyGEPA:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def compile(self, module, trainset=None):
        return module


dspy_stub = _install_stub(
    'dspy',
    {
        'Signature': _DspySignatureBase,
        'InputField': _dspy_input_field,
        'OutputField': _dspy_output_field,
        'Predict': _DspyPredict,
        'Module': _DspyModule,
        'LM': _DspyLM,
        'configure': _dspy_configure,
        'Example': _DspyExample,
        'GEPA': _DspyGEPA,
    },
)


# dspy.clients.base_lm.BaseLM (used by run_full_pipeline monkey-patching)
class _BaseLM:
    def _process_completion(self, response, merged_kwargs):
        return [{'text': 'ok'}]

    def __call__(self, prompt=None, messages=None, **kwargs):
        return ['stub response']


_install_stub('dspy.clients', {})
_install_stub('dspy.clients.base_lm', {'BaseLM': _BaseLM})


# dspy.teleprompt.gepa.gepa_utils.ScoreWithFeedback
class _ScoreWithFeedback:
    def __init__(self, score: float = 0.0, feedback: str = ''):
        self.score = score
        self.feedback = feedback


_install_stub('dspy.teleprompt', {})
_install_stub('dspy.teleprompt.gepa', {})
_install_stub('dspy.teleprompt.gepa.gepa_utils', {'ScoreWithFeedback': _ScoreWithFeedback})


# --- Ensure research/ is importable as a proper package ------------------

_install_stub('research')
research_pkg = sys.modules['research']
research_pkg.__path__ = [str(RESEARCH_ROOT)]
