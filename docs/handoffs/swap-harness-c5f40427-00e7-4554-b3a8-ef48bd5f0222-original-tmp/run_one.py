import importlib.util, sys, time
sys.path[:0] = ["agents", "agents/tests/blackbox"]
spec = importlib.util.spec_from_file_location("bb", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fails = 0
for i in range(int(sys.argv[2])):
    try: m.test_hub_registration_recovers_ambiguous_committed_post_timeout()
    except AssertionError: fails += 1
print("FAILS", fails, "of", sys.argv[2])
