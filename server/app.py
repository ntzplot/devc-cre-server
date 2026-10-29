"""
XPAT Control Server
Run: python app.py
Dashboard: http://localhost:5050

pip install flask requests
"""

import csv
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

app = Flask(__name__)

BASE       = Path(__file__).parent.parent
CFG_PATH   = BASE / "config" / "config.json"
EMAILS_CSV = BASE / "1" / "emails.csv"
CARDS_TXT  = BASE / "1" / "cards.txt"
SUCCESS_CSV= BASE / "1" / "success.csv"
FAILED_CSV = BASE / "1" / "failed.csv"
CANCELLED_CSV = BASE / "1" / "cancelled.csv"
PURCHASED_TXT = BASE / "purchased.txt"

NORDVPN_EXE = r"C:\Program Files\NordVPN\NordVPN.exe"

# ── State ─────────────────────────────────────────────────────────────────────

_lock      = threading.Lock()
_proc      = None          # current running subprocess
_logs      = []            # ring buffer, last 600 lines
_log_index = 0             # total lines ever appended
_schedule  = None          # {"time": "14:00", "count": 10, "script": "js", "timer": <Timer>}

# ── Config helpers ────────────────────────────────────────────────────────────

def load_cfg() -> dict:
    try:
        return json.loads(CFG_PATH.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}

def save_cfg(data: dict):
    CFG_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

# ── Log helpers ───────────────────────────────────────────────────────────────

def _push_log(line: str):
    global _log_index
    with _lock:
        _logs.append({"i": _log_index, "t": datetime.now().strftime("%H:%M:%S"), "m": line})
        _log_index += 1
        if len(_logs) > 600:
            _logs.pop(0)

def _capture(proc):
    for raw in proc.stdout:
        _push_log(raw.rstrip())
    _push_log("── process exited ──")
    with _lock:
        global _proc
        if _proc is proc:
            _proc = None

# ── Stats helpers ─────────────────────────────────────────────────────────────

def _count_csv(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        with path.open(newline="", encoding="utf-8") as f:
            return sum(1 for row in csv.DictReader(f) if row.get("email", "").strip())
    except Exception:
        return 0

def _count_emails() -> dict:
    total, done = 0, 0
    if EMAILS_CSV.exists():
        try:
            with EMAILS_CSV.open(encoding="utf-8") as f:
                emails = [l.split("|")[0].strip() for l in f if l.strip() and not l.startswith("#")]
            total = len(emails)
            processed = set()
            for p in (SUCCESS_CSV, FAILED_CSV):
                for row in _csv_rows(p):
                    if row.get("email", "").strip():
                        processed.add(row["email"].strip())
            done = len([e for e in emails if e in processed])
        except Exception:
            pass
    return {"total": total, "done": done, "pending": max(0, total - done)}

def _csv_rows(path: Path) -> list:
    if not path.exists():
        return []
    try:
        with path.open(newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))
    except Exception:
        return []

def _count_cards() -> int:
    if not CARDS_TXT.exists():
        return 0
    try:
        return sum(1 for l in CARDS_TXT.read_text(encoding="utf-8").splitlines()
                   if l.strip() and not l.startswith("#"))
    except Exception:
        return 0

def _vpn_up() -> bool:
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-NetAdapter | Where-Object { $_.Name -like 'Nord*' -or "
             "$_.InterfaceDescription -like 'Nord*' } | Select-Object -ExpandProperty Status"],
            capture_output=True, text=True, timeout=8,
        )
        return "Up" in r.stdout
    except Exception:
        return False

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    with _lock:
        running = _proc is not None and _proc.poll() is None
        sched   = {k: v for k, v in (_schedule or {}).items() if k != "timer"} if _schedule else None
        if sched and _schedule.get("timer"):
            remaining = getattr(_schedule["timer"], "_interval", 0)
            # compute fires_at from stored target
            sched["fires_at"] = _schedule.get("fires_at", "")

    cfg    = load_cfg()
    emails = _count_emails()
    return jsonify({
        "running":       running,
        "success":       _count_csv(SUCCESS_CSV),
        "failed":        _count_csv(FAILED_CSV),
        "cancelled":     _count_csv(CANCELLED_CSV),
        "emails":        emails,
        "cards":         _count_cards(),
        "vpn_connected": _vpn_up(),
        "vpn_country":   cfg.get("nordvpn", {}).get("country", "—"),
        "proxy_on":      cfg.get("proxy", {}).get("enabled", False),
        "mail_source":   cfg.get("email_source", "hotmail"),
        "do_mail_check": cfg.get("do_mail_check", True),
        "do_cancel":     cfg.get("do_cancel", True),
        "schedule":      sched,
        "updated_at":    datetime.now().strftime("%H:%M:%S"),
    })


@app.route("/api/logs")
def api_logs():
    since = int(request.args.get("since", 0))
    with _lock:
        new_lines = [l for l in _logs if l["i"] >= since]
    return jsonify({"lines": new_lines})


@app.route("/api/config", methods=["GET"])
def api_config_get():
    return jsonify(load_cfg())


@app.route("/api/config", methods=["POST"])
def api_config_save():
    try:
        data = request.get_json(force=True)
        save_cfg(data)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/start", methods=["POST"])
def api_start():
    global _proc
    with _lock:
        if _proc and _proc.poll() is None:
            return jsonify({"error": "already running"}), 400

    body   = request.get_json(force=True) or {}
    count  = int(body.get("count", 1))
    script = body.get("script", "js")

    env = os.environ.copy()
    env["AUTO_COUNT"] = str(count)

    if script == "js":
        cmd = ["node", str(BASE / "js" / "checkout.js")]
        cwd = str(BASE / "js")
    else:
        cmd = [sys.executable, str(BASE / "1" / "checkout.py")]
        cwd = str(BASE / "1")

    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True, bufsize=1, env=env,
        )
    except FileNotFoundError as e:
        return jsonify({"error": f"Could not launch: {e}"}), 500

    with _lock:
        _proc = proc
        _logs.clear()
        global _log_index
        _log_index = 0

    _push_log(f"── started {script} checkout (count={count}) ──")
    threading.Thread(target=_capture, args=(proc,), daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/stop", methods=["POST"])
def api_stop():
    with _lock:
        proc = _proc
    if not proc or proc.poll() is not None:
        return jsonify({"error": "not running"}), 400
    proc.terminate()
    _push_log("── stopped by user ──")
    return jsonify({"ok": True})


@app.route("/api/upload/emails", methods=["POST"])
def api_upload_emails():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "no file"}), 400
    content = f.read().decode("utf-8-sig", errors="replace")
    lines   = [l.strip() for l in content.splitlines() if l.strip() and not l.startswith("#")]
    EMAILS_CSV.parent.mkdir(parents=True, exist_ok=True)
    with EMAILS_CSV.open("w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return jsonify({"ok": True, "count": len(lines)})


@app.route("/api/buy", methods=["POST"])
def api_buy():
    body = request.get_json(force=True) or {}
    qty  = int(body.get("amount", 1))
    cfg  = load_cfg()
    shop = cfg.get("shop_api", {})
    api_key    = shop.get("api_key", "")
    product_id = shop.get("product_id", "")
    base_url   = shop.get("base_url", "https://codecraftdeveloper.com/api")

    if not api_key or not product_id:
        return jsonify({"error": "shop_api not configured in config.json"}), 400

    payload = urllib.parse.urlencode({
        "action":  "buyProduct",
        "id":      product_id,
        "amount":  qty,
        "api_key": api_key,
    }).encode()

    try:
        req  = urllib.request.Request(
            f"{base_url}/buy_product",
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "User-Agent": "Mozilla/5.0"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=20)
        data = json.loads(resp.read())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    items = data.get("data", [])
    if items:
        with PURCHASED_TXT.open("a", encoding="utf-8") as fh:
            for item in items:
                fh.write(item + "\n")
        _push_log(f"[Buy] Purchased {len(items)} items — saved to purchased.txt")

    return jsonify({"ok": True, "status": data.get("status"), "items": items,
                    "trans_id": data.get("trans_id"), "msg": data.get("msg")})


@app.route("/api/schedule", methods=["POST"])
def api_schedule_set():
    global _schedule
    body   = request.get_json(force=True) or {}
    time_s = body.get("time", "")
    count  = int(body.get("count", 1))
    script = body.get("script", "js")

    try:
        target = datetime.strptime(time_s, "%H:%M").replace(
            year=datetime.now().year, month=datetime.now().month, day=datetime.now().day
        )
        if target <= datetime.now():
            target += timedelta(days=1)
        delay = (target - datetime.now()).total_seconds()
    except ValueError:
        return jsonify({"error": "invalid time format, use HH:MM"}), 400

    with _lock:
        if _schedule and _schedule.get("timer"):
            _schedule["timer"].cancel()

    def _fire():
        _push_log(f"[Schedule] Auto-starting {script} checkout (count={count})...")
        urllib.request.urlopen(
            urllib.request.Request(
                "http://127.0.0.1:5050/api/start",
                data=json.dumps({"count": count, "script": script}).encode(),
                headers={"Content-Type": "application/json"}, method="POST"
            ), timeout=10
        )

    timer = threading.Timer(delay, _fire)
    timer.daemon = True
    timer.start()

    with _lock:
        _schedule = {
            "time": time_s, "count": count, "script": script,
            "fires_at": target.strftime("%Y-%m-%d %H:%M"),
            "timer": timer,
        }

    return jsonify({"ok": True, "fires_at": target.strftime("%Y-%m-%d %H:%M"),
                    "delay_seconds": int(delay)})


@app.route("/api/schedule", methods=["DELETE"])
def api_schedule_clear():
    global _schedule
    with _lock:
        if _schedule and _schedule.get("timer"):
            _schedule["timer"].cancel()
        _schedule = None
    return jsonify({"ok": True})


@app.route("/api/vpn/connect", methods=["POST"])
def api_vpn_connect():
    cfg     = load_cfg()
    country = (request.get_json(force=True) or {}).get("country") or \
              cfg.get("nordvpn", {}).get("country", "United Kingdom")
    subprocess.Popen([NORDVPN_EXE, "-c", "-g", country])
    _push_log(f"[VPN] Connecting to {country}...")
    return jsonify({"ok": True})


@app.route("/api/vpn/disconnect", methods=["POST"])
def api_vpn_disconnect():
    subprocess.Popen([NORDVPN_EXE, "-d"])
    _push_log("[VPN] Disconnecting...")
    return jsonify({"ok": True})


if __name__ == "__main__":
    print("Dashboard → http://localhost:5050")
    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)
