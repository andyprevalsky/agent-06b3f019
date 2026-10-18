"""Run named benchmark-blackbox registry entries from one worktree: run-named-bb.py <agents dir> <name>..."""
import asyncio, importlib.util, inspect, re, sys, os, traceback
agents = sys.argv[1]
names = sys.argv[2:]
os.chdir(agents)
sys.path.insert(0, agents); sys.path.insert(0, os.path.join(agents, "tests/blackbox"))
path = os.path.join(agents, "tests/blackbox/benchmark.blackbox.py")
src = open(path).read()
mapping = dict(re.findall(r'record(?:_async)?\(\s*"([a-z0-9_]+)",\s*([A-Za-z0-9_.]+)', src))
spec = importlib.util.spec_from_file_location("bb", path)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
for name in names:
    fn_name = mapping.get(name)
    if not fn_name or not hasattr(m, fn_name):
        print("MISSING", name, fn_name); continue
    fn = getattr(m, fn_name)
    try:
        result = fn()
        if inspect.isawaitable(result):
            asyncio.run(result)
        print("PASS", name)
    except BaseException as exc:
        print("FAIL", name, type(exc).__name__, str(exc)[:160].replace("\n", " "))
