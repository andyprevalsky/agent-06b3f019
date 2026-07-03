"""CDP validation: does the BrowserAgentChip render in the real FE?

Injects a minted Supabase session into localStorage['rose-session'], loads the
real frontend with ?agent-id=, and asserts the chip renders, expands, and shows
the Result/Trajectory/Recording views. Headless Chromium over CDP (Playwright).
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

FE = "http://localhost:55131"
AGENT_ID = "e1fa0fad-02d7-4a3c-983d-ef9739111f32"
SESSION_FILE = "/tmp/session_resp.json"


async def main() -> int:
    resp = json.load(open(SESSION_FILE))
    session = resp.get("session") or resp
    session_json = json.dumps(session)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 1400})
        # Seed the auth session before any app JS runs.
        await ctx.add_init_script(
            f"window.localStorage.setItem('rose-session', {json.dumps(session_json)});"
        )
        page = await ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if (m.type in ("error", "warning") or "chipdbg" in m.text) else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

        await page.goto(f"{FE}/browser-chip-validate.html", wait_until="domcontentloaded")
        # Give the app time to auth, fetch agent detail (145 msgs), render.
        try:
            await page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        await page.wait_for_timeout(3000)

        # Look for the chip by testid (reliable).
        chip = page.get_by_test_id("browser-agent-chip")
        chip_count = await chip.count()
        title = await page.title()
        ba_text = await page.get_by_text("Browser Agent", exact=False).count()
        print(f"title={title!r}  chip[data-testid]={chip_count}  'Browser Agent' text={ba_text}")

        result = {"chip_found": chip_count > 0}

        if chip_count > 0:
            await chip.first.scroll_into_view_if_needed()
            await page.get_by_test_id("browser-agent-chip-header").first.click()
            await page.wait_for_timeout(800)
            for tab in ("Result", "Trajectory", "Recording"):
                cnt = await page.get_by_text(tab, exact=False).count()
                result[f"tab_{tab.lower()}"] = cnt > 0
                print(f"  tab {tab}: {'OK' if cnt > 0 else 'MISSING'}")
            try:
                await page.get_by_text("Recording", exact=False).first.click()
                await page.wait_for_timeout(2500)
                iframes = await page.locator("iframe").count()
                result["recording_iframe"] = iframes > 0
                print(f"  recording iframe present: {iframes > 0} ({iframes})")
            except Exception as e:  # noqa: BLE001
                print(f"  recording tab click failed: {str(e)[:100]}")
        else:
            # Diagnostic: what's rendering instead?
            for needle in ("Browser automation", "Browser Agent"):
                els = page.get_by_text(needle, exact=False)
                n = await els.count()
                if n:
                    html = await els.first.evaluate(
                        "el => (el.closest('[class*=rounded]')||el.parentElement||el).outerHTML.slice(0,400)"
                    )
                    print(f"  '{needle}' x{n} → {html}")

        await page.screenshot(path="/tmp/chip_validation.png", full_page=False)
        print(f"screenshot -> /tmp/chip_validation.png")
        if errors:
            print("console errors (first 5):")
            for e in errors[:5]:
                print("  ", e[:160])
        await browser.close()

        ok = result.get("chip_found") and result.get("tab_recording")
        print("\nRESULT:", json.dumps(result))
        print("PASS" if ok else "FAIL")
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
