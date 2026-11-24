/**
 * Skill or luck for the copied Polymarket wallets, PAPER ONLY (22 Nov 2026, enrique: "yeah" to a second ranking beside
 * the current bar; nothing live reads it). The live bar is "40+ settled, half won, ahead" (src/copyscan.ts), and the
 * 20 Nov bar tests found it picks no winners: wallets that passed it lost -3.2% per dollar on the copies after. Half
 * won means little when most bets are favourites, and "ahead" is often one ticket.
 *
 * On each wallet's settled, fillable paper copies (copy-take-<name>), each as its result per dollar staked:
 *  - t: the average per-dollar result over its standard error; passes at 2+ (a 1-in-40 fluke for a wallet with none);
 *  - noBest3: still ahead without its best 3 copies;
 *  - periodsAhead: the wallet's copies cut into 3 equal stretches of time, ahead in at least 2.
 * Shown beside whether the live bar is met, and what the passing wallets made together.
 */
import { sumWithoutBest, tStat } from "./hyperliquid/skill.js";

export const PM_SKILL_MIN_N = 40;
export const PM_SKILL_MIN_T = 2;
/** The last ranking worked out (the paper loop refreshes it every 5 minutes): wallet name -> pass and t. */
let lastSkill = new Map<string, { pass: boolean; t: number }>();
/** Proven tier: the wallet of this copy rule passes the skill test at minT+ standard errors (null map = none yet). */
export const copyProven = (rule: string, minT: number) => {
  if (!(minT > 0)) return false;
  const s = lastSkill.get(rule.replace(/^copy-take-/, ""));
  return !!s && s.pass && s.t >= minT;
};
export const _skillTest = { set: (m: Record<string, { pass: boolean; t: number }>) => void (lastSkill = new Map(Object.entries(m))) };

type Copy = { rule: string; t: number; cost: number; pnl?: number | null; won?: boolean | null; fillable: boolean };
const r = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function walletSkill(xs: Copy[]) {
  const s = xs.filter((x) => x.pnl != null && x.fillable !== false && x.cost > 0).sort((a, b) => a.t - b.t);
  const per = s.map((x) => x.pnl! / x.cost);
  const net = s.reduce((a, x) => a + x.pnl!, 0);
  const cost = s.reduce((a, x) => a + x.cost, 0);
  const won = s.filter((x) => x.won === true).length;
  let periodsAhead = 0;
  if (s.length) {
    const t0 = s[0].t;
    const span = (s[s.length - 1].t - t0) / 3 || 1;
    for (let p = 0; p < 3; p++) {
      const ps = s.filter((x) => (p === 2 ? x.t >= t0 + p * span : x.t >= t0 + p * span && x.t < t0 + (p + 1) * span));
      if (ps.length && ps.reduce((a, x) => a + x.pnl!, 0) > 0) periodsAhead++;
    }
  }
  const t = tStat(per);
  const noBest3 = sumWithoutBest(s.map((x) => x.pnl!));
  const liveBar = s.length >= PM_SKILL_MIN_N && won * 2 >= s.length && net > 0;
  const why =
    s.length < PM_SKILL_MIN_N ? `under ${PM_SKILL_MIN_N} settled`
    : t < PM_SKILL_MIN_T ? `under ${PM_SKILL_MIN_T} standard errors`
    : !(noBest3 > 0) ? "behind without its best 3"
    : periodsAhead < 2 ? "ahead in under 2 of 3 periods"
    : "";
  return { n: s.length, won, net: r(net), perDollarPct: cost ? r((net / cost) * 100, 1) : null, t: r(t), noBest3: r(noBest3), periodsAhead, liveBar, pass: !why, why: why || "passes" };
}

/** Every copied wallet's paper copies (copy-take-<name>) put through walletSkill, best t first. */
export function copySkillSummary(trades: Copy[]) {
  const by = new Map<string, Copy[]>();
  for (const x of trades) {
    if (!x.rule.startsWith("copy-take-")) continue;
    const k = x.rule.slice(10);
    const l = by.get(k);
    if (l) l.push(x);
    else by.set(k, [x]);
  }
  const rows = [...by.entries()].map(([name, xs]) => ({ name, ...walletSkill(xs) }));
  lastSkill = new Map(rows.map((x) => [x.name, { pass: x.pass, t: x.t }]));
  const judged = rows.filter((x) => x.n >= PM_SKILL_MIN_N);
  const why: Record<string, number> = {};
  for (const x of judged) why[x.why] = (why[x.why] ?? 0) + 1;
  const sum = (xs: typeof rows) => ({ wallets: xs.length, copies: xs.reduce((a, x) => a + x.n, 0), net: r(xs.reduce((a, x) => a + x.net, 0)) });
  return {
    note: `PAPER ONLY, nothing live reads this. Each wallet's settled paper copies (copy-take), each as a result per dollar. Passes: ${PM_SKILL_MIN_N}+ settled, average per dollar ${PM_SKILL_MIN_T}+ standard errors above 0, ahead without its best 3 copies, ahead in 2 of 3 equal stretches of time. liveBar = the current bar (${PM_SKILL_MIN_N}+, half won, ahead). The numbers are on the same copies that picked them, so a pass is a candidate, not proof: what counts is the copies after it passed.`,
    wallets: rows.length,
    judged: judged.length,
    pass: sum(judged.filter((x) => x.pass)),
    liveBar: sum(judged.filter((x) => x.liveBar)),
    liveBarButFail: sum(judged.filter((x) => x.liveBar && !x.pass)),
    whyNot: why,
    top: [...judged].sort((a, b) => b.t - a.t).slice(0, 30),
  };
}
