#!/bin/bash
# Idempotent VPS provisioning: Xvfb + Google Chrome + checkout deps. Run as root.
set -e
export DEBIAN_FRONTEND=noninteractive
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v xvfb-run >/dev/null; then
  echo "[setup] installing xvfb"
  apt-get update -y && apt-get install -y xvfb wget gnupg
fi
if ! command -v google-chrome >/dev/null; then
  echo "[setup] installing Google Chrome"
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y /tmp/chrome.deb
fi
if [ ! -d "$HERE/../js/node_modules/patchright" ]; then
  echo "[setup] npm install (js)"
  (cd "$HERE/../js" && npm install)
fi
# keep SSH + dashboard reachable when NordVPN connects
if command -v nordvpn >/dev/null; then
  for p in 22 5050; do
    nordvpn allowlist add port $p >/dev/null 2>&1 || nordvpn whitelist add port $p >/dev/null 2>&1 || true
  done
  nordvpn set killswitch off >/dev/null 2>&1 || true
fi
echo "[setup] done: $(google-chrome --version)"
