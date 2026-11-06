import asyncio, sys, os
sys.path.insert(0,'/home/boxes/rose/agents'); sys.path.insert(0,'/home/boxes/rose/agents/tests/blackbox'); sys.path.insert(0,'/home/boxes/rose/agents/scripts')
os.chdir('/home/boxes/rose/agents')
import run_blackbox_tests as r
async def main():
    code = await r.run_tests(['browser-tilion'], 30)
    me = asyncio.current_task()
    left = [t for t in asyncio.all_tasks() if t is not me]
    print('LEFT', len(left), flush=True)
    for t in left:
        print('TASK', t.get_name(), t.get_coro().__qualname__, flush=True)
        t.print_stack(limit=6, file=sys.stdout)
    sys.stdout.flush()
    return code
sys.exit(asyncio.run(main()))
