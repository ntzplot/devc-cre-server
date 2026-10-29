# Checkout worker: Node + real Google Chrome + Xvfb + NordVPN CLI.
# The VPN lives in this container's own network namespace, so connecting it
# never touches the host's SSH / dashboard.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg xvfb procps iproute2 iptables iputils-ping \
      fonts-liberation \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y /tmp/chrome.deb \
 && wget -q -O /tmp/nordrepo.deb https://repo.nordvpn.com/deb/nordvpn/debian/pool/main/nordvpn-release_1.0.0_all.deb \
 && apt-get install -y /tmp/nordrepo.deb \
 && apt-get update && apt-get install -y nordvpn \
 && rm -rf /var/lib/apt/lists/* /tmp/*.deb

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
