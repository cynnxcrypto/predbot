#!/bin/bash
# Publish data/history from the server-data checkout ($1) on top of the latest server-data tip.
# Builds the commit with plumbing (no rebase), so the bot's own status commits never conflict with ours.
cd "$1" || exit 0
for i in 1 2 3 4 5 6; do
  git fetch -q --depth=1 origin server-data || { sleep $((i*5)); continue; }
  export GIT_INDEX_FILE="$PWD/.git/history-index"
  rm -f "$GIT_INDEX_FILE"
  git read-tree origin/server-data
  # --no-all: never stage deletions (each job only has part of data/history checked out)
  git add -f --no-all --sparse data/history 2>/dev/null || git add -f --no-all data/history
  tree=$(git write-tree)
  if [ "$tree" = "$(git rev-parse origin/server-data^{tree})" ]; then unset GIT_INDEX_FILE; echo "nothing to push"; exit 0; fi
  c=$(git -c user.name="history-bot" -c user.email="history-bot@users.noreply.github.com" commit-tree "$tree" -p origin/server-data -m "history: data update [skip ci]")
  unset GIT_INDEX_FILE
  if git push -q origin "$c:refs/heads/server-data"; then echo "pushed $c"; exit 0; fi
  sleep $((i*5))
done
echo "push failed"
