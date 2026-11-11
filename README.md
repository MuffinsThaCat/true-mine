# $TRUE

**A token whose supply is mined from what a market believes, and burned when it stops.**

Every claim is a prediction market that never resolves. Bond NEAR to a claim and it *mines* $TRUE for as long as the market keeps
believing it: the tokens are minted locked, follow a time-averaged price (so a pump that is not defended mints almost nothing),
become spendable only after a full season at 90%, and are burned, with the bond confiscated, **at any later time, with no deadline**,
if the market turns. The confiscated bonds form a Truth Fund that any holder can redeem against. AI agents are paid to check
sources and correct prices; the contract trusts none of them.

> Built for the NEAR Hackathon (Nov 2026). Tracks: **Memecoins With Mechanics** (the supply *is* the mechanic), with AI Swarms
> and Open Innovation. Start with [DESIGN.md](DESIGN.md) for the mechanism and, more usefully, what it does **not** prove.
>
> **Sister project: [Verity](../verity)** (same author, also submitted). Verity prices every sentence of an encyclopedia with
> non-resolving markets; $TRUE asks what that primitive makes possible for a *token*. They share the market arithmetic, the
> source-checking modules and two adapted agents (the verifier and the evidence-bond keeper); the contract, the miner and mine keeper, the
> server and the UI are separate. See [How this relates to Verity](#how-this-relates-to-verity).

## See it work (local, about two minutes, no API key)

Needs Node 20 or newer. The contract is already built (`contracts/true-mine/res/true_mine.wasm`); Rust 1.86 is needed only to
rebuild it. The first run downloads a local NEAR node (a 53 MB nearcore binary, once: `npm run fetch-node`). License: MIT for the code;
the cached Wikipedia pages in `seed-cache/` are CC BY-SA 4.0.

```bash
npm install
npm run build
npm run demo:offline     # a real local NEAR node + the real contract + 8 agents + the UI at http://localhost:8791
```

What you see: miners read Wikipedia, bond NEAR to the statements it supports, and the supply climbs as belief lasts. Every
~70 s a **charlatan** bonds a lie without reading anything; watch its tokens mint, a verifier quote Wikipedia against it, the price
fall, the average follow, and the contract burn the tokens and confiscate the bond. Press **▶ Play the story** (or pick a lie and
**Mine this lie**) to do it yourself as a funded account and have each step narrated from the chain. One 25-minute run ended with
30 claims, 22 mines open, 8 lies debunked (six bonded by the charlatan, two injected by the UI check) and a Truth Fund of exactly
16.00 NEAR, which is 8 × the 2 NEAR bond. Click any claim for its price-against-average chart, the rule that applies to it, and its evidence, whose
**Verify** button fetches the Wikipedia revision *in your browser*, hashes it, and checks the agent's quote is really in it.

`npm run record` makes a silent walk-through video of all this by itself (a visible cursor, on-screen captions, real clicks): it starts a
fresh demo, drives headless Chrome through the page and encodes `demo-video/true-demo.mp4` with ffmpeg. See SUBMISSION.md.

## The mechanism in six lines

| | |
|---|---|
| **Bond** | Bond 1 to 100 NEAR to a claim. That sets the mine's cap: 1,000 $TRUE per NEAR. The bond is all that can ever be slashed. |
| **Average** | Each claim carries an exponential moving average of its price (the gap halves every *half-life*). It starts at 50%. A trade moves the price at once and the average only as time passes. |
| **Mint** | Average over 70%: mint toward the cap (0 at 70%, all of it at 90%). Minted tokens are **locked**: in the supply, not spendable. They burn again if the average falls. |
| **Season** | After the average has stayed at 90% for a whole *season*, the miner may `release` the locked tokens. Only then can they be spent. |
| **Debunk** | Average under 30% at **any** time: locked tokens burn, released tokens are clawed back from the miner's balance (what was already moved on is counted as `orphaned`), the bond goes to the Truth Fund. |
| **Floor** | Burn $TRUE, take your pro-rata share of the Truth Fund. The only way to make $TRUE is to be believed; the only way to lose a bond is to be refuted. |

Why this needs non-resolution: a market that resolved would have a deadline, and after it a lie could keep what it had minted.
Here a lie minted last month is debunked the day better evidence lands, and the tokens it minted burn. See DESIGN.md for the
exponential average (the first version had a flaw worth reading about), the escape hatch that was found and closed, and what is still open.

## What has actually been run

> A second audit changed the contract (a retire cooldown, a redeem base, a larger registration deposit). After those changes the WASM
> was rebuilt and every suite re-run: 43 contract, 62 TypeScript, 22 end-to-end and 11 UI checks, all green. The audit is in DESIGN.md.

| Check | Result |
|---|---|
| Contract unit tests (`npm run test:contract`) | 43 pass: the average (monotone, never overshoots, **the same answer however often it is read**), mint in proportion, a flash pump mints almost nothing, doubt burns without slashing, debunk, a debunked mine stays dead, season gating, release, clawback and orphans, retire, a refuted claim cannot retire, redeem pro rata, NEP-141 and NEP-145 guards, evidence bonds, and a 2,500-step random walk (buys, sells, syncs, releases, transfers, redemptions, three debunks) that checks **both** the NEAR identity (`in - out = liabilities + kept`) and the token identity (`minted - burned = spendable + locked`) |
| TypeScript tests (`npm test`) | 71 pass: the miner (opens a supported statement at 92 to 95%, never twice, retries after a dropped call but gives up after three), the keeper's decision about when a mine needs a sync, the verifier's order of work (a claim it has never seen comes before a recheck; checked by removing the rule and watching the test fail), then the Wikipedia text cleaner against its regex original and hostile 2 MB pages, the rule-based judge and its regressions, rate limiting and the disk cache, the LLM client |
| End to end on a real local NEAR node (`npm run e2e`) | 22 of 22: a careful miner bonds the supported statement and refuses the contradicted one; a verifier leaves a 94% truth alone; the keeper mints as belief lasts to the cap; release is refused before a season and by a stranger, then works; `ft_transfer`, and `ft_transfer_call` refunding in full; an unchecked lie mints, is refuted with a quote-checked source and a pinned hash, **cannot be retired out of its debunk**, is debunked, its tokens burn and its bond reaches the Fund; its evidence bond is settled by the keeper; redeem pays the expected share; a clean mine retires; the NEAR identity holds and the contract holds what it owes; the server (state, claim, verify, the demo account, path traversal, oversized and malformed bodies) |
| UI (`npm run test:ui`, against a running demo) | 12 of 12 in headless Chrome (11, plus the silent captions walk-through when run with `CAPTIONS=1`): the supply, fund, claims and agents render with no script errors; a mining claim's gauge; the drawer with its chart and rules; typing your own claim; a refused short claim; the **whole story** (bond a lie → mint → refute → debunk → bond in the Fund); redeem refused for someone with none; phone width with no sideways scroll; dark mode |
| Live Wikipedia | the rule-based judge reads real pinned revisions (shipped in `seed-cache/`, so the demo runs offline); 23 true statements and 6 lies from four articles |

**Not done:** deployment to testnet or mainnet; the browser wallet path (the demo acts as a server-held account); a run with a
language-model judge (no key was available; the rule-based judge is what ran); a listing on a DEX or on meme.cooking; any economic
tuning of the constants (they are chosen to make a life cycle visible in minutes, not to be right for mainnet); an independent audit
(DESIGN.md is a self-review). `ft_transfer_call` is tested only on its failure branch (the receiver cannot take the tokens).

## How this relates to Verity

Verity proves non-resolving markets work for **knowledge**: an encyclopedia written from prices. $TRUE tests whether the same
primitive works for **money**: a supply written from prices. The reuse is deliberate and small: the integer AMM and evidence-bond
arithmetic, the modules that fetch a pinned Wikipedia revision, judge it and check a quote (`src/lib/{judge,offlineJudge,sources,wikitext,llm}.ts`,
with their tests), and two agents adapted from Verity's: the verifier (`src/agents/analyst.ts`: it now skips closed mines, audits what is minting
first and waits out an audit queue) and the evidence-bond keeper (`src/agents/bonds.ts`, unchanged apart from names). The env variables
were renamed `VERITY_*` to `MINE_*` and the files copied into this project; nothing is imported from Verity at runtime. Everything that makes this a token (the mine, the average, locking, seasons, debunking, the Fund, NEP-141,
the mine keeper, the miners, the server, the page) is new, and the two projects share no state and no deployment. If you remove non-resolution
from Verity there is no oracle left and it breaks; if you remove it from $TRUE the supply can no longer be corrected after the
fact, and it breaks in the same way.

## Layout

```
contracts/true-mine/   Rust contract (near-sdk 5.9, toolchain pinned to 1.86); res/true_mine.wasm is the build; src/tests.rs
src/lib/               chain client, sources (Wikipedia, rate limiter, disk cache), judges, LLM clients, activity log
src/agents/            analyst (verifier), miner (also the charlatan), keeper (syncs mines, settles bonds)
src/server.ts          polls the chain, keeps history, serves the API and the page, and the demo account's actions
src/demo/              the seed statements (true and false) and the offline corpus
web/                   the page (no build step)
scripts/               demo, fetch-node, warm
test/                  unit tests, the end-to-end test, the UI check
seed/, seed-cache/     four articles' statements; the Wikipedia pages they are checked against (CC BY-SA 4.0)
```

**About the file count.** Most of the repository's files are in `seed-cache/` (277 of about 330): small JSON files holding Wikipedia pages at pinned
revisions and the search results the agents asked for, about 4 MB in all. They are data, not code. They are what lets `npm run demo:offline` run with
no network and lets a fresh clone reproduce the demo; without them the agents would need live Wikipedia access and could be rate-limited. The code is
about 60 files (`src/`, `test/`, `contracts/`, `scripts/`, `web/`). The pages are CC BY-SA 4.0 and `seed-cache/README.md` carries the attribution.

Submission checklist and video script: [SUBMISSION.md](SUBMISSION.md). Deployment notes: [DEPLOY.md](DEPLOY.md).
