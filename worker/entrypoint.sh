#!/bin/bash
# Start the NordVPN daemon (no systemd in containers), log in, then idle.
# The dashboard server runs checkouts with `docker exec`.
rm -f /run/nordvpn/nordvpnd.sock
/etc/init.d/nordvpn start >/dev/null 2>&1 || (nordvpnd >/var/log/nordvpnd.log 2>&1 &)

for _ in $(seq 1 30); do [ -S /run/nordvpn/nordvpnd.sock ] && break; sleep 1; done

nordvpn set analytics off >/dev/null 2>&1 || true
nordvpn set killswitch off >/dev/null 2>&1 || true
[ -n "$NORDVPN_TOKEN" ] && nordvpn login --token "$NORDVPN_TOKEN" 2>&1 | tail -1

echo "[worker] ready"
exec sleep infinity
