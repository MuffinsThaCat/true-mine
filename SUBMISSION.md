# Submission checklist and video script

Deadline: 14 Nov 2026, 23:59 UTC. Two submissions per person: this one and **Verity**. The two READMEs cross-reference each other
(this one links `../verity`; replace both links with the public GitHub URLs before submitting).

## Before submitting

- [ ] Public GitHub repository for this project (the code, `contracts/true-mine/res/true_mine.wasm`, `seed/`, `seed-cache/`; not `node_modules`, `dist`, `data`, `.env*`: the `.gitignore` already excludes them)
- [ ] Replace the `../verity` link in README.md with Verity's public repository URL, and make sure Verity's README links here
- [ ] `npm install && npm run build && npm test` on a clean clone (71 tests)
- [ ] `npm run test:contract` (43 tests; needs Rust 1.86, `rustup` installs it from `rust-toolchain.toml`)
- [ ] `npm run build:contract` and confirm `res/true_mine.wasm` is the file committed (it is the post-audit build, 304 KB)
- [ ] `npm run e2e` (22 checks; downloads the local NEAR node once)
- [ ] `npm run demo:offline`, open http://localhost:8791, press **Play the story**, then `npm run test:ui` in another terminal (11 checks; 12 with `CAPTIONS=1`, which also runs the silent walk-through)
- [ ] Record the video (script below)
- [ ] Public X post tagging @NEARProtocol with #NEARHackathon (draft below), with the video attached
- [ ] The submission form: repository URL, X post URL, NEAR wallet address, description (20 to 2,000 characters; draft below), tracks

## Tracks

Primary: **Memecoins With Mechanics**: "supply that reacts to the community, treasuries with rules, onchain rituals and challenges."
The supply is minted from belief and burned on refutation; the treasury (the Truth Fund) has one rule; the ritual is a season. Also
**AI Swarms** (a keeper, miners and verifiers, each an ordinary account) and **Open Innovation**.

## Description (about 1,200 characters)

$TRUE is a token whose supply is mined from what a market believes and burned when it stops. Every claim is a prediction market that
never resolves. Bond NEAR to a claim and it mints $TRUE while the market keeps believing it: tokens are minted locked, follow a
time-averaged price (so an undefended pump mints almost nothing), and become spendable only after a full season at 90%. At any later
time, with no deadline, a claim whose average falls under 30% burns its tokens, has any released tokens clawed back, and loses its bond
to a Truth Fund that holders can redeem against. AI agents are paid to read sources, quote them verbatim and trade the price; the
contract trusts none of them, and a browser can re-hash any evidence itself. Built on a real local NEAR node: a NEP-141 token with NEP-145
registration, 43 contract tests (including a 2,500-step random walk that audits both the NEAR and the token ledgers), 22 end-to-end
checks, 11 headless-Chrome UI checks. The design document lists what it does not prove: verifiers are an assumption, unfalsifiable
claims are unprotected, and nothing is deployed to testnet yet. Sister project: Verity (an encyclopedia written from non-resolving markets).

## X post (draft)

> Bitcoin miners find hashes. $TRUE miners find facts.
> Every claim is a market that never resolves. Bond NEAR to one and it mints $TRUE while the market believes it, locked until it survives
> a season. If the market turns, at any time, the tokens burn and the bond goes to a fund. Agents check sources; the contract trusts none.
> @NEARProtocol #NEARHackathon [repo] [video]

## Fully automatic video: `npm run record`

`npm run record` makes the whole video with no one at the keyboard: it starts a fresh local demo, waits about 75 s for mines to mature, drives
headless Chrome through the captions walk-through (visible cursor, real clicks, captions, the lie story, the evidence check), captures the
frames and encodes `demo-video/true-demo.mp4` (about 130 s, 1600x1000, 11 MB) with ffmpeg. It needs Chrome, ffmpeg, about 2 GB of free disk (it checks first and refuses to start without it) and internet for the
"verified in your browser" step. It encodes to a side file and renames it only on success, so a failed run never damages a video you already have,
and it removes its Chrome profile and frames when it finishes (the UI check removes its profile too). `THEME=dark` and `W`/`H` change the look and size. The file is git-ignored; upload it with the post.
It was run twice, and the first run's footage showed a wrong number in the story panel, which was fixed and re-recorded.

## Silent video by hand (no voice-over): captions mode

Open **http://localhost:8791/?captions=1** and screen-record the browser window (about 100 seconds, no editing needed). The page runs the whole
walk-through by itself: on-screen captions, a highlight on each thing it talks about, a claim opened to show the price against its average,
the lie story played from bond to debunk, the evidence drawer with the browser verification, a mine that is ready to release, the Truth
Fund, and a last card saying it runs on a local node and what it does not prove. The captions appear as it goes; nothing needs clicking.
The UI check (`CAPTIONS=1 npm run test:ui`) asserts all of those captions appear and that the lie story reaches its debunk (17 captions in about 125 s on the last runs; if the chain is quick and the story skips ahead, each skipped step's caption is still shown in order).

1. Restart the demo (`pkill -f dist/scripts/demo.js; npm run demo:offline`) so the supply chart starts from empty, and wait about 75 seconds.
2. Start the screen recording, then load the `?captions=1` URL (about 1400 px wide). Stop when the last caption fades.
3. The "Verified in the browser" caption needs internet (the browser fetches Wikipedia itself); offline it says so instead.

## Video script with a voice-over (about 90 seconds; the demo is running before you start)

1. **0:00** The page. "Every claim here is a market that never resolves. Its price is what the crowd believes. This token is minted from that belief." Point at the supply, the locked/spendable bar, and the gauge on a card: dot = price, ring = average, "only the ring can mint."
2. **0:15** Click a card. Show the chart: the average (green) trailing the price (white), the 30 / 70 / 90 bands. "A pump that is not defended barely moves the ring, so it mints nothing."
3. **0:25** Press **Play the story**. "I am bonding 2 NEAR to a lie: Pluto has twelve moons." Narration starts. The supply ticks up as the lie is believed: "that is $TRUE minted against something false. It is locked, so nobody can spend it."
4. **0:45** A verifier reads Wikipedia and posts evidence. Open the claim: the quote, the hash, the bond. Press **Verify in your browser**: "my browser fetched that revision from Wikipedia, hashed it, and checked the quote is really in it. No oracle, no referee."
5. **1:00** The price falls, the average follows, the card is stamped DEBUNKED. "The tokens burned, and my 2 NEAR went to the Truth Fund. Nobody judged this: verifiers were paid to correct the price and the contract only watched the average."
6. **1:15** Scroll to a mine that has been believed for a season, "ready to release". "Only after a whole season at 90% can a miner spend what a claim minted. And the Fund is the floor: burn $TRUE, take your share of the liars' bonds."
7. **1:25** Close: "Verity prices every sentence of an encyclopedia without resolving it. $TRUE asks what the same primitive does for money. DESIGN.md says what it does not prove."

## If asked

* *Is this just Verity with a token?* The market arithmetic, the source-checking modules and two adapted agents (the verifier and the evidence-bond keeper) are shared, and the README says so; the mine, the exponential average, locking, seasons, debunking, the Fund, the token standard, the keeper, the miners and the page are new, and nothing is shared at runtime. Remove non-resolution from Verity and there is no oracle left; remove it from $TRUE and the supply can no longer be corrected after the fact.
* *What stops a liar walking away with the bond?* `retire` needs the current price at 50% or more, so a refuted claim cannot leave before its debunk. That hole was found by reasoning, fixed, and is covered by a unit test and an end-to-end check.
* *Does it work without a model?* Yes: a rule-based judge reads real pinned Wikipedia revisions and declines when unsure. A language-model judge is supported and untested.
* *Is it deployed?* Not to testnet. Everything ran on a local nearcore node.
