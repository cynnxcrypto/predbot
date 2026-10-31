#!/bin/bash
# Run once on the server:  bash ~/predbot/deploy/report-setup.sh
# Asks for the GitHub token, saves it outside the repo, posts the first summary, then posts every 15 min (cron).
set -euo pipefail
read -r -s -p "Paste the GitHub token, then press Enter: " tok; echo
[ -n "$tok" ] || { echo "No token pasted."; exit 1; }
umask 077
printf '%s\n' "$tok" > ~/.predbot-github-token
python3 ~/predbot/deploy/report.py
( crontab -l 2>/dev/null | grep -v predbot/deploy/report.py; echo "*/15 * * * * python3 $HOME/predbot/deploy/report.py >/dev/null 2>&1" ) | crontab -
echo "REPORT-OK: the server now posts its results every 15 minutes."
