/**
 * The planned restart after an update (the supervisor's SIGUSR2, see src/index.ts) waits for real money that is in
 * flight: `waiting` says in plain words what a stop would cut off right now ("" = nothing). `go` is called once
 * nothing is in flight, or when `limitMs` has passed, whichever comes first, and always exactly once: nothing here
 * can keep the bot from restarting. What is still out at the limit is finished by the recovery at the next start.
 * A real server stop (SIGTERM, SIGINT) never comes through here and stays immediate.
 */
export function whenClear(waiting: () => string, go: (left: string) => void, limitMs: number, pollMs = 250, log: (m: string) => void = console.log): void {
  const until = Date.now() + limitMs;
  let said = "";
  const look = () => {
    let left = "";
    try {
      left = waiting();
    } catch {
      left = ""; // a broken check must never hold the restart
    }
    if (!left || Date.now() >= until) return go(left);
    if (left !== said) log(`restart pending: ${left}`);
    said = left;
    setTimeout(look, pollMs);
  };
  look();
}

/** No new real Solana copy this long before the planned stop: a copy lasts at most about 80 s (60 s held, plus buying, selling and counting). */
export const DRAIN_SEC = 90;
/** The supervisor forces a stop 330 s after its signal; we are gone before that whatever is out. */
const LATEST_SEC = 320;
/** How long past the planned stop the restart may wait for coins that are still out. */
export const extraSec = (waitSec: number, maxSec = 75) => Math.max(0, Math.min(maxSec, LATEST_SEC - waitSec));
