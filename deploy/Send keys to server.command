#!/bin/bash
# Double-click on the Mac. Puts one command on the clipboard that writes the three key files on the AWS server
# (paste it into the server's browser terminal), then sets the Mac's live.json to "off" so only the server
# trades and claims wins. The keys never leave this Mac except through your clipboard.
cd "$(dirname "$0")/../data" || { echo "No data folder next to deploy/"; read -r; exit 1; }
cmd="mkdir -p ~/predbot/data && cd ~/predbot/data"
for f in polygon-keys.json polygon-builder.json live.json; do
  [ -f "$f" ] || { echo "Missing data/$f"; read -r; exit 1; }
  # The server's live.json takes its rules from deploy/live-rules.json in git ("rules": "repo"), so Claude can change them.
  if [ "$f" = live.json ]; then b=$(sed '1s/{/{ "rules": "repo",/' "$f" | base64 | tr -d '\n'); else b=$(base64 < "$f" | tr -d '\n'); fi
  cmd="$cmd && echo $b | base64 -d > $f"
done
cmd="$cmd && chmod 600 polygon-keys.json polygon-builder.json live.json && echo KEYS-OK"
printf '%s\n' "$cmd" | pbcopy
sed -i '' 's/"mode": *"live"/"mode": "off"/' live.json
echo "Copied to the clipboard. Paste it into the server terminal and press Enter: you should see KEYS-OK."
echo "The Mac's live.json is now \"off\" (the Mac no longer trades or claims)."
read -r -p "Press Enter to close."
