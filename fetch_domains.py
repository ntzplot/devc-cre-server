"""
One-time script: opens mail.chatgpt.org.uk, clicks the domain dropdown,
scrapes all available domains, and saves them to domains.txt.

Run once:  python fetch_domains.py
"""

from pathlib import Path
from playwright.sync_api import sync_playwright
import time

OUT = Path(__file__).parent / "domains.txt"

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir="",
        headless=False,
        args=["--disable-blink-features=AutomationControlled"],
        ignore_default_args=["--enable-automation"],
    )
    page = ctx.new_page()
    page.goto("https://mail.chatgpt.org.uk", wait_until="domcontentloaded")
    time.sleep(3)

    # Click the domain dropdown (placeholder="Automatic")
    dropdown = page.locator('input[placeholder="Automatic"]')
    dropdown.wait_for(state="visible", timeout=15_000)
    dropdown.click()
    time.sleep(1.5)

    # Mantine renders options in a portal div — grab all visible option text
    options = page.locator('[role="option"]').all_text_contents()
    domains = [o.strip() for o in options if o.strip() and "." in o.strip()]

    ctx.close()

if domains:
    OUT.write_text("\n".join(domains), encoding="utf-8")
    print(f"Saved {len(domains)} domains to {OUT}")
    for d in domains:
        print(f"  {d}")
else:
    print("No domains found — check the selector or the page loaded incorrectly.")
