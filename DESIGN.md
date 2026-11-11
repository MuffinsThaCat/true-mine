# $TRUE: design, and what it does not prove

## The idea in one paragraph

Most token supplies are set by a schedule, a formula or a vote. Here the supply is a reading of what a market currently
believes. Claims are binary markets that never resolve, so there is no oracle and no date after which a claim is final. Bond NEAR to
a claim and it mines $TRUE for as long as the market keeps believing it. The tokens are locked until the claim has survived a
season at 90%, and **at any time, with no deadline**, a claim whose time-averaged price falls under 30% burns its tokens and loses
its bond to a fund that holders can redeem against. Supply can therefore be corrected after the fact, by evidence, whenever the
evidence arrives. That is the property a resolving market cannot have.

## What is mechanism, what is policy

| Layer | Where | What it guarantees |
|---|---|---|
| Market | `contracts/true-mine` | A claim's pool is always fully collateralised (`collateral == YES supply == NO supply`, checked on every trade). Rounding favours the pool. Arithmetic is integer only; the VM rejects floats. |
| Average | `contracts/true-mine` | An exponential moving average of each claim's price, exact in integers, that gives the same answer however often it is read. |
| Mine | `contracts/true-mine` | Bond, mint, lock, season, release, debunk, retire, redeem. Two ledgers are audited in tests: `in - out = liabilities + kept` (NEAR) and `minted - burned = spendable + locked` (tokens). |
| Token | `contracts/true-mine` | NEP-141 (`ft_transfer`, `ft_transfer_call`, metadata) with NEP-145 registration. Only spendable tokens are balances; locked tokens are not. |
| Evidence | `contracts/true-mine` | A source is a URL plus the sha256 of what was fetched, a stance and a bond that is returned only if capital follows it. Anyone can re-fetch and compare. |
| Verifiers, miners, keeper | `src/agents` | Off-chain policy. Ordinary accounts spending their own NEAR. Nothing on chain trusts them. |
| Judge | `src/lib` | A verdict counts only if its quote appears verbatim in the fetched source, enforced in code. |

## The constants

| | Value | Why |
|---|---|---|
| Mint cap | 1,000 $TRUE per NEAR bonded (bond 1 to 100 NEAR) | Ties supply to capital at risk, so a free claim cannot mint |
| Mint ramp | 0 at an average of 70%, the whole cap at 90%, linear between | A claim that is merely plausible mints little |
| Season | average at 90% for `season_secs` | The price of being allowed to spend |
| Debunk | average under 30% | Doubt (30 to 70%) burns locked tokens but does not slash; refutation slashes |
| Half-life | `half_life_secs` | How long a pump must be held to count |
| Retire | refused for a cooldown (a season, at least three half-lives) after any touch that found the price under 50% | See "The escape hatch" below |
| Redeem base | the supply is counted as at least 10,000 $TRUE | Stops a small early supply sweeping the fund |
| Token account | 0.0025 NEAR kept per registration | Registration entry plus balance entry |
| Fee | claim 0.07 NEAR, position 0.002 NEAR, evidence 0.01 NEAR (kept for storage); trading fee set at deploy, at most 3% | Storage is paid for by whoever uses it |

The demo uses a half-life of 8 s and a season of 30 s so a life cycle fits in two minutes. A deployment would use hours and days.
**None of the constants has been tuned for a real economy.**

## The average, and a flaw worth reading about

The first version blended the price into the average by `dt / window` of the gap on every update, landing on the price after one
window. It passed its tests. Reasoning about who may call `sync` showed it was wrong: the average converged *faster the less often
anyone touched the claim*. Update every second and it moves like an exponential; update once after a window and it jumps to the price.
So a spammer could slow a debunk by calling `sync` constantly, and a miner could speed up a mint by making sure nobody did.

It is now a true exponential: the gap to the price shrinks by `2^(-dt / half_life)`, computed in 1e18 fixed point (whole half-lives by
shifting, the remainder by an eighteen-term Taylor series, error under 1e-17) with the average stored in 1e-8 of a basis point.
Two updates of a and b equal one of a + b to within rounding. This is a test (`reading_the_average_often_or_rarely_gives_the_same_answer`),
not a claim: 1, 2, 7, 50 and 1,000 pieces of the same interval agree to a handful of units in 1e-8 bps.

The cost of the exponential is that "at 90%" is reached asymptotically: a claim priced at 94% needs about 3.5 half-lives (the gap from
50% must shrink from 44 points to 4), one priced at 91% about 5.4, and one priced at exactly 90% effectively never. That is intended:
full minting and release need a price clearly above 90%.

## What anchors a price to the truth? (the question to ask)

Not an oracle. In a market that never resolves a price is whatever the last trader was willing to pay, and nothing in the contract
forces it toward the truth. The thesis is narrower, and it is a hypothesis the demo tests rather than a theorem:

> If checking a claim is cheap for automated verifiers, then holding a false claim at a high price is a standing subsidy to whoever
> checks it, and the price converges toward what a checkable source says.

$TRUE adds one thing to that: **the liar has more to lose than the market-maker's seed**. A mine puts a bond behind the claim, and
tokens minted against it are burned when it falls. The mine does not make the price true; it makes lying on a *checkable* claim cost
the bond (if the liar is not watching, or has already taken tokens out) and earn nothing (if the liar is watching).

Stopping it from being a proof:

1. **Verifiers are an assumption.** If nobody is checking, a false claim stays priced high, mints, and is released after a season.
   The mine pays verifiers; it cannot summon them. The page says so in its footer.
2. **Only checkable claims are protected.** A claim no source can refute ("this song is good") cannot be debunked by evidence, so a miner
   can mint against it and keep it. The bond is at risk only from a market that can be moved against it.
3. **A thin market is cheap to move.** Pool depth is the security budget. In the end-to-end test a 2 NEAR seed opened at 94% falls under 35%
   within a few verifier trades. That is the defender's side of the same fact: deep seeds are harder to push, in either direction.
4. **The verifier can be fooled.** A judge can be wrong or be shown a bad source. Its damage is capped by the agent's own trade limit and
   by the evidence it leaves on chain for others to dispute with money.

## The escape hatch, closed twice

`retire` lets a miner burn everything a claim minted and take the bond back. The average lags the price on purpose, so right after
verifiers refute a lie the price is at 10% while the average is still at 70%. A watching liar could `retire` in that gap, get the
bond back, and never be slashed: slashing would have caught only the inattentive.

**First fix, and why it was not enough.** Require the *current* price to be at least 50%. A second audit found it could be walked around:
buy YES to lift the price over 50%, retire in the next block, sell the YES back. The round trip costs about two percent in fees, against a
bond of 1 to 100 NEAR.

**Second fix.** Every price change is a trade, and every trade first brings the claim up to date (`settle_mine`). So each touch can stamp
`last_low_ms` whenever the price that held *before* it was under 50%. Lifting the price is itself a touch, and stamps the low price it
found, so it cannot erase it. `retire` is refused until a cooldown (a season, and never less than three half-lives, which is longer than a
refuted claim's average needs to fall under 30%) has passed since the last such stamp. A claim the market disbelieved cannot slip out
before its debunk; one that has been believed for a whole cooldown can retire normally. Covered by unit tests (a refuted mine, a mine whose
price is lifted back, and one that recovers and retires after the cooldown) and, for the first case, an end-to-end check on a real chain.
All of them pass on the rebuilt contract.

What remains true: a liar who has *not yet released anything* and was never disbelieved loses nothing by walking away, and one who is
refuted loses the bond. A liar who released and sold is exposed to the debunk (see "Orphans" below).

## Orphans: what a debunk cannot take back

Released tokens are ordinary NEP-141 balances. A debunk takes them back from the miner's account as far as the miner still holds them;
what the miner already moved on stays with whoever has it and is counted as `orphaned` (visible in `get_supply`). The bond is the
miner's loss and the Truth Fund's gain, and the supply is permanently larger by that amount. This is the honest price of making the
token spendable at all. The season (a whole period at 90% before anything is spendable) is what keeps it small.

## The Truth Fund

Confiscated bonds are held, and any holder may burn $TRUE for `fund * amount / max(spendable + locked, 10,000)`. Locked tokens are counted in
the denominator so a later release can never leave the fund short. The 10,000 $TRUE minimum was added by a second audit: without it,
while the supply was small, a single miner whose claim survived a season could redeem the whole fund (2,000 tokens out of a supply of 2,000
is 100%) and keep the profit even if the claim was debunked afterwards. With it, one 2 NEAR mine can take at most a fifth. It is a floor
made of liars' money, not a yield: the fund is zero until a lie has been debunked, and a redemption burns the tokens.

The cost of a hole here, stated plainly: someone who mines an **unfalsifiable** claim at scale and releases it can redeem against the fund,
taking a share of bonds confiscated from other people's lies. They cannot get their own bond back (retiring requires holding every
released token, which a redemption burns), so the attack ties up its bond for as long as the claim lasts. It is a way for the fund to
leak into unfalsifiable claims, bounded by the fund's size.

## Attack surface and known limits

| Issue | Status |
|---|---|
| A flash pump mints almost nothing | Tested: two seconds at 95% moves a 30 s half-life average by about two percentage points, nowhere near the 70% a mint needs. |
| Calling `sync` early or late changes the average | Fixed by the exponential average; tested at 1, 2, 7, 50 and 1,000 pieces. |
| Retiring out of a debunk | Closed by a cooldown stamped from the price at every touch (a spot-price check alone could be walked around for about 2% in fees). Unit-tested, and the lie case on a real chain. |
| Sweeping the fund while the supply is small | Mitigated: redemption divides by at least 10,000 $TRUE. A bond-weighted share of the fund still goes to whoever holds tokens, honest or not. |
| Token accounts costing more storage than they pay | Fixed: registration now keeps 0.0025 NEAR (registration entry plus balance entry), up from 0.0015. |
| Debunking a true claim to grief its miner | Costs the attacker the market depth needed to hold the price down against verifiers who profit from correcting it; the bond goes to the Fund, not to the attacker. Not otherwise mitigated. |
| Minting against an unfalsifiable claim | Not mitigated. See above. |
| An honest miner who is not watching | Debunking is retroactive: the average credits the price that held over the whole interval at the next touch. A true claim crushed by a wrong or hostile price and left undefended for about two half-lives (to take the average from 94% under 30%) loses its bond, however long ago it was priced fairly. The defence is to buy YES, which the miner profits from if the claim is true. A miner is expected to watch, or to run a keeper that does. |
| Orphaned tokens after a debunk | Counted and shown; not recoverable. |
| Verifier collusion with a miner (verifiers decline to refute) | Not mitigated: a mine pays verifiers nothing for staying silent, but a colluding set simply does not check. The assumption in (1) above. |
| Wash trading to fake evidence backing | Costs about 2% a round trip. Backing is a spam filter, not a truth signal. |
| Topic and claim spam | Each claim costs 0.07 NEAR unrecoverable plus a seed of at least 0.5 NEAR (recoverable, less fees) and, for a mine, a bond. The server follows all claims; a deployment should cap what it renders. |
| Storage of token accounts | A receiver must be registered (NEP-145, 0.0025 NEAR kept), so transfers cannot be used to make the contract pay for storage. |
| Payouts to an account that no longer exists | The transfer fails and the NEAR stays in the contract; it is booked as `kept` and `stranded`, so the identity stays true and the amount is visible. |
| Front-running | Trades carry `min_shares` / `min_proceeds`. Nothing prevents sandwiching on a public mempool. |
| Prompt injection | Claim text and source text are untrusted data and the judge's output is a constrained schema checked in code. Not red-teamed. |
| Wikipedia as the only source | Pinned revisions are reproducible but Wikipedia is not truth. The provider is an interface. The agents read a revision at least 24 hours old (`MINE_MIN_REVISION_AGE_HOURS`) so a vandal's fresh edit is not cited. |
| The demo account's endpoints | `/api/demo/*` act as one funded account with no authentication, so the server now listens on 127.0.0.1 only (a second audit found it bound to every interface, so anyone on the same network could spend it). Set `HOST`/`host` to change that, and never on a server that holds a funded account. A demo hourly spending cap and one-action-at-a-time lock remain. |
| Upgrade key | The deploy key is a full-access key on the contract account. Delete it for an immutable contract; there is no admin function. |
| Money | Native NEAR is the collateral. The token has no market price here: the floor is the Fund, not a venue. |

## Two things the tests taught

* **A verifier has no edge on a truth already priced at 94%.** The first end-to-end test expected a researcher to post support evidence
  for the honest miner's claim. It correctly did nothing, because confirming the obvious pays nothing. Evidence appears where a price is
  wrong. The test now asserts that nothing happens, and the bond-settlement check moved to the skeptic's refuting evidence.
* **A random walk that never reaches a season proves little.** The first version of the 2,500-step walk was so chaotic that every claim
  was debunked before any reached a season, so release, transfer and redeem were never exercised. It now has a miner who defends one
  claim and a skeptic who attacks another, asserts that each path ran (a release, three debunks, 74 redemptions, 102 transfers), and
  ends with one mine taken through its whole life cycle on top of whatever state the walk left behind.

## What I have not verified

* **The second audit's fixes were verified after the fact, not by a new reading.** The retire cooldown, the 10,000 $TRUE redeem base and the
  0.0025 NEAR registration were written without running anything, then compiled and run: 43 contract tests (three added, one rewritten), 62
  TypeScript, 22 end-to-end and 11 UI checks all passed on the rebuilt WASM. A pass shows the fixes do what the tests say, not that the
  tests ask every question: the cooldown and the base are policy choices that no simulation has tuned.
* **Not deployed** to testnet or mainnet. The contract, the agents and the server ran against `near-sandbox` (a real nearcore node).
* **The wallet path** in a browser. The page acts through a server-held demo account; the wallet flow is not written.
* **A language-model judge** has not been run (no API key). The rule-based judge has, against real pinned Wikipedia. The model path
  (prompt, schema validation, quote check) is unit-tested with mocked replies only.
* **`ft_transfer_call`** is tested only on its failure branch (a receiver that cannot take the tokens: the whole amount is refunded). The
  success branch, where a receiving contract keeps some of them, follows the standard resolve algorithm and is untested.
* **Gas** was not measured on a worst case. `get_claims` returns 50 claims with 48-trade tapes; Verity measured the same shape at
  67.8 Tgas of the 200 a view call may use. The average adds eighteen integer multiplications per claim, which is negligible next to storage
  reads, but this contract has not been measured.
* **Economic parameters.** The ramp (70 and 90), the debunk line (30), the retire line (50), the 1,000-per-NEAR cap and the demo's half-life
  and season are choices, not results. No simulation of a population of miners and verifiers was run.
* **The pace is a demo setting.** The demo's verifiers hold a claim in an audit queue for 12 s (`MINE_AUDIT_DELAY_MS`) so that a lie visibly
  mints (a few hundred $TRUE at an 8 s half-life) before it is refuted. With a 6-hour half-life nothing would mint for hours, and verifiers
  would have hours to arrive. How the real balance between average, season and verifier latency should be set is not something I measured.
