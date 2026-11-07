#!/bin/bash
# Used by .github/workflows/history.yml. Args are passed to collect.py pm.
set -u
here=$(cd "$(dirname "$0")" && pwd)
sd="$here/../sd"
if [ ! -d "$sd/.git" ]; then
  git clone -q --depth 1 --filter=blob:none --sparse --branch server-data "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "$sd"
  # only what the collector reads back: state, results, temperature market files (for the station list)
  git -C "$sd" sparse-checkout set --no-cone '/data/history/*' '!/data/history/*/' '/data/history/results/' '/data/history/pm/temperature/' '/data/history/pm/weather_other/'
fi
export OUT="$sd/data/history"
mkdir -p "$OUT"
exec > >(tee "$OUT/last-run.log") 2>&1
echo "run start $(date -u +%FT%TZ) args: $*"
FILLS=${FILLS:-off} python3 "$here/collect.py" pm --commit-cmd "bash $here/push.sh $sd" "$@"
python3 "$here/collect.py" results
cp "$here/README.md" "$OUT/README.md" 2>/dev/null || true
bash "$here/push.sh" "$sd"
# Backfill not finished: chain the next run now instead of waiting for the 6-hourly cron.
if grep -q "budget reached" "$OUT/last-run.log" && [ -n "${GH_TOKEN:-}" ]; then
  gh workflow run market-history --ref main -R "$GITHUB_REPOSITORY" && echo "chained next backfill run"
fi
