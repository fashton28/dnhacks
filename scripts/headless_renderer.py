"""Headless Renderer: runs the Console in headless Chromium so the Hub gets frames with no operator tab open.

Run:  uv run python scripts/headless_renderer.py [--hub http://127.0.0.1:8000] [--screenshot path.png] [--seconds N]
The Console is served by the Hub at /console/ (build it first: cd console && pnpm build).
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from playwright.async_api import async_playwright


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", default="http://127.0.0.1:8000")
    ap.add_argument("--url", default=None, help="override page URL (e.g. the vite dev server)")
    ap.add_argument("--screenshot", default=None)
    ap.add_argument("--seconds", type=float, default=0, help="exit after N seconds (0 = run until killed)")
    ap.add_argument("--select", default=None, help="drone id to select for the Drone view")
    a = ap.parse_args()
    url = a.url or f"{a.hub}/console/?headless=1&hub={a.hub}"
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: print(f"[page:{m.type}] {m.text}", flush=True) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: print(f"[pageerror] {e}", flush=True))
        await page.goto(url, wait_until="load")
        print(f"[headless] renderer at {url}", flush=True)
        try:
            await page.wait_for_selector("#renderer-status.ok", timeout=15000)
            print("[headless] connected to hub as renderer", flush=True)
        except Exception:  # noqa: BLE001
            print("[headless] WARNING: renderer did not connect within 15s", flush=True)
        if a.select:
            await page.evaluate(f"window.__argusSelect && window.__argusSelect({a.select!r})")
        if a.screenshot:
            await asyncio.sleep(2)
            await page.screenshot(path=a.screenshot)
            print(f"[headless] screenshot {a.screenshot}", flush=True)
        if a.seconds > 0:
            await asyncio.sleep(a.seconds)
        else:
            while True:
                await asyncio.sleep(3600)
        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
