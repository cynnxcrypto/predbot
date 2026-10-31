#!/bin/bash
# Run once on the server:  bash ~/predbot/deploy/dashboard-setup.sh
# Puts the dashboard behind a password and opens it to the internet through a Cloudflare tunnel (https, no AWS port to
# open). Prints the address. If the server restarts the address changes: run  bash ~/predbot/deploy/dashboard-url.sh
set -euo pipefail
cd ~/predbot
read -r -s -p "Choose a dashboard password, then press Enter: " pw; echo
[ ${#pw} -ge 8 ] || { echo "Use at least 8 characters."; exit 1; }
umask 077
python3 -c 'import json,sys; json.dump({"password": sys.argv[1]}, open("data/dashboard.json", "w"))' "$pw"
umask 022
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i /tmp/cloudflared.deb >/dev/null
fi
sudo tee /etc/systemd/system/predbot-dashboard.service >/dev/null <<UNIT
[Unit]
Description=Pred bot dashboard tunnel
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v cloudflared) tunnel --no-autoupdate --url http://127.0.0.1:8790
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable predbot-dashboard >/dev/null 2>&1
sudo systemctl restart predbot-dashboard
sudo systemctl restart predbot
sleep 12
bash ~/predbot/deploy/dashboard-url.sh
