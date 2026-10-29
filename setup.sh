#!/bin/bash
# XPAT Server — VPS Setup Script
# Run on Ubuntu VPS as root: bash setup.sh

set -e

echo "==> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git

echo "==> Installing PM2..."
npm install -g pm2

echo "==> Cloning repo..."
cd /root
if [ -d "devc-cre-server" ]; then
  echo "Repo exists, pulling latest..."
  cd devc-cre-server && git pull origin main
else
  git clone https://github.com/ntzplot/devc-cre-server.git
  cd devc-cre-server
fi

echo "==> Installing server dependencies..."
cd server
npm install

echo "==> Starting with PM2..."
pm2 delete xpat 2>/dev/null || true
DEPLOY_TOKEN=xpat_deploy pm2 start app.js --name xpat
pm2 save

echo "==> Enabling PM2 on boot..."
pm2 startup | tail -1 | bash

echo "==> Opening firewall port 5050..."
ufw allow 5050/tcp 2>/dev/null || true
ufw allow OpenSSH   2>/dev/null || true
ufw --force enable  2>/dev/null || true

echo ""
echo "✓ Done! Dashboard: http://$(curl -s ifconfig.me):5050"
echo "✓ Auto-deploy webhook: http://$(curl -s ifconfig.me):5050/api/update?token=xpat_deploy"
