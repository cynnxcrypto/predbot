#!/bin/bash
# Double-click this on the Mac. It updates itself from GitHub, installs once, and runs the bot.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install version 22 or newer from https://nodejs.org and double-click this again."
  read -r -p "Press return to close."; exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is missing. Run: xcode-select --install   then double-click this again."
  read -r -p "Press return to close."; exit 1
fi
git pull --ff-only --quiet origin main 2>/dev/null || echo "Could not check GitHub right now. Starting the version already here."
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing. This takes a minute the first time."
  npm ci --no-audit --no-fund || { echo "Install failed."; read -r -p "Press return to close."; exit 1; }
fi
( sleep 3; open "http://127.0.0.1:8790/" ) &
echo "Pred bot is running. Leave this window open. Closing it stops the bot."
npm start
