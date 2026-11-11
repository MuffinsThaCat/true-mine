//! $TRUE: a token whose supply is mined from claims that are believed and burned when they stop being believed.
//!
//! Every claim is a binary market that never resolves (a fixed-product AMM over YES and NO shares, integer only, always
//! fully collateralised). A claim's price is the crowd's current confidence that it is true. On top of that sits a mine:
//!
//! 1. **Bond.** The author of a claim may bond NEAR against it (1 to 100 NEAR). The bond sets the mine's cap: 1,000 $TRUE
//!    per NEAR bonded. The bond is the only thing that can ever be slashed.
//! 2. **Time-averaged belief.** Each claim carries an exponential moving average of its price whose gap to the price halves
//!    every `half_life_secs`. A trade moves the price at once but moves the average only as time passes, so a pump that is
//!    not defended mints almost nothing. The average is exact however often it is read (halving twice for a minute each is
//!    halving once for two), so nobody gains by calling `sync` early or late. It starts at 50%: a claim has to earn its way up.
//! 3. **Mint.** While the average is above 70% the claim mints $TRUE up to its cap, in proportion (0 at 70%, the whole cap
//!    at 90%). Minted tokens are *locked* to the claim. They count in the supply, cannot be spent, and are burned the
//!    moment the average falls back under what justified them.
//! 4. **Season.** Locked tokens become spendable (`release`) only after the average has stayed at or above 90% for
//!    `season_secs`. Nothing about a claim is ever final, but a token that has sat through a full season of belief is a
//!    token the miner may hold.
//! 5. **Debunk.** At any time, with no deadline, if the average falls under 30%: every locked token is burned, the tokens
//!    already released are clawed back from the miner's balance (what the miner has already moved on is counted as
//!    `orphaned`), and the bond is slashed into the **Truth Fund**. The mine is dead; the claim keeps trading as a market.
//! 6. **Retire.** A miner who wants the bond back burns everything the claim ever minted (locked and released) and takes it.
//!    Not within a cooldown (a season, at least three half-lives) of any touch that found the price under 50%: a refuted claim
//!    cannot be retired out of its debunk, and lifting the price does not erase the touch that recorded it.
//! 7. **Floor.** Any holder may burn $TRUE for a pro-rata share of the Truth Fund (the confiscated bonds of lies), the supply
//!    counted as at least 10,000 $TRUE so a small early supply cannot sweep the fund.
//!
//! Nothing here asks an oracle anything. Truth is whatever the market is paid to correct it to; the mine only prices how
//! long a claim has been believed.
//!
//! Units. NEAR amounts are yocto. $TRUE has 18 decimals. Market arithmetic runs in "ticks" of 1e12 yocto so products of
//! reserves fit u128. The moving average is stored in units of 1e-4 basis point.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseResult,
};

#[cfg(test)]
mod tests;

const TICK: u128 = 1_000_000_000_000;
const BPS: u128 = 10_000;
const NEAR_Y: u128 = 1_000_000_000_000_000_000_000_000;
const TRUE_ONE: u128 = 1_000_000_000_000_000_000;

/// $TRUE mintable per NEAR of bond.
const MINT_PER_NEAR: u128 = 1_000;
const MIN_STAKE_Y: u128 = NEAR_Y;
const MAX_STAKE_Y: u128 = 100 * NEAR_Y;
/// Average above this mints; between this and `FULL_BPS` it mints in proportion.
const UP_BPS: u128 = 7_000;
const FULL_BPS: u128 = 9_000;
/// Average under this debunks the mine.
const DOWN_BPS: u128 = 3_000;
/// A touch that finds the price under this starts a cooldown before the mine can be retired.
const RETIRE_MIN_BPS: u128 = 5_000;
/// `redeem` divides the fund by at least this many $TRUE, so that while the supply is small nobody can sweep the whole fund.
const REDEEM_BASE: u128 = 10_000 * TRUE_ONE;
/// The average is stored in 1e-8 of a basis point.
const EMA_SCALE: u128 = 100_000_000;
const EMA_START_E8: u64 = 5_000 * 100_000_000;
/// 1.0 in the fixed point `decay_fp` works in, and ln 2 in the same.
const FP: i128 = 1_000_000_000_000_000_000;
const LN2_FP: i128 = 693_147_180_559_945_309;

const MIN_SEED_Y: u128 = 500_000_000_000_000_000_000_000;
const CLAIM_FEE_Y: u128 = 70_000_000_000_000_000_000_000;
const POSITION_FEE_Y: u128 = 2_000_000_000_000_000_000_000;
const MIN_TRADE_Y: u128 = 10_000_000_000_000_000_000_000;
const EVIDENCE_FEE_Y: u128 = 10_000_000_000_000_000_000_000;
const MIN_BOND_Y: u128 = 20_000_000_000_000_000_000_000;
const MAX_COLLATERAL_TICKS: u128 = 100_000_000_000_000_000;
const EVIDENCE_SURCHARGE_STEPS: u128 = 8;
/// Storage for one token account: 0.0025 NEAR. A holder costs a registration entry and a balance entry (about 0.0011 and 0.0013 NEAR
/// at 1e19 yocto a byte), and the first version kept only 0.0015, so each account was paid for at about two thirds.
const STORAGE_MIN_Y: u128 = 2_500_000_000_000_000_000_000;

const MAX_FEE_BPS: u16 = 300;
const MIN_PRIOR_BPS: u16 = 500;
const MAX_PRIOR_BPS: u16 = 9_500;
const TAPE_CAP: usize = 48;
const MAX_EVIDENCE_PER_CLAIM: usize = 64;
const MAX_EVIDENCE_PER_AUTHOR: usize = 8;
const MAX_TEXT: usize = 280;
const MAX_URI: usize = 300;
const MAX_TOPIC: usize = 64;

const GAS_ON_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Claims,
    Evidence,
    Positions,
    Balances,
    Registered,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Yes,
    No,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stance {
    Support,
    Refute,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BondState {
    Open,
    Refunded,
    Forfeited,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MineState {
    /// The claim is a plain market: nothing is bonded to it and it mints nothing.
    None,
    Mining,
    /// The miner took the bond back and burned everything the claim had minted.
    Retired,
    /// The market turned. The bond went to the Truth Fund and the claim's tokens were burned or clawed back.
    Debunked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TradeRec {
    pub ts_ms: u64,
    pub who: AccountId,
    pub side: Side,
    pub buy: bool,
    pub amount: U128,
    pub price_bps: u16,
    pub evidence: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Claim {
    id: u64,
    topic: String,
    text: String,
    creator: AccountId,
    created_ms: u64,
    r_yes: u128,
    r_no: u128,
    collateral: u128,
    user_yes: u128,
    user_no: u128,
    volume: u128,
    trades: u64,
    fee_pool_y: u128,
    evidence: Vec<u64>,
    tape: Vec<TradeRec>,
    mine: MineState,
    /// NEAR (yocto) bonded to the mine. Zero once retired or debunked.
    stake_y: u128,
    /// Moving average of the price, in 1e-8 bps, current as of `ema_ts_ms`.
    ema_e8: u64,
    ema_ts_ms: u64,
    /// Since when the average has stayed at or above `FULL_BPS`, as far as anyone has looked.
    full_since_ms: Option<u64>,
    /// The last time a touch found the price under `RETIRE_MIN_BPS`. Every price change is a touch, and a touch stamps this from the
    /// price that held before it, so lifting the price cannot erase it. `retire` waits out a cooldown from here.
    last_low_ms: Option<u64>,
    /// Minted to this claim and not yet spendable.
    locked: u128,
    /// Released to the miner (spendable) and not yet burned or clawed back.
    released: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Evidence {
    pub id: u64,
    pub claim_id: u64,
    pub author: AccountId,
    pub stance: Stance,
    pub uri: String,
    /// sha256 (lowercase hex) of the content the author fetched from `uri`. Anyone can re-fetch and compare.
    pub content_hash: String,
    pub note: String,
    pub bond: U128,
    pub backing: U128,
    pub independent: U128,
    pub posted_ms: u64,
    pub price_at_post_bps: u16,
    pub bond_state: BondState,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Default)]
struct Position {
    yes: u128,
    no: u128,
}

#[near(serializers = [json])]
pub struct MineView {
    pub state: MineState,
    pub stake: U128,
    /// The moving average of the price as of now, in basis points.
    pub ema_bps: u16,
    pub locked: U128,
    pub released: U128,
    /// What the claim would hold (locked + released) at the average as of now.
    pub target: U128,
    /// The mine has a debunking average and only waits for someone to call `sync`.
    pub debunk_due: bool,
    /// Milliseconds until the locked tokens can be released, if the average is at or above 90% (0 when they can be now).
    pub release_in_ms: Option<u64>,
    pub cap: U128,
}

#[near(serializers = [json])]
pub struct ClaimView {
    pub id: u64,
    pub topic: String,
    pub text: String,
    pub creator: AccountId,
    pub created_ms: u64,
    pub price_bps: u16,
    pub collateral: U128,
    pub reserve_yes: U128,
    pub reserve_no: U128,
    pub volume: U128,
    pub trades: u64,
    pub fee_pool: U128,
    pub evidence: Vec<u64>,
    pub tape: Vec<TradeRec>,
    pub mine: MineView,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub yes: U128,
    pub no: U128,
}

#[near(serializers = [json])]
pub struct QuoteView {
    pub out: U128,
    pub fee: U128,
    pub price_before_bps: u16,
    pub price_after_bps: u16,
}

#[near(serializers = [json])]
pub struct Accounting {
    pub total_in: U128,
    pub total_out: U128,
    /// Collateral + unpaid fees + open evidence bonds + live mining bonds + the Truth Fund.
    pub liabilities: U128,
    pub kept: U128,
    pub stranded: U128,
}

#[near(serializers = [json])]
pub struct Supply {
    /// Spendable tokens: what `ft_total_supply` reports and the sum of every balance.
    pub liquid: U128,
    /// Minted and held by live mines, not spendable.
    pub locked: U128,
    /// liquid + locked.
    pub total: U128,
    pub minted_total: U128,
    pub burned_total: U128,
    /// Tokens released by a mine that was debunked after the miner had already moved them on.
    pub orphaned: U128,
    /// NEAR (yocto) in the Truth Fund: the bonds of debunked mines, not yet redeemed.
    pub fund: U128,
    /// NEAR (yocto) one whole $TRUE redeems for today.
    pub floor_per_true: U128,
    pub mining: u64,
    pub debunked: u64,
    pub retired: u64,
}

#[near(serializers = [json])]
pub struct Config {
    pub fee_bps: u16,
    pub half_life_ms: u64,
    pub season_ms: u64,
    pub bond_window_ms: u64,
    pub claims: u64,
    pub evidence: u64,
    pub mint_per_near: u64,
    pub up_bps: u16,
    pub full_bps: u16,
    pub down_bps: u16,
}

#[near(serializers = [json])]
pub struct FtMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[ext_contract(ext_ft_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TrueMine {
    claims: Vector<Claim>,
    evidence: Vector<Evidence>,
    positions: LookupMap<(u64, AccountId), Position>,
    balances: LookupMap<AccountId, u128>,
    registered: LookupSet<AccountId>,
    half_life_ms: u64,
    season_ms: u64,
    bond_window_ms: u64,
    fee_bps: u16,
    total_in: u128,
    total_out: u128,
    kept: u128,
    stranded: u128,
    liabilities: u128,
    /// Spendable $TRUE. Equals the sum of `balances`.
    liquid_supply: u128,
    /// $TRUE held by live mines. Equals the sum of every claim's `locked`.
    locked_total: u128,
    minted_total: u128,
    burned_total: u128,
    orphaned: u128,
    /// Confiscated mining bonds, redeemable pro rata by $TRUE holders.
    fund_y: u128,
    n_mining: u64,
    n_debunked: u64,
    n_retired: u64,
}

// ── pure math ──────────────────────────────────────────────────────────────────────────────────────────

fn t2y(t: u128) -> u128 {
    t.checked_mul(TICK).unwrap_or_else(|| env::panic_str("amount overflow"))
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

fn isqrt_ceil(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x / 2 + 1;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    if x * x < n {
        x + 1
    } else {
        x
    }
}

fn price_bps(r_yes: u128, r_no: u128) -> u16 {
    let tot = r_yes + r_no;
    ((r_no * BPS / tot).clamp(1, BPS - 1)) as u16
}

struct BuyCalc {
    fee: u128,
    net: u128,
    shares: u128,
    r_yes: u128,
    r_no: u128,
}

fn buy_calc(r_yes: u128, r_no: u128, side: Side, amount: u128, fee_bps: u16) -> Result<BuyCalc, &'static str> {
    let fee = amount * u128::from(fee_bps) / BPS;
    let net = amount - fee;
    if net == 0 {
        return Err("amount too small");
    }
    let (r_b, r_o) = if side == Side::Yes { (r_yes, r_no) } else { (r_no, r_yes) };
    let k = r_b.checked_mul(r_o).ok_or("trade too large")?;
    let new_o = r_o + net;
    let new_b = ceil_div(k, new_o);
    let shares = (r_b + net).checked_sub(new_b).ok_or("pool arithmetic")?;
    if shares == 0 {
        return Err("amount too small");
    }
    let (r_yes, r_no) = if side == Side::Yes { (new_b, new_o) } else { (new_o, new_b) };
    Ok(BuyCalc { fee, net, shares, r_yes, r_no })
}

struct SellCalc {
    gross: u128,
    fee: u128,
    r_yes: u128,
    r_no: u128,
}

fn sell_calc(r_yes: u128, r_no: u128, side: Side, shares: u128, fee_bps: u16) -> Result<SellCalc, &'static str> {
    if shares == 0 {
        return Err("nothing to sell");
    }
    let (r_x, r_o) = if side == Side::Yes { (r_yes, r_no) } else { (r_no, r_yes) };
    let k = r_x.checked_mul(r_o).ok_or("trade too large")?;
    let a = r_x.checked_add(shares).ok_or("trade too large")?;
    let b = r_o;
    let diff = a.abs_diff(b);
    let d = diff.checked_mul(diff).and_then(|v| v.checked_add(k.checked_mul(4)?)).ok_or("trade too large")?;
    let sq = isqrt_ceil(d);
    let gross = (a + b).saturating_sub(sq) / 2;
    if gross == 0 {
        return Err("amount too small");
    }
    if gross >= b || gross >= a {
        return Err("pool arithmetic");
    }
    let new_x = a - gross;
    let new_o = b - gross;
    if new_x.checked_mul(new_o).ok_or("trade too large")? < k {
        return Err("pool arithmetic");
    }
    let fee = gross * u128::from(fee_bps) / BPS;
    let (r_yes, r_no) = if side == Side::Yes { (new_x, new_o) } else { (new_o, new_x) };
    Ok(SellCalc { gross, fee, r_yes, r_no })
}

/// 2^(-dt / half_life) in 1e18 fixed point: the whole half-lives by shifting, the remainder as exp(-ln2 * r) by its Taylor
/// series (eighteen terms, error far below 1e-17). Integer only, because NEAR's VM has no floating point.
pub fn decay_fp(dt_ms: u64, half_life_ms: u64) -> u128 {
    let whole = dt_ms / half_life_ms;
    if whole >= 60 {
        return 0;
    }
    let y = LN2_FP * i128::from(dt_ms % half_life_ms) / i128::from(half_life_ms);
    let mut term = FP;
    let mut sum = FP;
    for k in 1..=18i128 {
        term = term * y / FP / k;
        sum += if k % 2 == 1 { -term } else { term };
    }
    (sum.max(0) as u128) >> whole
}

/// One step of the moving average. The price has been `price_bps` for the last `dt_ms`; the gap between the average and the
/// price shrinks by 2^(-dt / half_life). Never overshoots, never leaves [old average, price], and two steps of a and b equal
/// one step of a + b (to within rounding), so how often the average is read does not change where it is.
pub fn ema_step(ema_e8: u64, price_bps: u16, dt_ms: u64, half_life_ms: u64) -> u64 {
    let p = i128::from(price_bps) * EMA_SCALE as i128;
    let e = i128::from(ema_e8);
    (p + (e - p) * decay_fp(dt_ms, half_life_ms) as i128 / FP) as u64
}

pub fn ema_bps_of(ema_e8: u64) -> u16 {
    (u128::from(ema_e8) / EMA_SCALE) as u16
}

/// 0 at or under 70%, the whole cap at 90% and over, linear between.
pub fn ramp_bps(ema_bps: u16) -> u128 {
    let e = u128::from(ema_bps);
    if e <= UP_BPS {
        0
    } else if e >= FULL_BPS {
        BPS
    } else {
        (e - UP_BPS) * BPS / (FULL_BPS - UP_BPS)
    }
}

/// The most a mine with this bond may ever hold, in $TRUE base units.
pub fn cap_of(stake_y: u128) -> u128 {
    // One NEAR is 1e24 yocto and one $TRUE is 1e18 base units, so a yocto of bond is worth MINT_PER_NEAR / 1e6 base units.
    stake_y * MINT_PER_NEAR / (NEAR_Y / TRUE_ONE)
}

fn valid_topic(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_TOPIC && s.bytes().all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b':' | b'/'))
}

fn valid_text(s: &str, min: usize, max: usize) -> bool {
    s.chars().count() >= min && s.len() <= max && !s.chars().any(|c| c.is_control())
}

fn valid_uri(s: &str) -> bool {
    s.len() <= MAX_URI
        && (s.starts_with("https://") || s.starts_with("http://") || s.starts_with("ipfs://"))
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn valid_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

// ── contract ───────────────────────────────────────────────────────────────────────────────────────────

#[near]
impl TrueMine {
    /// `half_life_secs`: how long the price average takes to close half of its gap to the price. `season_secs`: how long the
    /// average must stay at or above 90% before locked tokens may be released. `bond_window_secs`: evidence bond window.
    #[init]
    pub fn new(half_life_secs: u64, season_secs: u64, bond_window_secs: u64, fee_bps: u16) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee too high");
        require!((1..=30 * 86_400).contains(&half_life_secs), "half-life out of range");
        require!((1..=365 * 86_400).contains(&season_secs), "season out of range");
        require!((1..=30 * 86_400).contains(&bond_window_secs), "bond window out of range");
        Self {
            claims: Vector::new(Key::Claims),
            evidence: Vector::new(Key::Evidence),
            positions: LookupMap::new(Key::Positions),
            balances: LookupMap::new(Key::Balances),
            registered: LookupSet::new(Key::Registered),
            half_life_ms: half_life_secs * 1_000,
            season_ms: season_secs * 1_000,
            bond_window_ms: bond_window_secs * 1_000,
            fee_bps,
            total_in: 0,
            total_out: 0,
            kept: 0,
            stranded: 0,
            liabilities: 0,
            liquid_supply: 0,
            locked_total: 0,
            minted_total: 0,
            burned_total: 0,
            orphaned: 0,
            fund_y: 0,
            n_mining: 0,
            n_debunked: 0,
            n_retired: 0,
        }
    }

    // ── claims and markets ─────────────────────────────────

    /// Open a market for a claim. The deposit pays the 0.07 NEAR claim fee, the bond (if `stake` is given) and seeds the
    /// pool with the rest (at least 0.5 NEAR). `prior_bps` is the opening price of YES. With a `stake` of 1 to 100 NEAR the
    /// claim is also a mine; its average starts at 50% whatever the prior, so a claim cannot mint the moment it opens.
    #[payable]
    pub fn create_claim(&mut self, topic: String, text: String, prior_bps: u16, stake: Option<U128>) -> u64 {
        require!(valid_topic(&topic), "topic must be 1-64 chars of a-z 0-9 - _ : /");
        require!(valid_text(&text, 8, MAX_TEXT), "claim text must be 8 or more characters and at most 280 bytes, no control characters");
        let stake_y = stake.map_or(0, |s| s.0);
        if stake_y > 0 {
            require!((MIN_STAKE_Y..=MAX_STAKE_Y).contains(&stake_y), "stake must be between 1 and 100 NEAR");
        }
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > stake_y, "deposit does not cover the stake");
        self.total_in += deposit;
        self.open_market(topic, text, prior_bps, deposit - stake_y, stake_y)
    }

    /// Attach a source to a claim. The deposit is a non-refundable storage fee, a surcharge that grows with the number of
    /// pieces already attached, and a bond that comes back (via `settle_bond`) only if capital follows the evidence.
    #[payable]
    pub fn post_evidence(&mut self, claim_id: u64, stance: Stance, uri: String, content_hash: String, note: String) -> u64 {
        let mut c = self.claim(claim_id);
        require!(valid_uri(&uri), "uri must be http(s):// or ipfs:// with no spaces, at most 300 chars");
        require!(valid_hash(&content_hash), "content_hash must be 64 lowercase hex chars (sha256)");
        require!(valid_text(&note, 0, MAX_TEXT), "note must be at most 280 bytes, no control characters");
        let author = env::predecessor_account_id();
        let mine = c.evidence.iter().filter(|e| self.evidence.get(**e as u32).map_or(false, |x| x.author == author)).count();
        require!(mine < MAX_EVIDENCE_PER_AUTHOR, "you have already posted the maximum evidence on this claim");
        let count = c.evidence.len() as u128;
        if c.evidence.len() >= MAX_EVIDENCE_PER_CLAIM {
            let stale = c.evidence.iter().position(|e| self.evidence.get(*e as u32).map_or(false, |x| x.bond_state == BondState::Forfeited));
            match stale {
                Some(i) => {
                    c.evidence.remove(i);
                }
                None => env::panic_str("claim already has the maximum evidence"),
            }
        }
        let surcharge = EVIDENCE_FEE_Y * count / EVIDENCE_SURCHARGE_STEPS;
        let deposit = env::attached_deposit().as_yoctonear();
        let need = EVIDENCE_FEE_Y + surcharge + MIN_BOND_Y;
        if deposit < need {
            env::panic_str(&format!("attach at least {need} yoctoNEAR: the 0.01 NEAR fee, {surcharge} for the {count} pieces already attached, and a bond of at least 0.02 NEAR"));
        }
        self.total_in += deposit;
        self.kept += EVIDENCE_FEE_Y;
        c.fee_pool_y += surcharge;
        self.liabilities += deposit - EVIDENCE_FEE_Y;
        let id = u64::from(self.evidence.len());
        let ev = Evidence {
            id,
            claim_id,
            author,
            stance,
            uri,
            content_hash,
            note,
            bond: U128(deposit - EVIDENCE_FEE_Y - surcharge),
            backing: U128(0),
            independent: U128(0),
            posted_ms: env::block_timestamp_ms(),
            price_at_post_bps: price_bps(c.r_yes, c.r_no),
            bond_state: BondState::Open,
        };
        c.evidence.push(id);
        self.evidence.push(ev);
        self.save(c);
        self.event("evidence", json!({"id": id, "claim_id": claim_id, "stance": stance}));
        id
    }

    /// Buy YES or NO shares with the attached deposit. Optionally cite evidence whose stance matches the side.
    /// The claim's mine is brought up to date first, against the average as it stood before this trade.
    #[payable]
    pub fn buy(&mut self, claim_id: u64, side: Side, min_shares: U128, evidence_id: Option<u64>) -> U128 {
        let who = env::predecessor_account_id();
        let mut c = self.claim(claim_id);
        self.settle_mine(&mut c);
        let mut deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= MIN_TRADE_Y, "minimum trade is 0.01 NEAR");
        self.total_in += deposit;

        let key = (claim_id, who.clone());
        let mut pos = self.positions.get(&key).copied();
        if pos.is_none() {
            require!(deposit > POSITION_FEE_Y, "deposit too small to open a position");
            deposit -= POSITION_FEE_Y;
            self.kept += POSITION_FEE_Y;
        }
        let ticks = deposit / TICK;
        self.kept += deposit - t2y(ticks);
        let calc = buy_calc(c.r_yes, c.r_no, side, ticks, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        require!(calc.shares >= min_shares.0 / TICK, "slippage: fewer shares than min_shares");
        require!(c.collateral + calc.net <= MAX_COLLATERAL_TICKS, "market is at its collateral cap");

        if let Some(eid) = evidence_id {
            let mut ev = self.evidence.get(eid as u32).cloned().unwrap_or_else(|| env::panic_str("no such evidence"));
            require!(ev.claim_id == claim_id, "evidence belongs to a different claim");
            let want = if side == Side::Yes { Stance::Support } else { Stance::Refute };
            require!(ev.stance == want, "cited evidence has the opposite stance to this trade");
            ev.backing = U128(ev.backing.0 + t2y(ticks));
            if ev.author != who {
                ev.independent = U128(ev.independent.0 + t2y(ticks));
            }
            self.evidence.replace(eid as u32, ev);
        }

        c.r_yes = calc.r_yes;
        c.r_no = calc.r_no;
        c.collateral += calc.net;
        c.fee_pool_y += t2y(calc.fee);
        self.liabilities += t2y(calc.net) + t2y(calc.fee);
        c.volume += ticks;
        c.trades += 1;
        let mut p = pos.take().unwrap_or_default();
        if side == Side::Yes {
            c.user_yes += calc.shares;
            p.yes += calc.shares;
        } else {
            c.user_no += calc.shares;
            p.no += calc.shares;
        }
        self.positions.insert(key, p);
        self.push_tape(&mut c, &who, side, true, t2y(ticks), evidence_id);
        self.check_solvent(&c);
        self.save(c);
        U128(t2y(calc.shares))
    }

    /// Sell shares back to the pool. Pays the caller immediately. Returns NEAR paid after fee (yocto).
    pub fn sell(&mut self, claim_id: u64, side: Side, shares: U128, min_proceeds: U128) -> U128 {
        let who = env::predecessor_account_id();
        let mut c = self.claim(claim_id);
        self.settle_mine(&mut c);
        let key = (claim_id, who.clone());
        let mut p = self.positions.get(&key).copied().unwrap_or_default();
        let s = shares.0 / TICK;
        let held = if side == Side::Yes { p.yes } else { p.no };
        require!(s > 0, "nothing to sell");
        require!(s <= held, "you do not hold that many shares");
        let calc = sell_calc(c.r_yes, c.r_no, side, s, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        let net = calc.gross - calc.fee;
        require!(t2y(net) >= min_proceeds.0, "slippage: proceeds below min_proceeds");

        c.r_yes = calc.r_yes;
        c.r_no = calc.r_no;
        c.collateral -= calc.gross;
        c.fee_pool_y += t2y(calc.fee);
        self.liabilities -= t2y(net);
        c.volume += calc.gross;
        c.trades += 1;
        if side == Side::Yes {
            c.user_yes -= s;
            p.yes -= s;
        } else {
            c.user_no -= s;
            p.no -= s;
        }
        self.positions.insert(key, p);
        self.push_tape(&mut c, &who, side, false, t2y(calc.gross), None);
        self.check_solvent(&c);
        self.save(c);
        self.pay(&who, t2y(net));
        U128(t2y(net))
    }

    /// After the bond window, anyone can settle an evidence bond: refunded if trades citing it total at least the bond,
    /// otherwise forfeited to the claim's fee pool.
    pub fn settle_bond(&mut self, evidence_id: u64) -> BondState {
        let mut ev = self.evidence.get(evidence_id as u32).cloned().unwrap_or_else(|| env::panic_str("no such evidence"));
        require!(ev.bond_state == BondState::Open, "bond already settled");
        require!(env::block_timestamp_ms() >= ev.posted_ms + self.bond_window_ms, "bond window still open");
        if ev.backing.0 >= ev.bond.0 {
            ev.bond_state = BondState::Refunded;
            let (author, bond) = (ev.author.clone(), ev.bond.0);
            self.evidence.replace(evidence_id as u32, ev);
            self.liabilities -= bond;
            self.pay(&author, bond);
            BondState::Refunded
        } else {
            ev.bond_state = BondState::Forfeited;
            let mut c = self.claim(ev.claim_id);
            c.fee_pool_y += ev.bond.0;
            self.evidence.replace(evidence_id as u32, ev);
            self.save(c);
            BondState::Forfeited
        }
    }

    /// The claim's creator collects trading fees and forfeited evidence bonds.
    pub fn withdraw_fees(&mut self, claim_id: u64) -> U128 {
        let mut c = self.claim(claim_id);
        require!(env::predecessor_account_id() == c.creator, "only the claim's creator can withdraw fees");
        let amount = c.fee_pool_y;
        require!(amount > 0, "no fees to withdraw");
        c.fee_pool_y = 0;
        let creator = c.creator.clone();
        self.save(c);
        self.liabilities -= amount;
        self.pay(&creator, amount);
        U128(amount)
    }

    // ── the mine ───────────────────────────────────────────

    /// Bring a claim's mine up to date: advance the average to now, then mint, burn or debunk as it says. Anyone may call
    /// this at any time; nothing is paid for it. Returns the tokens held by the claim (locked + released) afterwards.
    pub fn sync(&mut self, claim_id: u64) -> U128 {
        let mut c = self.claim(claim_id);
        self.settle_mine(&mut c);
        let held = c.locked + c.released;
        self.save(c);
        U128(held)
    }

    /// The miner moves the claim's locked tokens into their own balance. Allowed only once the average has stayed at or
    /// above 90% for a whole season. Returns the amount released.
    pub fn release(&mut self, claim_id: u64) -> U128 {
        let who = env::predecessor_account_id();
        let mut c = self.claim(claim_id);
        require!(who == c.creator, "only the claim's miner can release its tokens");
        self.settle_mine(&mut c);
        require!(c.mine == MineState::Mining, "the claim is not being mined");
        let since = c.full_since_ms.unwrap_or_else(|| env::panic_str("the average is not at 90% yet"));
        require!(env::block_timestamp_ms() >= since + self.season_ms, "the claim has not been believed for a full season yet");
        let amount = c.locked;
        require!(amount > 0, "nothing locked to release");
        c.locked = 0;
        c.released += amount;
        self.locked_total -= amount;
        self.credit(&who, amount);
        self.save(c);
        self.event("release", json!({"claim_id": claim_id, "miner": who, "amount": U128(amount)}));
        log!("EVENT_JSON:{}", json!({"standard": "nep141", "version": "1.0.0", "event": "ft_mint", "data": [{"owner_id": who, "amount": U128(amount), "memo": "release"}]}));
        U128(amount)
    }

    /// The miner closes the mine and takes the bond back. Everything the claim ever minted must go: locked tokens are
    /// burned and the released ones are taken from the miner's balance, which must still hold them.
    pub fn retire(&mut self, claim_id: u64) -> U128 {
        let who = env::predecessor_account_id();
        let mut c = self.claim(claim_id);
        require!(who == c.creator, "only the claim's miner can retire it");
        self.settle_mine(&mut c);
        require!(c.mine == MineState::Mining, "the claim is not being mined");
        // The average lags the price on purpose, so a miner who watched a refutation land could otherwise walk away with the bond
        // before the average crossed 30%. Checking the price *now* is not enough: buying YES to lift it, retiring, and selling back
        // costs about two percent in fees. So a claim the market disbelieved at any touch within the cooldown cannot be retired,
        // and lifting the price cannot erase that, because the lifting trade is itself a touch that stamps the low price.
        require!(
            c.last_low_ms.map_or(true, |t| env::block_timestamp_ms() >= t + self.retire_cooldown_ms()),
            "the market disbelieved this claim within the last season: a refuted claim waits to be debunked and cannot be retired"
        );
        require!(self.balance(&who) >= c.released, "you no longer hold every token this claim released; get them back to retire it");
        let (locked, released) = (c.locked, c.released);
        self.locked_total -= locked;
        self.debit(&who, released);
        self.liquid_supply -= released;
        self.burned_total += locked + released;
        c.locked = 0;
        c.released = 0;
        let stake = c.stake_y;
        c.stake_y = 0;
        c.mine = MineState::Retired;
        c.full_since_ms = None;
        self.n_mining -= 1;
        self.n_retired += 1;
        self.liabilities -= stake;
        self.save(c);
        self.pay(&who, stake);
        self.event("retire", json!({"claim_id": claim_id, "miner": who, "burned": U128(locked + released), "stake": U128(stake)}));
        U128(stake)
    }

    /// Burn $TRUE for the same share of the Truth Fund that it is of the whole supply (locked tokens included, so a later
    /// release can never leave the fund short), the supply counted as at least `REDEEM_BASE` so that while it is small nobody can
    /// redeem a large part of the fund with a few thousand tokens. Returns the NEAR paid.
    pub fn redeem(&mut self, amount: U128) -> U128 {
        let who = env::predecessor_account_id();
        let supply_t = (self.liquid_supply + self.locked_total).max(REDEEM_BASE) / TICK;
        let amount_t = amount.0 / TICK;
        require!(amount_t > 0 && supply_t > 0, "amount too small");
        require!(self.balance(&who) >= amount.0, "you do not hold that many $TRUE");
        let fund_t = self.fund_y / TICK;
        let payout = t2y(fund_t * amount_t / supply_t);
        require!(payout > 0, "the Truth Fund has nothing to pay for that amount");
        self.debit(&who, amount.0);
        self.liquid_supply -= amount.0;
        self.burned_total += amount.0;
        self.fund_y -= payout;
        self.liabilities -= payout;
        self.pay(&who, payout);
        self.event("redeem", json!({"holder": who, "burned": amount, "paid": U128(payout)}));
        U128(payout)
    }

    // ── $TRUE as a NEP-141 token ───────────────────────────

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.transfer_internal(&sender, &receiver_id, amount.0, memo);
    }

    #[payable]
    pub fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        assert_one_yocto();
        require!(env::prepaid_gas() > GAS_ON_TRANSFER.saturating_add(GAS_RESOLVE).saturating_add(Gas::from_tgas(10)), "not enough gas attached");
        let sender = env::predecessor_account_id();
        self.transfer_internal(&sender, &receiver_id, amount.0, memo);
        ext_ft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_RESOLVE).ft_resolve_transfer(sender, receiver_id, amount))
            .into()
    }

    /// Returns the amount actually used by the receiver; whatever it did not use goes back to the sender.
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => serde_json::from_slice::<U128>(&bytes).map_or(amount.0, |u| u.0.min(amount.0)),
            PromiseResult::Failed => amount.0,
        };
        if unused == 0 {
            return amount;
        }
        let refund = unused.min(self.balance(&receiver_id));
        if refund == 0 {
            return amount;
        }
        self.move_tokens(&receiver_id, &sender_id, refund);
        U128(amount.0 - refund)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.liquid_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn ft_metadata(&self) -> FtMetadata {
        FtMetadata {
            spec: "ft-1.0.0".into(),
            name: "TRUE".into(),
            symbol: "TRUE".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    /// NEP-145. Registers `account_id` (or the caller) for 0.0025 NEAR; anything above that is refunded.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit().as_yoctonear();
        self.total_in += deposit;
        if self.registered.contains(&who) {
            self.pay(&env::predecessor_account_id(), deposit);
        } else {
            require!(deposit >= STORAGE_MIN_Y, "attach at least 0.0025 NEAR to register");
            self.registered.insert(who);
            self.kept += STORAGE_MIN_Y;
            self.pay(&env::predecessor_account_id(), deposit - STORAGE_MIN_Y);
        }
        StorageBalance { total: U128(STORAGE_MIN_Y), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.registered.contains(&account_id).then(|| StorageBalance { total: U128(STORAGE_MIN_Y), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_MIN_Y), max: Some(U128(STORAGE_MIN_Y)) }
    }

    /// Called after every payout. A failed transfer stops counting as paid out and is booked as kept and stranded.
    #[private]
    pub fn on_paid(&mut self, amount: U128) {
        let delivered = env::promise_results_count() == 1 && matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !delivered {
            self.total_out -= amount.0;
            self.kept += amount.0;
            self.stranded += amount.0;
            self.event("stranded", json!({"amount": amount}));
        }
    }

    // ── views ──────────────────────────────────────────────

    pub fn get_config(&self) -> Config {
        Config {
            fee_bps: self.fee_bps,
            half_life_ms: self.half_life_ms,
            season_ms: self.season_ms,
            bond_window_ms: self.bond_window_ms,
            claims: u64::from(self.claims.len()),
            evidence: u64::from(self.evidence.len()),
            mint_per_near: MINT_PER_NEAR as u64,
            up_bps: UP_BPS as u16,
            full_bps: FULL_BPS as u16,
            down_bps: DOWN_BPS as u16,
        }
    }

    pub fn get_claim(&self, claim_id: u64) -> Option<ClaimView> {
        self.claims.get(claim_id as u32).map(|c| self.view(c))
    }

    pub fn get_claims(&self, from_index: u64, limit: u64) -> Vec<ClaimView> {
        let n = u64::from(self.claims.len());
        (from_index..n.min(from_index.saturating_add(limit.min(50))))
            .filter_map(|i| self.claims.get(i as u32))
            .map(|c| self.view(c))
            .collect()
    }

    pub fn get_evidence(&self, evidence_id: u64) -> Option<Evidence> {
        self.evidence.get(evidence_id as u32).cloned()
    }

    pub fn get_claim_evidence(&self, claim_id: u64) -> Vec<Evidence> {
        self.claims
            .get(claim_id as u32)
            .map(|c| c.evidence.iter().filter_map(|e| self.evidence.get(*e as u32)).cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_evidence_page(&self, from_index: u64, limit: Option<u64>) -> Vec<Evidence> {
        let n = u64::from(self.evidence.len());
        let to = n.min(from_index.saturating_add(limit.unwrap_or(100).min(100)));
        (from_index..to).filter_map(|i| self.evidence.get(i as u32).cloned()).collect()
    }

    pub fn get_position(&self, claim_id: u64, account: AccountId) -> PositionView {
        let p = self.positions.get(&(claim_id, account)).copied().unwrap_or_default();
        PositionView { yes: U128(t2y(p.yes)), no: U128(t2y(p.no)) }
    }

    pub fn quote_buy(&self, claim_id: u64, side: Side, amount: U128, account: Option<AccountId>) -> QuoteView {
        let c = self.claim(claim_id);
        let mut paid = amount.0;
        if let Some(a) = account {
            if self.positions.get(&(claim_id, a)).is_none() {
                paid = paid.saturating_sub(POSITION_FEE_Y);
            }
        }
        let ticks = paid / TICK;
        let calc = buy_calc(c.r_yes, c.r_no, side, ticks, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        QuoteView {
            out: U128(t2y(calc.shares)),
            fee: U128(t2y(calc.fee)),
            price_before_bps: price_bps(c.r_yes, c.r_no),
            price_after_bps: price_bps(calc.r_yes, calc.r_no),
        }
    }

    pub fn quote_sell(&self, claim_id: u64, side: Side, shares: U128) -> QuoteView {
        let c = self.claim(claim_id);
        let calc = sell_calc(c.r_yes, c.r_no, side, shares.0 / TICK, self.fee_bps).unwrap_or_else(|e| env::panic_str(e));
        QuoteView {
            out: U128(t2y(calc.gross - calc.fee)),
            fee: U128(t2y(calc.fee)),
            price_before_bps: price_bps(c.r_yes, c.r_no),
            price_after_bps: price_bps(calc.r_yes, calc.r_no),
        }
    }

    pub fn get_supply(&self) -> Supply {
        let total = self.liquid_supply + self.locked_total;
        let total_t = total.max(REDEEM_BASE) / TICK;
        let floor = t2y(self.fund_y / TICK * (TRUE_ONE / TICK) / total_t);
        Supply {
            liquid: U128(self.liquid_supply),
            locked: U128(self.locked_total),
            total: U128(total),
            minted_total: U128(self.minted_total),
            burned_total: U128(self.burned_total),
            orphaned: U128(self.orphaned),
            fund: U128(self.fund_y),
            floor_per_true: U128(floor),
            mining: self.n_mining,
            debunked: self.n_debunked,
            retired: self.n_retired,
        }
    }

    pub fn get_accounting(&self) -> Accounting {
        Accounting { total_in: U128(self.total_in), total_out: U128(self.total_out), liabilities: U128(self.liabilities), kept: U128(self.kept), stranded: U128(self.stranded) }
    }
}

// ── internals ──────────────────────────────────────────────────────────────────────────────────────────

impl TrueMine {
    fn claim(&self, id: u64) -> Claim {
        self.claims.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no such claim"))
    }

    fn save(&mut self, c: Claim) {
        let id = c.id as u32;
        self.claims.replace(id, c);
    }

    fn event(&self, name: &str, data: serde_json::Value) {
        log!("EVENT_JSON:{}", json!({"standard": "true_mine", "version": "1.0.0", "event": name, "data": data}));
    }

    fn pay(&mut self, to: &AccountId, amount_y: u128) {
        if amount_y == 0 {
            return;
        }
        self.total_out += amount_y;
        let _ = Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount_y))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).on_paid(U128(amount_y)));
    }

    /// How long a claim must have gone without a touch finding its price under 50% before it can be retired: a season, and never
    /// less than three half-lives, which is longer than a refuted claim's average needs to fall under 30%.
    fn retire_cooldown_ms(&self) -> u64 {
        self.season_ms.max(3 * self.half_life_ms)
    }

    fn balance(&self, a: &AccountId) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }

    /// Tokens that become spendable for the first time (a release): they were locked, so the liquid supply grows.
    fn credit(&mut self, a: &AccountId, amount: u128) {
        let b = self.balance(a);
        self.balances.insert(a.clone(), b + amount);
        self.liquid_supply += amount;
    }

    /// Moves spendable tokens between balances; the supply does not change.
    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        self.debit(from, amount);
        let b = self.balance(to);
        self.balances.insert(to.clone(), b + amount);
    }

    /// Removes tokens from a balance without touching the supply counters: the caller books the burn or the move.
    fn debit(&mut self, a: &AccountId, amount: u128) {
        let b = self.balance(a);
        require!(b >= amount, "insufficient $TRUE balance");
        if b == amount {
            self.balances.remove(a);
        } else {
            self.balances.insert(a.clone(), b - amount);
        }
    }

    fn transfer_internal(&mut self, from: &AccountId, to: &AccountId, amount: u128, memo: Option<String>) {
        require!(from != to, "sender and receiver must differ");
        require!(amount > 0, "amount must be positive");
        require!(self.registered.contains(to), "the receiver has not registered: call storage_deposit for it first");
        self.move_tokens(from, to, amount);
        log!("EVENT_JSON:{}", json!({"standard": "nep141", "version": "1.0.0", "event": "ft_transfer", "data": [{"old_owner_id": from, "new_owner_id": to, "amount": U128(amount), "memo": memo}]}));
    }

    fn check_solvent(&self, c: &Claim) {
        require!(
            c.collateral == c.r_yes + c.user_yes && c.collateral == c.r_no + c.user_no,
            "invariant violated: pool is not fully collateralised"
        );
    }

    fn push_tape(&self, c: &mut Claim, who: &AccountId, side: Side, buy: bool, amount_y: u128, evidence: Option<u64>) {
        if c.tape.len() >= TAPE_CAP {
            c.tape.remove(0);
        }
        c.tape.push(TradeRec {
            ts_ms: env::block_timestamp_ms(),
            who: who.clone(),
            side,
            buy,
            amount: U128(amount_y),
            price_bps: price_bps(c.r_yes, c.r_no),
            evidence,
        });
    }

    /// Advance the average to now using the price that has held since it was last advanced, then apply what it says to the
    /// mine. Called before any trade moves the price, so a trade is never credited to the interval before it.
    fn settle_mine(&mut self, c: &mut Claim) {
        let now = env::block_timestamp_ms();
        let dt = now.saturating_sub(c.ema_ts_ms);
        c.ema_e8 = ema_step(c.ema_e8, price_bps(c.r_yes, c.r_no), dt, self.half_life_ms);
        c.ema_ts_ms = now.max(c.ema_ts_ms);
        if c.mine != MineState::Mining {
            return;
        }
        // The price has not changed since the last touch (a price change is a touch), so what it is now is what held until now.
        if u128::from(price_bps(c.r_yes, c.r_no)) < RETIRE_MIN_BPS {
            c.last_low_ms = Some(now);
        }
        let ema = ema_bps_of(c.ema_e8);
        if u128::from(ema) >= FULL_BPS {
            if c.full_since_ms.is_none() {
                c.full_since_ms = Some(now);
            }
        } else {
            c.full_since_ms = None;
        }
        if u128::from(ema) < DOWN_BPS {
            self.debunk(c);
            return;
        }
        let desired = cap_of(c.stake_y) * ramp_bps(ema) / BPS;
        let have = c.locked + c.released;
        if desired > have {
            let d = desired - have;
            c.locked += d;
            self.locked_total += d;
            self.minted_total += d;
            self.event("mint", json!({"claim_id": c.id, "amount": U128(d), "ema_bps": ema}));
        } else if desired < have {
            let burn = (have - desired).min(c.locked);
            if burn > 0 {
                c.locked -= burn;
                self.locked_total -= burn;
                self.burned_total += burn;
                self.event("burn", json!({"claim_id": c.id, "amount": U128(burn), "ema_bps": ema}));
            }
        }
    }

    /// The average fell under 30%: burn what is locked, take back what was released (as far as the miner still holds it),
    /// and confiscate the bond into the Truth Fund.
    fn debunk(&mut self, c: &mut Claim) {
        let miner = c.creator.clone();
        let locked = c.locked;
        self.locked_total -= locked;
        let released = c.released;
        let held = self.balance(&miner);
        let clawed = released.min(held);
        if clawed > 0 {
            self.debit(&miner, clawed);
            self.liquid_supply -= clawed;
        }
        self.orphaned += released - clawed;
        self.burned_total += locked + clawed;
        let stake = c.stake_y;
        self.fund_y += stake;
        c.stake_y = 0;
        c.locked = 0;
        c.released = 0;
        c.mine = MineState::Debunked;
        c.full_since_ms = None;
        self.n_mining -= 1;
        self.n_debunked += 1;
        self.event(
            "debunk",
            json!({"claim_id": c.id, "miner": miner, "burned_locked": U128(locked), "clawed_back": U128(clawed), "orphaned": U128(released - clawed), "slashed": U128(stake)}),
        );
        if clawed > 0 {
            log!("EVENT_JSON:{}", json!({"standard": "nep141", "version": "1.0.0", "event": "ft_burn", "data": [{"owner_id": miner, "amount": U128(clawed), "memo": "debunk"}]}));
        }
    }

    fn open_market(&mut self, topic: String, text: String, prior_bps: u16, deposit: u128, stake_y: u128) -> u64 {
        require!((MIN_PRIOR_BPS..=MAX_PRIOR_BPS).contains(&prior_bps), "prior must be between 500 and 9500 bps");
        require!(deposit >= CLAIM_FEE_Y, "deposit does not cover the claim fee");
        let seed_y = deposit - CLAIM_FEE_Y;
        let seed = seed_y / TICK;
        require!(t2y(seed) >= MIN_SEED_Y, "seed must be at least 0.5 NEAR after the 0.07 NEAR claim fee");
        require!(seed <= MAX_COLLATERAL_TICKS, "seed above the per-market cap");
        self.kept += CLAIM_FEE_Y + (seed_y - t2y(seed));
        self.liabilities += t2y(seed) + stake_y;

        let p = u128::from(prior_bps);
        let (r_yes, r_no, user_yes, user_no) = if p <= BPS / 2 {
            let rn = seed * p / (BPS - p);
            (seed, rn, 0, seed - rn)
        } else {
            let ry = seed * (BPS - p) / p;
            (ry, seed, seed - ry, 0)
        };

        let id = u64::from(self.claims.len());
        let creator = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let mine = if stake_y > 0 { MineState::Mining } else { MineState::None };
        if stake_y > 0 {
            self.n_mining += 1;
            self.registered.insert(creator.clone());
        }
        let c = Claim {
            id,
            topic: topic.clone(),
            text,
            creator: creator.clone(),
            created_ms: now,
            r_yes,
            r_no,
            collateral: seed,
            user_yes,
            user_no,
            volume: 0,
            trades: 0,
            fee_pool_y: 0,
            evidence: Vec::new(),
            tape: Vec::new(),
            mine,
            stake_y,
            ema_e8: EMA_START_E8,
            ema_ts_ms: now,
            full_since_ms: None,
            last_low_ms: None,
            locked: 0,
            released: 0,
        };
        self.check_solvent(&c);
        if user_yes + user_no > 0 {
            self.positions.insert((id, creator.clone()), Position { yes: user_yes, no: user_no });
        }
        self.claims.push(c);
        self.event("claim", json!({"id": id, "topic": topic, "creator": creator, "prior_bps": prior_bps, "stake": U128(stake_y)}));
        id
    }

    fn view(&self, c: &Claim) -> ClaimView {
        let now = env::block_timestamp_ms();
        let price = price_bps(c.r_yes, c.r_no);
        let e8 = ema_step(c.ema_e8, price, now.saturating_sub(c.ema_ts_ms), self.half_life_ms);
        let ema = ema_bps_of(e8);
        let mining = c.mine == MineState::Mining;
        let target = if mining { cap_of(c.stake_y) * ramp_bps(ema) / BPS } else { 0 };
        let release_in_ms = if mining && u128::from(ema) >= FULL_BPS {
            let since = c.full_since_ms.unwrap_or(now);
            Some((since + self.season_ms).saturating_sub(now))
        } else {
            None
        };
        ClaimView {
            id: c.id,
            topic: c.topic.clone(),
            text: c.text.clone(),
            creator: c.creator.clone(),
            created_ms: c.created_ms,
            price_bps: price,
            collateral: U128(t2y(c.collateral)),
            reserve_yes: U128(t2y(c.r_yes)),
            reserve_no: U128(t2y(c.r_no)),
            volume: U128(t2y(c.volume)),
            trades: c.trades,
            fee_pool: U128(c.fee_pool_y),
            evidence: c.evidence.clone(),
            tape: c.tape.clone(),
            mine: MineView {
                state: c.mine,
                stake: U128(c.stake_y),
                ema_bps: ema,
                locked: U128(c.locked),
                released: U128(c.released),
                target: U128(target),
                debunk_due: mining && u128::from(ema) < DOWN_BPS,
                release_in_ms,
                cap: U128(cap_of(c.stake_y)),
            },
        }
    }
}
