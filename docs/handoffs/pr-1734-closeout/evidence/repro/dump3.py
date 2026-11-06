import asyncio, sys, os, threading
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
    LOOP[0]=asyncio.get_running_loop()
    threading.Thread(target=watchdog, daemon=True).start()
    print('MAIN_DONE', flush=True)
    return code
LOOP=[None]
def watchdog():
    import time
    time.sleep(25)
    loop=LOOP[0]
    ts=asyncio.all_tasks(loop)
    print('WD_TASKS', len(ts), flush=True)
    for t in ts:
        print('WDTASK', t.get_name(), t.cancelled(), t.done(), flush=True)
        for line in chain(t.get_coro()): print('   ', line, flush=True)
    os._exit(0)
asyncio.run(main())
