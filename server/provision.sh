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
  nordvpn whitelist add port 22 >/dev/null 2>&1 || true
  nordvpn whitelist add port 5050 >/dev/null 2>&1 || true
  nordvpn set killswitch off >/dev/null 2>&1 || true
fi
echo "[setup] done: $(google-chrome --version)"
