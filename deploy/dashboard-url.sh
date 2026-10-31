#!/bin/bash
# Prints the dashboard's current address (it changes when the server restarts).
url=$(sudo journalctl -u predbot-dashboard --no-pager -o cat | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
if [ -n "$url" ]; then echo "DASHBOARD: $url  (log in with any name and your dashboard password)"; else echo "No address yet, wait 10 s and run this again."; fi
