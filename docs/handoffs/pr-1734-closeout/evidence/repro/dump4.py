import asyncio, sys, os, threading, time
sys.path.insert(0,'/home/boxes/rose/agents'); sys.path.insert(0,'/home/boxes/rose/agents/tests/blackbox'); sys.path.insert(0,'/home/boxes/rose/agents/scripts')
os.chdir('/home/boxes/rose/agents')
import run_blackbox_tests as r
def chain(coro):
    out=[]
    while coro is not None and len(out)<14:
        fr=getattr(coro,'cr_frame',None) or getattr(coro,'gi_frame',None) or getattr(coro,'ag_frame',None)
        out.append(f"{getattr(coro,'__qualname__',coro)} @ {fr.f_code.co_filename.split('/')[-1]}:{fr.f_lineno}" if fr else str(coro))
        coro=getattr(coro,'cr_await',None) or getattr(coro,'gi_yieldfrom',None) or getattr(coro,'ag_await',None)
    return out
def watchdog(loop):
    time.sleep(40)
    print('HANG_TASKS', flush=True)
    try:
        ts=list(asyncio.all_tasks(loop))
    except Exception as e:
        print('ERR',e); os._exit(3)
    for t in ts:
        print('TASK', t.get_name(), 'cancelling=', t.cancelling(), flush=True)
        for line in chain(t.get_coro()): print('   ', line, flush=True)
    os._exit(3)
with asyncio.Runner() as runner:
    code = runner.run(r.run_tests(['browser-tilion'], 30))
    threading.Thread(target=watchdog, args=(runner.get_loop(),), daemon=True).start()
    print('RUN_DONE', flush=True)
print('CLEAN_EXIT', flush=True)
sys.exit(code)
