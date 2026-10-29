"""
Cancel xpatfone/Devyce subscriptions for accounts in codes.csv.
Reads email + login code, logs in, then navigates to cancellation flow.

Install deps (same as checkout.py):
    pip install playwright playwright-stealth
    playwright install chromium
"""

import csv
import json
import random
import shutil
import subprocess
import tempfile
import time
import traceback
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
from playwright_stealth import Stealth

_stealth = Stealth()

# ── Load config ───────────────────────────────────────────────────────────────
_cfg = json.loads((Path(__file__).parent.parent / "config" / "config.json").read_text(encoding="utf-8"))

NORDVPN_COUNTRY         = _cfg["nordvpn"]["country"]
NORDVPN_RECONNECT_EVERY = _cfg["nordvpn"]["reconnect_every"]
PROXY_CONFIG            = _cfg["proxy"]

# ─────────────────────────────────────────────────────────────────────────────

CODES_CSV    = Path("codes.csv")
CANCELLED_CSV = Path("cancelled.csv")
CANCEL_FAILED_CSV = Path("cancel_failed.csv")

LOGIN_URL  = "https://xpatfone.com/login"
ACCOUNT_URL = "https://xpatfone.com/account"

TIMEOUT = 45_000
USE_PROXY = PROXY_CONFIG.get("enabled", True)

# ── NordVPN ───────────────────────────────────────────────────────────────────

_NORDVPN_EXE = r"C:\Program Files\NordVPN\NordVPN.exe"


def _nordvpn_run(*args, timeout=30):
    return subprocess.run(
        [_NORDVPN_EXE, *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _nordvpn_adapter_up() -> bool:
    try:
        result = subprocess.run(
            [
                "powershell", "-NoProfile", "-Command",
                "Get-NetAdapter | Where-Object { $_.Name -like 'Nord*' -or $_.InterfaceDescription -like 'Nord*' } | Select-Object -ExpandProperty Status",
            ],
            capture_output=True, text=True, timeout=10,
        )
        return "Up" in result.stdout
    except Exception:
        return False


def nordvpn_connect(country: str = NORDVPN_COUNTRY):
    print(f"[NordVPN] Connecting to {country}...")
    try:
        _nordvpn_run("-c", "-g", country)
    except FileNotFoundError:
        print(f"[NordVPN] Executable not found: {_NORDVPN_EXE}")
        return
    except Exception as e:
        print(f"[NordVPN] Connect error: {e}")
        return
    for _ in range(15):
        time.sleep(2)
        if _nordvpn_adapter_up():
            print(f"[NordVPN] Connected to {country}")
            return
    print(f"[NordVPN] Warning: adapter not Up after 30s — continuing anyway")


def nordvpn_disconnect():
    print("[NordVPN] Disconnecting...")
    try:
        _nordvpn_run("-d", timeout=15)
    except Exception as e:
        print(f"[NordVPN] Disconnect error: {e}")
        return
    for _ in range(5):
        time.sleep(2)
        if not _nordvpn_adapter_up():
            print("[NordVPN] Disconnected")
            return
    print("[NordVPN] Warning: adapter still Up after 10s — continuing anyway")


# ── CSV helpers ───────────────────────────────────────────────────────────────

def read_codes() -> list[dict]:
    """Read email + code pairs from codes.csv."""
    rows = []
    if not CODES_CSV.exists():
        raise FileNotFoundError(f"{CODES_CSV} not found — run checkout.py first")
    with CODES_CSV.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            email = row.get("email", "").strip()
            code  = row.get("code", "").strip()
            if email and code:
                rows.append({"email": email, "code": code})
    return rows


def already_cancelled() -> set[str]:
    done: set[str] = set()
    for path in (CANCELLED_CSV, CANCEL_FAILED_CSV):
        if path.exists():
            with path.open(newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("email", "").strip():
                        done.add(row["email"].strip())
    return done


def append_result(path: Path, email: str, note: str = ""):
    write_header = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["email", "timestamp", "note"])
        writer.writerow([email, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), note])


# ── Browser helpers ───────────────────────────────────────────────────────────

def human_type(locator, text, delay_range=(80, 160)):
    locator.click()
    time.sleep(random.uniform(0.15, 0.35))
    for ch in text:
        locator.press(ch)
        time.sleep(random.randint(*delay_range) / 1000)


def wait_click(locator, timeout=TIMEOUT):
    locator.wait_for(state="visible", timeout=timeout)
    locator.scroll_into_view_if_needed()
    time.sleep(random.uniform(0.4, 0.9))
    locator.click()


def make_browser(p):
    tmp_dir = tempfile.mkdtemp(prefix="chrome_cancel_")
    kwargs = dict(
        user_data_dir=tmp_dir,
        headless=False,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--start-maximized",
        ],
        ignore_default_args=["--enable-automation"],
        no_viewport=True,
        locale="en-GB",
        timezone_id="Europe/London",
    )
    if USE_PROXY:
        kwargs["proxy"] = {
            "server":   PROXY_CONFIG["server"],
            "username": PROXY_CONFIG["username"],
            "password": PROXY_CONFIG["password"],
        }
    ctx = p.chromium.launch_persistent_context(**kwargs)
    _stealth.use_sync(ctx)
    return ctx, tmp_dir


# ── Cancellation flow ─────────────────────────────────────────────────────────

def cancel(page, email: str, code: str) -> None:
    # Step 1: Go to login page
    page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)
    time.sleep(random.uniform(2.0, 3.0))

    # Step 2: Enter email
    email_field = page.locator('input[type="email"], input[name="email"], #email')
    email_field.wait_for(state="visible", timeout=TIMEOUT)
    email_field.fill(email)
    time.sleep(0.5)

    # Step 3: Submit email / request code
    page.locator('button[type="submit"], input[type="submit"]').first.click()
    time.sleep(2.0)

    # Step 4: Enter the login code (TBCUUU style)
    code_field = page.locator('input[type="text"], input[name="code"], input[placeholder*="code" i]').first
    code_field.wait_for(state="visible", timeout=TIMEOUT)
    human_type(code_field, code)
    time.sleep(0.5)

    page.locator('button[type="submit"], input[type="submit"]').first.click()
    time.sleep(3.0)

    # Step 5: Navigate to account / subscription management
    page.goto(ACCOUNT_URL, wait_until="domcontentloaded", timeout=60_000)
    time.sleep(2.0)

    # Step 6: Find and click cancel/manage subscription
    cancel_btn = page.locator(
        'a:has-text("Cancel"), button:has-text("Cancel subscription"), '
        'a:has-text("Manage subscription"), a:has-text("Cancel plan")'
    ).first
    cancel_btn.wait_for(state="visible", timeout=TIMEOUT)
    cancel_btn.click()
    time.sleep(2.0)

    # Step 7: Confirm cancellation if prompted
    confirm = page.locator(
        'button:has-text("Confirm"), button:has-text("Yes, cancel"), '
        'button:has-text("Cancel subscription")'
    ).first
    try:
        confirm.wait_for(state="visible", timeout=10_000)
        confirm.click()
        time.sleep(2.0)
    except PWTimeout:
        pass  # Some flows don't need a second confirm

    # Verify cancellation succeeded — look for confirmation text
    try:
        page.wait_for_selector(
            'text="cancelled", text="Cancelled", text="subscription has been cancelled"',
            timeout=15_000,
        )
    except PWTimeout:
        raise RuntimeError("Cancellation confirmation not detected on page")


# ── Main loop ─────────────────────────────────────────────────────────────────

def run():
    print(f"Proxy: {'ON' if USE_PROXY else 'OFF'} | NordVPN: {NORDVPN_COUNTRY} every {NORDVPN_RECONNECT_EVERY}\n")

    entries = read_codes()
    done    = already_cancelled()
    pending = [e for e in entries if e["email"] not in done]

    print(f"Total in codes.csv: {len(entries)} | Already cancelled: {len(done)} | To process: {len(pending)}\n")
    if not pending:
        print("Nothing to cancel.")
        return

    nordvpn_connect()

    with sync_playwright() as p:
        for idx, entry in enumerate(pending, 1):
            email = entry["email"]
            code  = entry["code"]

            if idx > 1 and (idx - 1) % NORDVPN_RECONNECT_EVERY == 0:
                nordvpn_disconnect()
                nordvpn_connect()

            print(f"[{idx}/{len(pending)}] {email}  (code: {code})")

            for attempt in range(1, 4):
                ctx, tmp_dir = make_browser(p)
                page = ctx.new_page()
                try:
                    cancel(page, email, code)
                    append_result(CANCELLED_CSV, email)
                    print(f"  ✓ cancelled\n")
                    break
                except Exception as exc:
                    reason = str(exc).splitlines()[0]
                    is_network_err = any(e in reason for e in (
                        "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED",
                        "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_RESET",
                        "ERR_PROXY_CONNECTION_FAILED",
                    ))
                    if is_network_err and attempt < 3:
                        wait = 8 + attempt * 6
                        print(f"  ↻ network error (attempt {attempt}/3) — waiting {wait}s...")
                        for _ in range(30):
                            time.sleep(2)
                            if _nordvpn_adapter_up():
                                break
                        time.sleep(wait)
                        print(f"  ↻ retrying...")
                        continue
                    append_result(CANCEL_FAILED_CSV, email, reason)
                    print(f"  ✗ failed — {reason}\n")
                    traceback.print_exc()
                    break
                finally:
                    try:
                        ctx.close()
                    except Exception:
                        pass
                    shutil.rmtree(tmp_dir, ignore_errors=True)

            time.sleep(random.uniform(3.0, 6.0))

    print("Done.")
    print(f"  Cancelled → {CANCELLED_CSV}")
    print(f"  Failed    → {CANCEL_FAILED_CSV}")


if __name__ == "__main__":
    run()
