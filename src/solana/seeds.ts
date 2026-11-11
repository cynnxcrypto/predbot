/**
 * Public wallets of well-known traders on the fomo app, as enrique gave them on 11 Nov 2026 (none is ours). The
 * tracer (links.ts) looks for the other wallets behind each one. data/solana-seeds.json
 * ([{ "name": "...", "address": "..." }]) replaces this list without a code change.
 */
import type { Tracked } from "./wallets.js";

export const SEEDS: Tracked[] = [
  { name: "frankdegods", address: "498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ" },
  { name: "bronbroncore", address: "2EJPiGHWCddwUnoWoRHD3dfycjQwDV9iQceshn2HDpht" },
  { name: "joecroskey", address: "8bXzTJq3sNkzD8T1mXVCaMvg1D3CL1heYJBgSPM8WVow" },
  { name: "pointfarmcapital", address: "Beqv6dzTcjV2eodo8RRXCiCcnSYrS1vkQKhfqwHXqeit" },
];
