import asyncio, sys, importlib.util, time
sys.path.insert(0,'/home/boxes/rose/agents'); sys.path.insert(0,'/home/boxes/rose/agents/tests/blackbox')
spec=importlib.util.spec_from_file_location('bt','/home/boxes/rose/agents/tests/blackbox/browser_tilion.blackbox.py')
bt=importlib.util.module_from_spec(spec); spec.loader.exec_module(bt)
async def main():
    for n in sys.argv[1:]:
        await getattr(bt,n)(); print('ran',n,flush=True)
    me=asyncio.current_task()
    left=[t for t in asyncio.all_tasks() if t is not me]
    print('LEFT',len(left))
    for t in left: print('  ',t.get_coro().__qualname__, t.get_name())
t=time.time(); asyncio.run(main()); print('exited',time.time()-t)
