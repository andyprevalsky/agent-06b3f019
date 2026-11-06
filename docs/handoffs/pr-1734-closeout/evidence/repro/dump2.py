import asyncio, sys, os
sys.path.insert(0,'/home/boxes/rose/agents'); sys.path.insert(0,'/home/boxes/rose/agents/tests/blackbox'); sys.path.insert(0,'/home/boxes/rose/agents/scripts')
os.chdir('/home/boxes/rose/agents')
import run_blackbox_tests as r
def chain(coro):
    out=[]
    while coro is not None and len(out)<12:
        fr=getattr(coro,'cr_frame',None) or getattr(coro,'gi_frame',None) or getattr(coro,'ag_frame',None)
        out.append(f"{getattr(coro,'__qualname__',coro)} @ {fr.f_code.co_filename.split('/')[-1]}:{fr.f_lineno}" if fr else str(coro))
        coro=getattr(coro,'cr_await',None) or getattr(coro,'gi_yieldfrom',None) or getattr(coro,'ag_await',None)
    return out
async def main():
    code = await r.run_tests(['browser-tilion'], 30)
    me = asyncio.current_task()
    left = [t for t in asyncio.all_tasks() if t is not me]
    print('LEFT', len(left), flush=True)
    for t in left: t.cancel()
    done, pending = await asyncio.wait(left, timeout=8) if left else (set(), set())
    print('STILL_PENDING', len(pending), flush=True)
    for t in pending:
        print('TASK', t.get_name(), flush=True)
        for line in chain(t.get_coro()): print('   ', line, flush=True)
    more = [t for t in asyncio.all_tasks() if t is not me and t not in left]
    print('NEW_TASKS', len(more), flush=True)
    for t in more:
        print('NEW', t.get_name(), flush=True)
        for line in chain(t.get_coro()): print('   ', line, flush=True)
    os._exit(0)
asyncio.run(main())
