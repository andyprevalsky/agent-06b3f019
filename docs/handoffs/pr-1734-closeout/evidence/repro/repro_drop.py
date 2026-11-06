import asyncio, sys, time, logging, os
sys.path.insert(0, '/home/boxes/rose/agents'); sys.path.insert(0, '/home/boxes/rose/agents/tests/blackbox')
import importlib.util
spec = importlib.util.spec_from_file_location('bt', '/home/boxes/rose/agents/tests/blackbox/browser_tilion.blackbox.py')
bt = importlib.util.module_from_spec(spec); spec.loader.exec_module(bt)
from browser_tools.dom_service import DOMService
from domains.spawn_browser_agent_v3.cdp_urls import open_browser_cdp_connection

async def main():
    async with bt._chromium() as (pw, _b, endpoint):
        async with bt.FakeTilionGateway(endpoint) as gw:
            with bt._tilion_env(gw):
                local_url, mux = await open_browser_cdp_connection(gw.cdp_url, label='repro')
                svc = DOMService(cdp_url=local_url, cdp_multiplexer=mux)
                await svc.connect()
                page = await svc.session.get_current_page()
                st = await svc.get_browser_state(include_screenshot=False)
                print('baseline ok', st.get('url'))
                await gw.drop_all()
                t0 = time.time()
                for i in range(10):
                    try:
                        await asyncio.wait_for(svc.get_browser_state(include_screenshot=False), 70)
                        print(i, f'{time.time()-t0:.2f}s OK')
                        break
                    except Exception as e:
                        print(i, f'{time.time()-t0:.2f}s', type(e).__name__, str(e)[:120])
                await bt._stop_dom_service(svc)
asyncio.run(main())
