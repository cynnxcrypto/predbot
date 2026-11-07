#!/bin/bash
# Commit data/history in the server-data checkout ($1) and push, rebasing on the bot's own status commits.
cd "$1" || exit 0
git add -A -f data/history
git diff --cached --quiet && exit 0
git -c user.name="history-bot" -c user.email="history-bot@users.noreply.github.com" commit -qm "history: data update [skip ci]"
for i in 1 2 3 4 5; do
  git fetch -q --depth=50 origin server-data && git rebase -q origin/server-data && git push -q origin HEAD:server-data && { echo "pushed"; exit 0; }
  sleep $((i*5))
done
echo "push failed"
