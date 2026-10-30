#!/bin/bash
# Sets Pred bot up on a fresh Ubuntu server (AWS Dublin, eu-west-1). Paste into the server's browser terminal:
#   curl -fsSL https://raw.githubusercontent.com/cynnxcrypto/predbot/main/deploy/server-setup.sh | bash
# Safe to run again. No keys are installed: without data/polygon-keys.json and data/live.json the bot only records
# and paper-trades. Real trading starts only after enrique copies those two files over and the Mac is switched off.
set -euo pipefail
DIR="$HOME/predbot"

echo "== Installing git and Node.js 22"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "== Getting the bot"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only --quiet origin main; else git clone --quiet https://github.com/cynnxcrypto/predbot.git "$DIR"; fi
cd "$DIR"
npm ci --no-audit --no-fund --silent
mkdir -p data
chmod 700 data

echo "== Running it as a service (starts on boot, restarts if it stops)"
sudo tee /etc/systemd/system/predbot.service >/dev/null <<UNIT
[Unit]
Description=Pred bot
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
Environment=TZ=Asia/Seoul
ExecStart=$(command -v npm) start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now predbot >/dev/null 2>&1
sudo systemctl restart predbot

echo "== Checks"
echo -n "Polymarket geoblock says: "; curl -s https://polymarket.com/api/geoblock; echo
echo -n "Round trips to the order server (cold, then warm), seconds: "
curl -s -o /dev/null -o /dev/null -w "%{time_total} " https://clob.polymarket.com/time https://clob.polymarket.com/time; echo
sleep 5
systemctl is-active predbot >/dev/null && echo "Pred bot is RUNNING." || { echo "Pred bot did not start:"; sudo journalctl -u predbot -n 30 --no-pager; }
echo "Copy everything from 'Polymarket geoblock says' down and send it to Claude."
