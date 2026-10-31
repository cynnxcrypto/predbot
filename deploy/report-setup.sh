#!/bin/bash
# Run once on the server:  bash ~/predbot/deploy/report-setup.sh
# Asks for the GitHub token (unless one is saved already), posts the first summary, then posts every 15 min (cron).
set -euo pipefail
if [ ! -s ~/.predbot-github-token ]; then
  read -r -s -p "Paste the GitHub token, then press Enter: " tok; echo
  [ -n "$tok" ] || { echo "No token pasted."; exit 1; }
  (umask 077; printf '%s\n' "$tok" > ~/.predbot-github-token)
fi
python3 ~/predbot/deploy/report.py
command -v crontab >/dev/null || { sudo apt-get install -y -qq cron >/dev/null; sudo systemctl enable --now cron >/dev/null 2>&1; }
# grep -v exits 1 on an empty crontab; `|| true` keeps set -e from dropping the new line (31 Oct 2026: the first install left cron empty).
{ crontab -l 2>/dev/null | grep -v predbot/deploy/report.py || true; echo "*/15 * * * * python3 $HOME/predbot/deploy/report.py >/dev/null 2>&1"; } | crontab -
crontab -l | grep -q predbot/deploy/report.py && echo "REPORT-OK: the server now posts its results every 15 minutes." || echo "Cron line missing, send this to Claude."
