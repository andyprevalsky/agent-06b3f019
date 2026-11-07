import asyncio, sys, importlib.util, time
sys.path.insert(0,'/home/boxes/rose/agents'); sys.path.insert(0,'/home/boxes/rose/agents/tests/blackbox')
spec=importlib.util.spec_from_file_location('bt','/home/boxes/rose/agents/tests/blackbox/browser_tilion.blackbox.py')
bt=importlib.util.module_from_spec(spec); spec.loader.exec_module(bt)
names=sys.argv[1:]
for n in names:
    t=time.time()
    try:
        asyncio.run(getattr(bt,n)()); print('PASS',n,f'{time.time()-t:.1f}s')
    except BaseException as e:
        print('FAIL',n,f'{time.time()-t:.1f}s',type(e).__name__,str(e)[:300])
