# Deploying

**Nothing here has been deployed to testnet or mainnet.** The supported, tested path is the local demo (`npm run demo:offline`), which
starts a real nearcore node, deploys `res/true_mine.wasm`, initialises it and runs the agents and the server. What follows is what a
deployment needs, in the order it would be done, written from the demo's own wiring (`scripts/demo.ts`) and **not executed**.

## The contract

1. Build it: `npm run build:contract` (Rust 1.86, pinned by `contracts/true-mine/rust-toolchain.toml`; `wasm-tools` validates the output
   against baseline WASM + sign-extension, which is what NEAR's VM accepts).
2. Create an account for it, fund it with enough NEAR for the code's storage (about 3 NEAR for the 303 KB WASM) and deploy the file.
3. Initialise once: `new { half_life_secs, season_secs, bond_window_secs, fee_bps }`. The demo uses 8, 30, 45 and 100. A deployment would
   use hours and days (a 6 h half-life and a 7 day season are a starting point, **not a tested choice**): the half-life is how long a
   pump must be held to count, the season is how long a claim must stay at 90% before its tokens can be spent, the bond window is how
   long evidence has to attract capital before its bond is settled.
4. Delete the deploy key for an immutable contract (there is no admin function), or keep it if you want upgrades.
5. Every account that will receive $TRUE calls `storage_deposit` once (0.0025 NEAR). Mining accounts are registered automatically
   when they open a mine.

## The agents and the server

`scripts/demo.ts` is the reference: it constructs the keeper, the miners and the verifiers (each a `Chain` wrapper over a funded account)
and calls `startServer`. Pointing them at a deployed contract means replacing the sandbox accounts with real ones and the RPC URL with a
testnet one. There is no entry point for that yet; it is the first thing to write. Notes for whoever does:

* The keeper pays gas for every `sync` and earns nothing. It stops, once and out loud, below 0.5 NEAR.
* Give the agents the Wikipedia user agent (`MINE_USER_AGENT`), which Wikimedia asks automated clients to identify with. `npm run warm`
  fetches the pages the seed statements need, once, and `MINE_CACHE_ONLY=1` then answers from disk.
* The demo account (one wallet for every visitor) exists only so a page can act without a wallet. Do not give a public deployment one.
  The browser wallet path is not written.
* `/api/state` returns every claim; a deployment with many should paginate it.
