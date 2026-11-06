import asyncio, sys, importlib.util, time
sys.path.insert(0,'/home/boxes/rose/agents'); sys.path.insert(0,'/home/boxes/rose/agents/tests/blackbox')
spec=importlib.util.spec_from_file_location('bt','/home/boxes/rose/agents/tests/blackbox/browser_tilion.blackbox.py')
bt=importlib.util.module_from_spec(spec); spec.loader.exec_module(bt)
def chain(coro):
    out=[]
    while coro is not None and len(out)<8:
        fr=getattr(coro,'cr_frame',None) or getattr(coro,'gi_frame',None)
        out.append(f"{getattr(coro,'__qualname__',coro)}@{fr.f_code.co_filename.split('/')[-1]}:{fr.f_lineno}" if fr else str(coro))
        coro=getattr(coro,'cr_await',None) or getattr(coro,'gi_yieldfrom',None)
    return out
async def main():
    me=asyncio.current_task()
    for n in sys.argv[1:]:
        await getattr(bt,n)()
        await asyncio.sleep(4)
        left=[t for t in asyncio.all_tasks() if t is not me]
        print('after',n,'LEFT',len(left),flush=True)
        for t in left: print('   ',t.get_name()[:40], ' > '.join(chain(t.get_coro())),flush=True)
asyncio.run(main())
