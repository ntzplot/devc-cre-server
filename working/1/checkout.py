"""
Playwright automation for xpatfone.com checkout flow.
Reads emails from emails.csv and processes them one by one.
Results are appended to success.csv / failed.csv.

Install deps:
    pip install playwright playwright-stealth
    playwright install chromium
"""

import csv
import json
import random
import re
import shutil
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
CF_WORKER_URL      = "https://yashotpreceiver.apoh59620.workers.dev"
CF_EMAILCHECK_URL  = "https://yashemailchecker.apoh59620.workers.dev"
# ─────────────────────────────────────────────────────────────────────────────


def wait_for_otp(start_time: float, email: str = "default", timeout=90) -> str | None:
    """Poll Cloudflare Worker for an OTP newer than start_time for the given Kyash email."""
    since_ms = int(start_time * 1000) - 3000  # 3s buffer for clock skew
    deadline  = time.time() + timeout
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
# ─────────────────────────────────────────────────────────────────────────────


class ThreeDSChallengeError(Exception):
    pass


# ── HARDCODED CONFIG ─────────────────────────────────────────────────────────
FIRST_NAME = "Henry"
LAST_NAME  = "Kelvin"
STREET     = "9 Sackville St"
CITY       = "Skipton"
STATE      = "London"
ZIP        = "W1S 3DN"
# ─────────────────────────────────────────────────────────────────────────────

EMAILS_CSV  = Path("emails.csv")
SUCCESS_CSV      = Path("success.csv")
SUCCESS_FULL_CSV = Path("successemailfull.csv")
FAILED_CSV       = Path("failed.csv")
CARDS_TXT        = Path("cards.txt")

START_URL = "https://xpatfone.com/pricing"
IFRAME_ID = "#cb-frame"
TIMEOUT   = 45_000  # ms


# ── CSV helpers ───────────────────────────────────────────────────────────────

def read_emails() -> tuple[list[str], dict[str, str]]:
    """Return (email_list, {email: full_line}) reading pipe-separated emails.csv."""
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
    """Return emails that already appear in success.csv or failed.csv."""
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
    """Append full line to successemailfull.csv, push to success worker and emailchecker."""
    with SUCCESS_FULL_CSV.open("a", encoding="utf-8") as f:
        f.write(full_line + "\n")
    _cf_post(f"{CF_WORKER_URL}/success", full_line)
    _cf_post(f"{CF_EMAILCHECK_URL}/import", full_line)


def post_failed_line(full_line: str):
    """Push failed full line to emailchecker worker."""
    _cf_post(f"{CF_EMAILCHECK_URL}/failed", full_line)


def append_result(path: Path, email: str, note: str = ""):
    write_header = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if write_header:
            writer.writerow(["email", "timestamp", "note"])
        writer.writerow([email, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), note])


def read_cards() -> list[dict]:
    """Read cards from cards.txt (pipe-separated, skips comment lines)."""
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
    ctx = p.chromium.launch_persistent_context(
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
    _stealth.use_sync(ctx)
    return ctx, tmp_dir


# ── 3DS challenge handler ─────────────────────────────────────────────────────

def _find_3ds_frame(page):
    """Return the frame containing the Visa 3DS challenge, or None."""
    for frame in page.frames:
        try:
            if frame.locator("#CredentialId-1a").count() > 0:
                return frame
        except Exception:
            pass
    return None


def _handle_3ds(page, kyash_email: str = "default"):
    """Wait for /thanks/ — if 3DS challenge appears, complete it via OTP."""
    deadline = time.time() + 60

    while time.time() < deadline:
        if page.url.startswith("https://xpatfone.com/thanks/"):
            return

        frame = _find_3ds_frame(page)
        if frame:
            print("  ⚠ 3DS challenge detected — selecting push notification...")
            try:
                start_time = time.time()
                # custom-radio uses a label overlay — must click the label, not the input
                label = frame.locator('label[for="CredentialId-1a"]')
                label.wait_for(state="visible", timeout=15_000)
                time.sleep(1.5)  # let page fully settle before interacting
                label.click()
                time.sleep(0.5)
                print("  ✓ Selected push notification radio")
                btn = frame.locator("#ContinueButton")
                btn.wait_for(state="visible", timeout=10_000)
                time.sleep(0.5)
                btn.click()
                print("  ✓ Clicked 次へ (Continue)")
                time.sleep(2.0)

                print("  ⏳ Waiting for OTP from Cloudflare (90s)...")
                otp = wait_for_otp(start_time=start_time, email=kyash_email, timeout=90)
                if not otp:
                    raise ThreeDSChallengeError("3DS OTP timeout — no code received in 90s")

                print(f"  📲 OTP received: {otp}")
                otp_input = frame.locator("#CredentialValidateInput")
                otp_input.wait_for(state="visible", timeout=10_000)
                otp_input.fill(otp)
                time.sleep(0.5)
                validate_btn = frame.locator("#ValidateButton")
                validate_btn.wait_for(state="visible", timeout=10_000)
                validate_btn.click()

                # Now wait for /thanks/
                page.wait_for_url("https://xpatfone.com/thanks/", timeout=30_000)
                return
            except PWTimeout:
                raise ThreeDSChallengeError("3DS completed but /thanks/ not reached")

        time.sleep(1.0)

    raise ThreeDSChallengeError("Timed out waiting for /thanks/ or 3DS challenge")


# ── Single checkout attempt ───────────────────────────────────────────────────

def checkout(page, email: str, card: dict) -> None:
    page.goto(START_URL, wait_until="networkidle")
    time.sleep(random.uniform(2.0, 3.0))

    # 1. Start Free Trial
    wait_click(page.locator('[data-cb-type="checkout"][data-cb-plan-id="devyce-solo-xpat-int"]'))

    # 2. Chargebee iframe
    iframe_el = page.wait_for_selector(IFRAME_ID, timeout=TIMEOUT)
    time.sleep(2.0)
    cb    = page.frame_locator(IFRAME_ID)
    frame = iframe_el.content_frame()

    # 3. Proceed To Checkout
    wait_click(cb.locator('[data-cb-id="cart_submit"]'))
    time.sleep(1.2)

    # 4. Email
    email_field = cb.locator("#email")
    email_field.wait_for(state="visible", timeout=TIMEOUT)
    email_field.fill(email)
    time.sleep(0.6)
    wait_click(cb.locator('[data-cb-id="auth_submit"]'))
    time.sleep(2.0)

    # 5. Billing address
    cb.locator("#first_name").wait_for(state="visible", timeout=TIMEOUT)
    human_type(cb.locator("#first_name"), FIRST_NAME)
    time.sleep(0.3)
    human_type(cb.locator("#last_name"), LAST_NAME)
    time.sleep(0.3)
    cb.locator("#line1").wait_for(state="visible", timeout=TIMEOUT)
    frame.evaluate(
        """(v) => {
            const el = document.getElementById('line1');
            el.value = v;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        STREET,
    )
    time.sleep(0.3)
    human_type(cb.locator("#city"), CITY)
    time.sleep(0.3)
    human_type(cb.locator("#state"), STATE)
    time.sleep(0.3)
    human_type(cb.locator("#zip"), ZIP)
    time.sleep(0.6)
    wait_click(cb.locator('[data-cb-id="address_submit"]'))
    time.sleep(2.5)

    # 6. Card details
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

    # Wait for review page — if 3DS challenge blocks here it won't appear
    try:
        cb.locator('[data-cb-id="review_submit"]').wait_for(state="visible", timeout=20_000)
    except PWTimeout:
        raise ThreeDSChallengeError("3DS challenge triggered after card submission — card retired")

    # 7. Review – checkboxes + subscribe
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

    # Wait for /thanks/ OR 3DS challenge iframe
    _handle_3ds(page, kyash_email=card.get("kyash_email", "default"))


# ── Main loop ─────────────────────────────────────────────────────────────────

def run():
    emails, full_lines = read_emails()
    done   = already_processed()
    pending = [e for e in emails if e not in done]
    cards   = read_cards()

    print(f"Total: {len(emails)} | Already done: {len(done)} | Pending: {len(pending)} | Cards: {len(cards)}\n")
    if not pending:
        print("Nothing to process.")
        return

    exhausted: set[int] = set()  # card indices retired due to 3DS

    with sync_playwright() as p:
        for idx, email in enumerate(pending, 1):
            # Pick next non-exhausted card serially
            card_idx = None
            for offset in range(len(cards)):
                candidate = ((idx - 1) + offset) % len(cards)
                if candidate not in exhausted:
                    card_idx = candidate
                    break
            if card_idx is None:
                print("All cards exhausted due to 3DS — stopping.")
                break
            card = cards[card_idx]
            print(f"[{idx}/{len(pending)}] {email}  (card {card_idx + 1}/{len(cards)}: ...{card['number'][-4:]})")

            ctx, tmp_dir = make_browser(p)
            page = ctx.new_page()
            try:
                checkout(page, email, card)
                append_result(SUCCESS_CSV, email)
                post_success_line(full_lines.get(email, email))
                print(f"  ✓ success\n")
            except ThreeDSChallengeError as exc:
                exhausted.add(card_idx)
                append_result(FAILED_CSV, email, str(exc))
                post_failed_line(full_lines.get(email, email))
                print(f"  ⚠ 3DS challenge — card {card_idx + 1} retired ({len(exhausted)}/{len(cards)} exhausted)\n")
            except Exception as exc:
                reason = str(exc).splitlines()[0]
                append_result(FAILED_CSV, email, reason)
                post_failed_line(full_lines.get(email, email))
                print(f"  ✗ failed — {reason}\n")
                traceback.print_exc()
            finally:
                try:
                    ctx.close()
                except Exception:
                    pass
                shutil.rmtree(tmp_dir, ignore_errors=True)
            # Short pause between accounts
            time.sleep(random.uniform(3.0, 6.0))

    print("Done.")
    print(f"  Success → {SUCCESS_CSV}")
    print(f"  Failed  → {FAILED_CSV}")


if __name__ == "__main__":
    run()
