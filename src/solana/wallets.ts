/**
 * Wallets the copy test watches. These are public addresses of well-known traders as listed on the public
 * kolscan.io daily leaderboard on 11 Nov 2026 (not ours; we hold no wallet). A one-day leaderboard proves nothing
 * about skill: the test itself ranks them by what happens after they buy.
 * data/solana-wallets.json ([{ "name": "...", "address": "..." }]) replaces this list without a code change.
 */
export interface Tracked {
  name: string;
  address: string;
}

export const WALLETS: Tracked[] = [
  ["Chairman", "Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6"], ["gr3g", "J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA"],
  ["Schoen", "5hAgYC8TJCcEZV7LTXAzkTrm7YL29YXyQQJPCNrG84zM"], ["Dior", "87rRdssFiTJKY4MGARa4G5vQ31hmR7MxSmhzeaJ5AAxJ"],
  ["LJC", "6HJetMbdHBuk3mLUainxAPpBpWzDgYbHGTS2TqDAUSX2"], ["Mitch", "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t"],
  ["Euris", "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj"], ["Iced", "DrJ6SnDXkEsPeGdmSs93v5rwWumv5QMvAGSZjAyWSd5o"],
  ["AlxCooks", "89HbgWduLwoxcofWpmn1EiF9wEdpgkNDEyPjzZ72mkDi"], ["Kadenox", "B32QbbdDAyhvUQzjcaM5j6ZVKwjCxAwGH5Xgvb9SJqnC"],
  ["Johnson", "J9TYAsWWidbrcZybmLSfrLzryANf4CgJBLdvwdGuC8MB"], ["MAMBA", "BnfiHRDpHQ5yQevvwnzTmxtaB1Ek276fV5oTY9bi71EA"],
  ["Jeets", "D1H83ueSw5Nxy5okxH7VBfV4jRnqAK5Mm1tm3JAj3m5t"], ["Megga", "H31vEBxSJk1nQdUN11qZgZyhScyShhscKhvhZZU3dQoU"],
  ["JB", "BY58Z7N5Adarkx5ed78AzKvR7Kxrq795aa1boZsYyVBT"], ["Sheep", "78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2"],
  ["Pain", "J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa"], ["Casino", "8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR"],
  ["Ethan Prosper", "sAdNbe1cKNMDqDsa4npB3TfL62T14uAo2MsUQfLvzLT"], ["Profit", "G5nxEXuFMfV74DSnsrSatqCW32F34XUnBeq3PfDS7w5E"],
  ["Ramset", "71PCu3E4JP5RDBoY6wJteqzxkKNXLyE1byg5BTAL9UtQ"], ["Dani", "AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf"],
  ["decu", "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9"], ["clukz", "G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC"],
  ["Kev", "BTf4A2exGK9BCVDNzy65b9dUzXgMqB4weVkvTMFQsadd"], ["big bags bobby", "8oQoMhfBQnRspn7QtNAq2aPThRE4q94kLSTwaaFQvRgs"],
  ["peacefuldestroy", "8AtQ4ka3dgtrH1z4Uq3Tm4YdMN3cK5RRj1eKuGNnvenm"], ["Xanse", "B9K2wTQcRDLRLhMKFyRh2hPqHrr6VKiCC9yNGpkMUXrh"],
  ["Setsu", "2k7Mnf2K3GhpB7hEVN1CFFeV4oNzzuCS5Q6SmcfAoLHd"], ["Veloce", "2W14ahXD3XBfWJchQ4K5NLXmguWWcTTUTuHDhEzeuvP3"],
  ["Dali", "CvNiezB8hofusHCKqu8irJ6t2FKY7VjzpSckofMzk5mB"], ["Tom", "CEUA7zVoDRqRYoeHTP58UHU6TR8yvtVbeLrX1dppqoXJ"],
  ["trunoest", "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT"], ["Shawty", "387FRwow6MKDhSwuMULhKjqeXuxoBY4BbbaSntdk9LaH"],
  ["Wugi", "862TYSvRYoiHAK3F3WwTRYAfuGiQaGdxedN9AGvRGWo2"], ["Orange", "2X4H5Y9C4Fy6Pf3wpq8Q4gMvLcWvfrrwDv2bdR8AAwQv"],
  ["Boomer", "4JyenL2p8eQZAQuRS8QAASy7TzEcqAeKGha6bhiJXudh"], ["DustNukes", "FzVQSzj8JJr6WMGqbUHzx2XH1KkrfxRrRPv6WcbbZmND"],
  ["Groovy", "34ZEH778zL8ctkLwxxERLX5ZnUu6MuFyX9CWrs8kucMw"], ["dov 7", "8nqtxpFpuXwfXG4pBLsDkkuMMPK9FjSkBMCn542HiM3v"],
  ["Yami", "7Js5gmq57y9jG2sseKrAeJt3vbncSWSFFHDEsyJDnyVm"], ["Meechie", "9iaawVBEsFG35PSwd4PahwT8fYNQe9XYuRdWm872dUqY"],
  ["BULLZ", "6UwCF9JCEPRFfBKibwAoyuEZukLwzATiWRjiGnH1Eass"], ["Jack Duval", "BAr5csYtpWoNpwhUjixX7ZPHXkUciFZzjBp9uNxZXJPh"],
  ["MrDD", "9udqZzePbx3N7917LK9PzgxrDqQEQDECtLc8KTYCNghX"], ["Sizeab1e", "AtmeWwb6Y6KNDgu2dPJT5dsar84bFCbNxLiW2DyYfm8p"],
  ["AsyncDuck", "FeYVZPsDkmg3D9ddcySxLqGvAR9ES29ABZkeRcUn4FfY"], ["Otta", "As7HjL7dzzvbRbaD3WCun47robib2kmAKRXMvjHkSMB5"],
  ["J Spizzle", "4z3WtX32eehkmnaNNstZWyAuVBhj6cgpk5JtkdTa4m4A"], ["OGAntD", "215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP"],
].map(([name, address]) => ({ name, address }));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** True when the text is a 32-byte base58 address (catches a mistyped address before we subscribe to it). */
export function validAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes++;
  }
  return bytes === 32;
}
