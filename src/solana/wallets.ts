/**
 * Wallets the copy test watches. These are public addresses of well-known traders: the first 50 as listed on the
 * public kolscan.io daily leaderboard on 11 Nov 2026, the rest from public pages named below (none is ours). A one-day leaderboard proves nothing
 * about skill: the test itself ranks them by what happens after they buy.
 * data/solana-wallets.json ([{ "name": "...", "address": "..." }]) replaces this list without a code change.
 */
export interface Tracked {
  name: string;
  address: string;
  /** found by the wallet finder (discover.ts), not from a list: watched on paper only */
  found?: boolean;
  /** a fomo-app trader's own wallet (seeds.ts): its buys are paid in dollars and signed by fomo's relayer. Paper only. */
  fomo?: boolean;
  /** its dollar token accounts, once known: a relayed trade may name only these, not the wallet */
  accounts?: string[];
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
  // added 11 Nov 2026 16:40 KST (enrique: "can we do more?"): rest of the kolscan daily list, plus traders listed on
  // madeonsol.com's public KOL tracker, daily reports and its "scouts" page (wallets whose first buy other tracked
  // traders tend to follow). Public addresses only; some may be stale. The test ranks them itself.
  ["Unipcs", "5M8ACGKEXG1ojKDTMH3sMqhTihTgHYMSsZc6W8i7QW3Y"], ["Beaver", "GM7Hrz2bDq33ezMtL6KGidSWZXMWgZ6qBuugkb5H8NvN"],
  ["Gake", "DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm"], ["Art", "CgaA9a1JwAXJyfHuvZ7VW8YfTVRkdiT5mjBBSKcg7Rz5"],
  ["Lynk", "CkPFGv2Wv1vwdWjtXioEgb8jhZQfs3eVZez3QCetu7xD"], ["Doji", "5ZuV8eqkvzYFVEKbLvGBdexL2tFv7E5BCd2HZpjqbdg"],
  ["Loopierr", "9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL"], ["Esee", "4uCT4g7YHH4xxfmfNfKUDenwGrRNGoZ9Ay1XFxfUGhQG"],
  ["King", "69z4qTgQ5DBRTJvnQzx2h8jZhNsv5UgADotEwwKUm2JS"], ["Mel", "36A6mEN5rYJdVTb6fMqVvG6ez8g2mTYdr1omWcQ1kDKG"],
  ["Fashr", "719sfKUjiMThumTt2u39VMGn612BZyCcwbM5Pe8SqFYz"], ["oreonsol", "9P9aAh3kdMK651CcDG4iCdoByYj1FJgKq3yVoPrXVCAu"],
  ["Qavec", "gangJEP5geDHjPVRhDS5dTF5e6GtRvtNogMEEVs91RV"], ["Fear", "9zP41CjVAASEvJ6SKveAYfCARMXLd47nhZs7MYTRcehE"],
  ["Coler", "99xnE2zEFi8YhmKDaikc1EvH6ELTQJppnqUwMzmpLXrs"], ["Bilngineer", "HFGiUYGvaAAorLn1Rjyugt8uaXDhTRnEtpdrrwdrPpws"],
  ["Alpha wallet 4", "5fM9cY5GMo8QtTmxuvNx7bWFUoNhdQ1H5w8bMdXGVtaH"], ["CRzp-4dgE", "CRzpBtFwjGkYKjwPSBzC4mn8qF2eb7XpjfPemubT4dgE"],
  ["4BfW-ZpZh", "4BfWVLy15vLYfCbZ3MJk1vSkVBZaKZZPUKWLgwMqZpZh"], ["pyry", "9HvLxQwEgnT7nfXctCVBRN6KdNkT2hsNtXBKV69yYiAr"],
  ["Cupsey", "suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK"], ["Cooker", "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6"],
  ["Cented", "CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o"], ["Limfork", "BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB"],
  ["Ducky", "ADC1QV9raLnGGDbnWdnsxazeZ4Tsiho4vrWadYswA2ph"], ["eq0", "7w7f4P284zJhv3zotjCUmaNsZSsrHQKtpXGBJFq8gdzq"],
  ["Sebastian", "3BLjRcxWGtR7WRshJ3hL25U3RjWr5Ud98wMcczQqk4Ei"], ["slingoor", "5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij"],
  ["69ai-VSM1", "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1"], ["RuneCrypto", "3CPHk5b7SRvAsTsocehAu1bA5YKMXJYMr3qc2SuMFkWY"],
  ["Daumen", "8MaVa9kdt3NW4Q5HyNAm1X5LbR8PQRVDc1W8NMVK88D5"], ["nyhrox", "6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC"],
  ["Cupsey 2", "2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f"], ["samsrep", "CUHBzSPSaNS3tArEtM3maSV6pNdJhHJFYZpurPPK9P7H"],
  ["Pullup", "65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE"], ["theo", "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt"],
  ["zinceth", "HQdFfmiDrZGbxqE5k5CqDxUkLUHhCUS39YHqsRGsfzeH"], ["traderpow", "7eNRALuXYUJkUWTvRj5tcB7tcT43kmT5SNdkfy9fKTto"],
  ["ROWDY", "DKgvpfttzmJqZXdavDwTxwSVkajibjzJnN2FA99dyciK"], ["Log", "2pUUZYtokRgDV2YzL6M5pjb1jyoHE367yU1sdQ7ac3ea"],
  ["Cais-TE4j", "CaisERf36rW5abT9ZotN82D3W7N8CETkfjiVo1joTE4j"], ["H7Np-czn8", "H7Npr74ULAhJnQmqY58Eyk8cnz8yLpNNQ2pXR9twczn8"],
  ["WaiterG", "4cXnf2z85UiZ5cyKsPMEULq1yufAtpkatmX4j4DBZqj2"], ["Zrool", "99i9uVA7Q56bY22ajKKUfTZTgTeP5yCtVGsrG9J4pDYQ"],
  ["99Qb-7rpg", "99QbDV2M2x2ovjWgEDTdjVkJRi7BJkALSyYmTvBo7rpg"], ["3Ckg-mGfw", "3CkgBB2ryzxQuSmzPSQ53jtVffPf1Wb1t1HBVs8GmGfw"],
  ["Smokez", "5t9xBNuDdGTGpjaPTx6hKd7sdRJbvtKS8Mhq6qVbo8Qz"], ["asta", "AstaWuJuQiAS3AfqmM3xZxrJhkkZNXtW4VyaGQfqV6JL"],
  ["TIL", "EHg5YkU2SZBTvuT87rUsvxArGp3HLeye1fXaSDfuMyaf"], ["Fox", "DAEdBmTPEKM6xkwfzC3d411QUe6coKpkND6UURa4CvHC"],
  ["milito", "EeXvxkcGqMDZeTaVeawzxm9mbzZwqDUMmfG3bF7uzumH"], ["shah", "7xwDKXNG9dxMsBSCmiAThp7PyDaUXbm23irLr7iPeh7w"],
  ["CxtV-BrnMr", "CxtVPrK4mA7vfzLuk4ztYV51a6pLFc8NpPm6K6KBrnMr"], ["andy8052", "AjmmrnMkd4FHe7HZULcof2WZaR7x2ivdvNJwGcLJz2YS"],
  ["martypartymusic", "F6R465oEBsS5wVYSGfASF8EBVuPP6LFXwrbzZ2qk96ew"], ["danny187", "EaVboaPxFCYanjoNWdkxTbPvt57nhXGu5i6m9m6ZS2kK"],
  ["JADAWGS", "3H9LVHarjBoZ2YPEsgFbVD1zuERCGwfp4AeyHoHsFSEC"], ["9Tee-pYi7", "9Tee3dgA4agNnvVATUhakWzngwYrGzQWrxyafGGKpYi7"],
  ["93kg-1pbp", "93kgxYKex5wPyEkjH9P4KspLFAi3fdWBkw8vZce51pbp"], ["Inside Calls", "4NtyFqqRzvHWsTmJZoT26H9xtL7asWGTxpcpCxiKax9a"],
  ["cap", "CAPn1yH4oSywsxGU456jfgTrSSUidf9jgeAnHceNUJdw"], ["Ansem", "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm"],
  ["Jijo", "4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk"], ["LUKEY", "DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s"],
  ["carl0s", "CDkVHiRu363Atxe9Hv1a8zgWEtZn4G1xNyuqWb9iJ5Xt"], ["N'o", "Di75xbVUg3u1qcmZci3NcZ8rjFMj7tsnYEoFdEMjS4ow"],
  ["radiance", "FAicXNV5FVqtfbpn4Zccs71XcfGeyxBSGbqLDyDJZjke"], ["ozark", "DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam"],
  ["Hesi", "FpD6n8gfoZNxyAN6QqNH4TFQdV9vZEgcv5W4H2YL8k4X"], ["kyro", "B9kJYdzb4gB9AC3aFChReDhJ2D5YDCaR4UrEoen2NcyC"],
  ["Propp", "3JD7zrZVXfGozgaSrnn3GzAcGsHCM5ATazX8EqwJqZWY"], ["The Doc", "DYAn4XpAkN5mhiXkRB7dGq4Jadnx6XYgu8L5b3WGhbrt"],
  ["lyftical", "2hN82SXLUffhG3vxpezRmae1sGrCBMqHHBDxjmjpagqk"], ["Giann", "GNrmKZCxYyNiSUsjduwwPJzhed3LATjciiKVuSGrsHEC"],
  ["FFFz-2Zco", "FFFz6LeDp41sqe5VusaLH7V2HFhidCnqTiYQhE6V2Zco"], ["Flames", "6aXFYXbFob1ZKAEDCcqZnX2vooA3TgEqDoy5dAQbeWoV"],
  ["Frost", "4nwfXw7n98jEQn93VWY7Cuf1jnn1scHXuXCPGVYS9k6T"], ["MikeTrenches", "4WbeDhRxyj9m8Uh7GZSNpW7DFh989oTFguTE4c2A2cgK"],
  ["R4", "Cv5GgkpXvtXcsrMcKCJvx46BpMjiM61mpPU1j8RbbbVL"], ["Zemrics", "EP5mvfhGv6x1XR33Fd8eioiYjtRXAawafPmkz9xBpDvG"],
  ["Connor", "9EyPAMyQvXaUWFxd2uQHvG8vpkKs33YdXvDvwmRXrUiH"], ["Solta", "HW4UkuG9uTuFvrTjJB5euuwPLTRQ1oCQ7doCZSVLRkHC"],
  ["Jason", "ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831"], ["dv", "BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd"],
  ["ceo", "5ghUXGD9VHqtHR1HCUNDdqxGnVGs7DWkX8Zz9X11G36N"], ["Clown", "EDXHdSFdadFbYFFjxPXBqMe1kCEDFqpPu552uvp48HR8"],
  ["blu6k", "8Ltv5royXzxVG3tAhVhRnfXrzapS5Dwqt1ocxprgu6YP"], ["Pengu", "JAunzNqs3bVBcWDjDxfq9rgLzJMCadNXoaCgfzLGMtYs"],
  ["Reljoo", "FsG3BaPmRTdSrPaivbgJsFNCCa8cPfkUtk8VLWXkHpHP"], ["Twenk", "ACUqQFHiuyobxeJUW6dvppZyfqkce2EJLhVu9Zf2iL1E"],
  ["abrawlerj", "6Siu5R8vGtcUwryuEyFJhKdFzHa2P2ogBK719Bmqpwsc"], ["Gfree", "4yo9CUuTBbds9NFhZd4MzPiZZkUvveXdTnAH8qMsE8ku"],
  ["lyftical 2", "951wq3qDowjKHaycrNaiRB5WpovYVKXnqhnrcKPh46zt"], ["hauva", "43FiZWbqc7DDTyhGpGSqQdbEokaDMuCy5nsFtv4P664Z"],
  ["chester", "PMJA8UQDyWTFw2Smhyp9jGA6aTaP7jKHR7BPudrgyYN"], ["kreo444", "BCnqsPEtA1TkgednYEebRpkmwFRJDCjMQcKZMMtEdArc"],
  ["KOREAN", "6KR7SorsUQtNH6CB6JpAnWCAKeTysa95iyXeWihdNeGT"], ["Lowskii", "41uh7g1DxYaYXdtjBiYCHcgBniV9Wx57b7HU7RXmx1Gg"],
  ["Putrick", "AVjEtg2ECYKXYeqdRQXvaaAZBjfTjYuSMTR4WLhKoeQN"], ["Financial Improv", "4xd3Y2qvX43wwfLupdQVsE5ZTpnhXmpn8Dmf4Hufkj9n"],
  ["Qtdegen", "7tiRXPM4wwBMRMYzmywRAE6jveS3gDbNyxgRrEoU6RLA"], ["blixze", "5vg7he5HibvsAW86wfiuP6jw7VwKmUAnP6P93mVCdpJu"],
  ["Buck", "FaNaUysvKBbfoRAhu7P7R5wPfHe7PaCXs9xy5LgLj3gu"], ["omar", "Dgehc8YMv6dHsiPJVoumvq4pSBkMVvrTgTUg7wdcYJPJ"],
  ["Rilsio", "4fZFcK8ms3bFMpo1ACzEUz8bH741fQW4zhAMGd5yZMHu"], ["Gucci", "YvEsBWpHK5PJ6Q8m4YrocwKeWys1NG67pbgi73UPnuX"],
  ["Gasp", "xyzfhxfy8NhfeNG3Um3WaUvFXzNuHkrhrZMD8dsStB6"], ["Classic", "DsqRyTUh1R37asYcVf1KdX4CNnz5DKEFmnXvgT4NfTPE"],
  ["RaidzQT", "8CLkTAHZt1joF4Swh7YKjGAA8qge1T1SZdoWJJsoGgys"], ["Benytradez", "AXgzGEvbgaFeb1xhdXkQc5D5CehZUa89ci2F9ugQPLaA"],
  ["frog", "9cxLzxjrTeodcbaEU3KCNGE1a4yFZEcdJ7uEXN378S4U"], ["treysocial", "831yhv67QpKqLBJjbmw2xoDUeeFHGUx8RnuRj9imeoEs"],
  ["bandit", "5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X"], ["Silver", "67Nwfi9hgwqhxGoovT2JGLU67uxfomLwQAWncjXXzU6U"],
  ["Lspfi", "A8Z1ejQGk45EJibBPJviWnM3UvwKSuYun53nSCkWKM52"], ["Monki", "53BnNc49Ajgstciq3CRoyxuBpkkW1r8pgPyvr7JGYnsh"],
  ["Hermes", "5dzH7gh5FjtrxUwtfBufJyTBA4fyCUGheZsdYQsE9vag"], ["t9ndra", "3UNPM7X6LbmxUms5ij6zm9P7J1Ev2Wd7TwwXmYrPX3n3"],
  ["Zeptic", "BR1Z9KfrdDQGPN58Y24YMwitzUznsTJb84ezQK4LLMGU"], ["West", "JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN"],
  ["noob mini", "AGqjivJr1dSv73TVUvdtqAwogzmThzvYMVXjGWg2FYLm"], ["boxbox", "55msLm128tQdXLXCXLxd756H9SaCo7wPpdetEioe7D8d"],
  ["leviilol", "A4KxLRntS2V6giboMyfDtwoysmsKPaz8Juw6CwHYxVXn"], ["Cope", "23wQ7bodYreW3qhnh2YrW8dMkTYSkHHJqGcsiYEJS3Pr"],
  ["Zef", "EjtQrPTbcMevStBkpnjsH23NfUCMhGHusTYsHuGVQZp2"], ["Jadra", "5KdVD2MGzkSpX84tj113dfEPePKv9vCrJZrGsCNdz6f3"],
  ["S", "ApRnQN2HkbCn7W2WWiT2FEKvuKJp9LugRyAE1a9Hdz1"],
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
