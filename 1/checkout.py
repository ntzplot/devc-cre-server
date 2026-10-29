"""
Playwright automation for xpatfone.com checkout flow.
Reads emails from emails.csv (hotmail) or generates Gmail addresses.
Results appended to success.csv / failed.csv.

Install deps:
    pip install playwright playwright-stealth
    playwright install chromium
"""

import csv
import json
import os
import random
import re
import shutil
import string as _string
import subprocess
import tempfile
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
from playwright_stealth import Stealth

_stealth = Stealth()

# ── Config ────────────────────────────────────────────────────────────────────

_CONFIG_DIR = Path(__file__).parent.parent / "config"
_cfg = json.loads((_CONFIG_DIR / "config.json").read_text(encoding="utf-8-sig"))

CF_WORKER_URL           = _cfg["cf_worker_url"]
CF_EMAILCHECK_URL       = _cfg["cf_emailcheck_url"]
NORDVPN_ENABLED         = _cfg["nordvpn"].get("enabled", True)
NORDVPN_COUNTRY         = _cfg["nordvpn"]["country"]
NORDVPN_RECONNECT_EVERY = _cfg["nordvpn"]["reconnect_every"]
PROXY_CONFIG            = _cfg["proxy"]
EMAIL_SOURCE            = _cfg.get("email_source", "hotmail")
SMAIL1S_URL             = _cfg.get("smail1s", {}).get("api_url", "https://smail1s.com/get_messages")
SMAIL1S_MODE            = _cfg.get("smail1s", {}).get("mode", "roundcube")
GMAIL_API_URL           = _cfg.get("gmail", {}).get("api_url", "https://gmail-token-api.apoh59620.workers.dev/api")
GMAIL_BASE              = _cfg.get("gmail", {}).get("base", "jokertgolerty")
GMAIL_DOMAIN            = _cfg.get("gmail", {}).get("domain", "gmail.com")
ADDRESSES               = _cfg.get("addresses", [])
DO_MAIL_CHECK           = _cfg.get("do_mail_check", True)
DO_CANCEL               = _cfg.get("do_cancel", True)

# ── Paths ─────────────────────────────────────────────────────────────────────

EMAILS_CSV       = Path("emails.csv")
SUCCESS_CSV      = Path("success.csv")
SUCCESS_FULL_CSV = Path("successemailfull.csv")
FAILED_CSV       = Path("failed.csv")
CODES_CSV        = Path("codes.csv")
CARDS_TXT        = Path("cards.txt")
CANCELLED_CSV    = Path("cancelled.csv")
CANCEL_FAILED_CSV= Path("cancel_failed.csv")

START_URL   = "https://xpatfone.com/pricing"
LOGIN_URL   = "https://xpatfone.com/login"
ACCOUNT_URL = "https://xpatfone.com/account"
IFRAME_ID   = "#cb-frame"
TIMEOUT     = 45_000

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


# ── OTP poller ────────────────────────────────────────────────────────────────

def wait_for_otp(start_time: float, email: str = "default", timeout=90) -> str | None:
    since_ms = int(start_time * 1000) - 3000
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2.0)
        try:
            url = f"{CF_WORKER_URL}/otp?email={urllib.parse.quote(email)}&since={since_ms}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            resp = urllib.request.urlopen(req, timeout=5)
            body = resp.read()
            if resp.status == 200 and body:
                data = json.loads(body)
                raw = data.get("otp", "")
                if raw:
                    m = re.search(r'パスワードは(\d{6})に', raw) or re.search(r'\b(\d{6})\b', raw)
                    return m.group(1) if m else raw
        except Exception as e:
            print(f"  [CF poll error] {e}")
    return None


# ── Identity picker ───────────────────────────────────────────────────────────

def _load_names(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [l.strip() for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def pick_identity() -> dict:
    first_names = _load_names(_CONFIG_DIR / "firstname.txt")
    last_names  = _load_names(_CONFIG_DIR / "lastname.txt")
    addr = random.choice(ADDRESSES)
    return {
        "first":  random.choice(first_names),
        "last":   random.choice(last_names),
        "street": addr["street"],
        "city":   addr["city"],
        "state":  addr["state"],
        "zip":    addr["zip"],
    }


# ── CSV helpers ───────────────────────────────────────────────────────────────

class ThreeDSChallengeError(Exception):
    pass


def read_emails() -> tuple[list[str], dict[str, str]]:
    emails = []
    full_lines: dict[str, str] = {}
    with EMAILS_CSV.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            email = line.split("|")[0].strip()
            if email:
                emails.append(email)
                full_lines[email] = line
    return emails, full_lines


def already_processed() -> set[str]:
    done: set[str] = set()
    for path in (SUCCESS_CSV, FAILED_CSV):
        if path.exists():
            with path.open(newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("email", "").strip():
                        done.add(row["email"].strip())
    return done


def _cf_post(url: str, body: str):
    try:
        req = urllib.request.Request(
            url, data=body.encode("utf-8"),
            headers={"User-Agent": "Mozilla/5.0"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def post_success_line(full_line: str):
    with SUCCESS_FULL_CSV.open("a", encoding="utf-8") as f:
        f.write(full_line + "\n")
    _cf_post(f"{CF_WORKER_URL}/success", full_line)
    _cf_post(f"{CF_EMAILCHECK_URL}/import", full_line)


def post_failed_line(full_line: str):
    _cf_post(f"{CF_EMAILCHECK_URL}/failed", full_line)


def append_result(path: Path, email: str, note: str = ""):
    write_header = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["email", "timestamp", "note"])
        writer.writerow([email, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), note])


def read_cards() -> list[dict]:
    cards = []
    with CARDS_TXT.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 6:
                cards.append({
                    "first": parts[0], "last": parts[1],
                    "number": parts[2], "exp_month": parts[3],
                    "exp_year": parts[4], "cvv": parts[5],
                    "kyash_email": parts[6] if len(parts) > 6 else "default",
                })
    if not cards:
        raise ValueError("cards.txt is empty or has no valid entries")
    return cards


def append_code(email: str, code: str):
    write_header = not CODES_CSV.exists()
    with CODES_CSV.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["email", "code", "timestamp"])
        writer.writerow([email, code, datetime.now().strftime("%Y-%m-%d %H:%M:%S")])


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
    tmp_dir = tempfile.mkdtemp(prefix="chrome_tmp_")
    kwargs = dict(
        user_data_dir=tmp_dir,
        headless=False,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--start-maximized",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-notifications",
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


# ── 3DS challenge handler ─────────────────────────────────────────────────────

def _find_3ds_frame(page):
    for frame in page.frames:
        try:
            if frame.locator("#CredentialId-1a").count() > 0:
                return frame
        except Exception:
            pass
    return None


def _handle_3ds(page, kyash_email: str = "default"):
    deadline = time.time() + 60
    while time.time() < deadline:
        if page.url.startswith("https://xpatfone.com/thanks/"):
            return
        frame = _find_3ds_frame(page)
        if frame:
            print("  ⚠ 3DS detected — selecting push notification...")
            try:
                start_time = time.time()
                label = frame.locator('label[for="CredentialId-1a"]')
                label.wait_for(state="visible", timeout=15_000)
                time.sleep(1.5)
                label.click()
                time.sleep(0.5)
                btn = frame.locator("#ContinueButton")
                btn.wait_for(state="visible", timeout=10_000)
                time.sleep(0.5)
                btn.click()
                time.sleep(2.0)
                print("  ⏳ Waiting for OTP (90s)...")
                otp = wait_for_otp(start_time=start_time, email=kyash_email, timeout=90)
                if not otp:
                    raise ThreeDSChallengeError("3DS OTP timeout — no code in 90s")
                print(f"  📲 OTP: {otp}")
                otp_input = frame.locator("#CredentialValidateInput")
                otp_input.wait_for(state="visible", timeout=10_000)
                otp_input.fill(otp)
                time.sleep(0.5)
                validate_btn = frame.locator("#ValidateButton")
                validate_btn.wait_for(state="visible", timeout=10_000)
                validate_btn.click()
                page.wait_for_url("https://xpatfone.com/thanks/", timeout=30_000)
                return
            except PWTimeout:
                raise ThreeDSChallengeError("3DS completed but /thanks/ not reached")
        time.sleep(1.0)
    raise ThreeDSChallengeError("Timed out waiting for /thanks/ or 3DS challenge")


# ── Checkout ──────────────────────────────────────────────────────────────────

def checkout(page, email: str, card: dict, identity: dict) -> None:
    page.goto(START_URL, wait_until="domcontentloaded", timeout=60_000)
    time.sleep(random.uniform(2.0, 3.0))

    wait_click(page.locator('[data-cb-type="checkout"][data-cb-plan-id="devyce-solo-xpat-int"]'))

    iframe_el = page.wait_for_selector(IFRAME_ID, timeout=TIMEOUT)
    time.sleep(2.0)
    cb    = page.frame_locator(IFRAME_ID)
    frame = iframe_el.content_frame()

    wait_click(cb.locator('[data-cb-id="cart_submit"]'))
    time.sleep(1.2)

    email_field = cb.locator("#email")
    email_field.wait_for(state="visible", timeout=TIMEOUT)
    email_field.fill(email)
    time.sleep(0.6)
    wait_click(cb.locator('[data-cb-id="auth_submit"]'))
    time.sleep(2.0)

    cb.locator("#first_name").wait_for(state="visible", timeout=TIMEOUT)
    human_type(cb.locator("#first_name"), identity["first"])
    time.sleep(0.3)
    human_type(cb.locator("#last_name"), identity["last"])
    time.sleep(0.3)
    cb.locator("#line1").wait_for(state="visible", timeout=TIMEOUT)
    frame.evaluate(
        """(v) => {
            const el = document.getElementById('line1');
            el.value = v;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        identity["street"],
    )
    time.sleep(0.3)
    human_type(cb.locator("#city"),  identity["city"])
    time.sleep(0.3)
    human_type(cb.locator("#state"), identity["state"])
    time.sleep(0.3)
    human_type(cb.locator("#zip"),   identity["zip"])
    time.sleep(0.6)
    wait_click(cb.locator('[data-cb-id="address_submit"]'))
    time.sleep(2.5)

    fn = cb.locator('input[autocomplete="cc-given-name"]')
    fn.wait_for(state="visible", timeout=TIMEOUT)
    time.sleep(random.uniform(0.8, 1.5))
    human_type(fn, card["first"])
    time.sleep(random.uniform(0.4, 0.8))
    human_type(cb.locator('input[autocomplete="cc-family-name"]'), card["last"])
    time.sleep(random.uniform(0.6, 1.2))
    cb.locator("#number").fill(card["number"])
    time.sleep(random.uniform(0.5, 1.0))
    cb.locator("#exp_month").fill(card["exp_month"])
    time.sleep(random.uniform(0.3, 0.6))
    cb.locator("#exp_year").fill(card["exp_year"])
    time.sleep(random.uniform(0.4, 0.8))
    cb.locator("#cvv").fill(card["cvv"])
    time.sleep(random.uniform(1.0, 2.0))
    wait_click(cb.locator('[data-cb-id="card_payment_submit"]'))

    try:
        cb.locator('[data-cb-id="review_submit"]').wait_for(state="visible", timeout=20_000)
    except PWTimeout:
        raise ThreeDSChallengeError("3DS triggered after card — card retired")

    mkt = cb.locator("#cs_email_marketing")
    try:
        mkt.wait_for(state="visible", timeout=5_000)
        if not mkt.is_checked():
            mkt.check()
    except PWTimeout:
        pass

    tos = cb.locator("#tos_agreed_1")
    tos.wait_for(state="visible", timeout=TIMEOUT)
    if not tos.is_checked():
        tos.check()

    time.sleep(0.8)
    wait_click(cb.locator('[data-cb-id="review_submit"]'))
    _handle_3ds(page, kyash_email=card.get("kyash_email", "default"))


# ── Email generation & inbox polling ─────────────────────────────────────────

GMAIL_MODE     = _cfg.get("gmail", {}).get("email_mode", "both")
USED_DOTS_FILE = Path(__file__).parent / "used_dots.txt"


def _dot_variants(base: str) -> list[str]:
    return [f"{base[:i]}.{base[i:]}" for i in range(1, len(base))]


def _load_used_dots() -> set[str]:
    if USED_DOTS_FILE.exists():
        return {l.strip() for l in USED_DOTS_FILE.read_text(encoding="utf-8").splitlines() if l.strip()}
    return set()


def _mark_dot_used(email: str):
    with USED_DOTS_FILE.open("a", encoding="utf-8") as f:
        f.write(email + "\n")


def generate_email() -> str:
    if GMAIL_MODE in ("dot", "both"):
        variants = _dot_variants(GMAIL_BASE)
        used     = _load_used_dots()
        unused   = [v for v in variants if f"{v}@{GMAIL_DOMAIN}" not in used]
        if unused:
            local = random.choice(unused)
            email = f"{local}@{GMAIL_DOMAIN}"
            _mark_dot_used(email)
            return email
        if GMAIL_MODE == "dot":
            raise RuntimeError(f"All {len(variants)} dot variants exhausted")
    suffix = ''.join(random.choices(_string.ascii_lowercase, k=random.randint(4, 5)))
    return f"{GMAIL_BASE}+{suffix}@{GMAIL_DOMAIN}"


def fetch_devyce_code(email: str, credentials: str = "", timeout: int = 120) -> str | None:
    deadline = time.time() + timeout

    if EMAIL_SOURCE == "hotmail":
        creds   = credentials or email
        payload = json.dumps({"mode": SMAIL1S_MODE, "data": creds}).encode()
        while time.time() < deadline:
            time.sleep(5)
            try:
                req = urllib.request.Request(
                    SMAIL1S_URL, data=payload,
                    headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
                    method="POST",
                )
                resp = urllib.request.urlopen(req, timeout=15)
                data = json.loads(resp.read())
                for acct in data.get("data", []):
                    for msg in acct.get("messages", []):
                        body = msg.get("message", "")
                        if "Login using your code" in body:
                            m = re.search(r'Login using your code[:\s\r\n*]+([A-Z0-9]{4,10})', body)
                            if m:
                                return m.group(1).strip()
                            code = msg.get("code", "")
                            if code and re.match(r'^[A-Z0-9]{4,10}$', code):
                                return code
            except Exception as exc:
                print(f"  [smail1s poll] {exc}")
        return None

    url = f"{GMAIL_API_URL}/emails?email={urllib.parse.quote(email)}"
    while time.time() < deadline:
        time.sleep(5)
        try:
            req  = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            resp = urllib.request.urlopen(req, timeout=10)
            data = json.loads(resp.read())
            for msg in data.get("data", {}).get("emails", []):
                body = msg.get("body", "")
                m = re.search(r'Login using your code[:\s\r\n*]+([A-Z0-9]{4,10})', body)
                if m:
                    return m.group(1).strip()
        except Exception as exc:
            print(f"  [Gmail poll] {exc}")
    return None


# ── Cancel subscription ───────────────────────────────────────────────────────

def cancel_subscription(p, email: str, code: str) -> None:
    ctx, tmp_dir = make_browser(p)
    page = ctx.new_page()
    try:
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60_000)
        time.sleep(random.uniform(2.0, 3.0))

        email_field = page.locator('input[type="email"], input[name="email"], #email').first
        email_field.wait_for(state="visible", timeout=TIMEOUT)
        email_field.fill(email)
        time.sleep(0.5)
        page.locator('button[type="submit"], input[type="submit"]').first.click()
        time.sleep(2.0)

        code_field = page.locator(
            'input[type="text"], input[name="code"], input[placeholder*="code" i]'
        ).first
        code_field.wait_for(state="visible", timeout=TIMEOUT)
        human_type(code_field, code)
        time.sleep(0.5)
        page.locator('button[type="submit"], input[type="submit"]').first.click()
        time.sleep(3.0)

        page.goto(ACCOUNT_URL, wait_until="domcontentloaded", timeout=60_000)
        time.sleep(2.0)

        cancel_btn = page.locator(
            'a:has-text("Cancel"), button:has-text("Cancel subscription"), '
            'a:has-text("Manage subscription"), a:has-text("Cancel plan")'
        ).first
        cancel_btn.wait_for(state="visible", timeout=TIMEOUT)
        cancel_btn.click()
        time.sleep(2.0)

        confirm = page.locator(
            'button:has-text("Confirm"), button:has-text("Yes, cancel"), '
            'button:has-text("Cancel subscription")'
        ).first
        try:
            confirm.wait_for(state="visible", timeout=10_000)
            confirm.click()
            time.sleep(2.0)
        except PWTimeout:
            pass

        try:
            page.wait_for_selector(
                'text=cancelled, text=Cancelled, text=subscription has been cancelled',
                timeout=15_000,
            )
        except PWTimeout:
            raise RuntimeError("Cancellation confirmation not found on page")
    finally:
        try:
            ctx.close()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ── Main loop ─────────────────────────────────────────────────────────────────

def run():
    vpn_status = f"{NORDVPN_COUNTRY} every {NORDVPN_RECONNECT_EVERY}" if NORDVPN_ENABLED else "OFF"
    print(f"Source: {EMAIL_SOURCE.upper()} | Proxy: {'ON' if USE_PROXY else 'OFF'} | NordVPN: {vpn_status}")
    print(f"Mail check: {'ON' if DO_MAIL_CHECK else 'OFF'} | Auto-cancel: {'ON' if DO_CANCEL else 'OFF'}")
    print(f"Addresses: {len(ADDRESSES)} | Names: {len(_load_names(_CONFIG_DIR / 'firstname.txt'))} first / {len(_load_names(_CONFIG_DIR / 'lastname.txt'))} last\n")

    done  = already_processed()
    cards = read_cards()

    _auto_count = int(os.environ.get("AUTO_COUNT", "0") or "0")

    if EMAIL_SOURCE == "hotmail":
        emails_list, full_lines = read_emails()
        pending = [e for e in emails_list if e not in done]
        if _auto_count > 0:
            pending = pending[:_auto_count]
        print(f"Hotmail: {len(emails_list)} total | Done: {len(done)} | Pending: {len(pending)} | Cards: {len(cards)}\n")
    else:
        full_lines: dict[str, str] = {}
        if _auto_count > 0:
            count = _auto_count
            print(f"[Auto] Count: {count}")
        else:
            while True:
                raw = input("How many emails to generate? ").strip()
                if raw.isdigit() and int(raw) > 0:
                    count = int(raw)
                    break
                print("Enter a number greater than 0.")
        print(f"\n[Gmail] Generating {count} emails...")
        pending = []
        for _ in range(count):
            try:
                email = generate_email()
                if email not in done:
                    pending.append(email)
            except Exception as exc:
                print(f"  [Gmail] Generate error: {exc}")
        print(f"Generated: {len(pending)} fresh | Cards: {len(cards)}\n")

    if not pending:
        print("Nothing to process.")
        return

    if NORDVPN_ENABLED:
        nordvpn_connect()

    exhausted: set[int] = set()

    with sync_playwright() as p:
        for idx, email in enumerate(pending, 1):
            if NORDVPN_ENABLED and idx > 1 and (idx - 1) % NORDVPN_RECONNECT_EVERY == 0:
                nordvpn_disconnect()
                nordvpn_connect()

            card_idx = None
            for offset in range(len(cards)):
                candidate = ((idx - 1) + offset) % len(cards)
                if candidate not in exhausted:
                    card_idx = candidate
                    break
            if card_idx is None:
                print("All cards exhausted — stopping.")
                break

            card     = cards[card_idx]
            identity = pick_identity()
            print(
                f"[{idx}/{len(pending)}] {email}"
                f"  name: {identity['first']} {identity['last']}"
                f"  addr: {identity['city']} {identity['zip']}"
                f"  card: ...{card['number'][-4:]}"
            )

            for attempt in range(1, 4):
                ctx, tmp_dir = make_browser(p)
                page = ctx.new_page()
                try:
                    checkout(page, email, card, identity)
                    append_result(SUCCESS_CSV, email)
                    creds = full_lines.get(email, email)
                    post_success_line(creds)
                    print("  ✓ checkout success")

                    if DO_MAIL_CHECK:
                        print("  📩 Fetching Devyce code...")
                        code = fetch_devyce_code(email, credentials=creds)
                        if code:
                            append_code(email, code)
                            print(f"  📧 Code: {code}")
                            if DO_CANCEL:
                                print("  🔄 Cancelling subscription...")
                                try:
                                    cancel_subscription(p, email, code)
                                    append_result(CANCELLED_CSV, email)
                                    print("  ✓ cancelled\n")
                                except Exception as cancel_exc:
                                    append_result(CANCEL_FAILED_CSV, email, str(cancel_exc).splitlines()[0])
                                    print(f"  ⚠ cancel failed — {cancel_exc}\n")
                            else:
                                print("  ⏭ cancel skipped (do_cancel=false)\n")
                        else:
                            print("  ⚠ Code not received within timeout\n")
                    else:
                        print("  ⏭ mail check skipped (do_mail_check=false)\n")

                    break

                except ThreeDSChallengeError as exc:
                    exhausted.add(card_idx)
                    append_result(FAILED_CSV, email, str(exc))
                    post_failed_line(email)
                    print(f"  ⚠ 3DS — card {card_idx + 1} retired ({len(exhausted)}/{len(cards)})\n")
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
                        if NORDVPN_ENABLED:
                            for _ in range(30):
                                time.sleep(2)
                                if _nordvpn_adapter_up():
                                    break
                        time.sleep(wait)
                        print("  ↻ retrying...")
                        continue
                    append_result(FAILED_CSV, email, reason)
                    post_failed_line(email)
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
    print(f"  Success → {SUCCESS_CSV}")
    print(f"  Failed  → {FAILED_CSV}")


if __name__ == "__main__":
    run()
