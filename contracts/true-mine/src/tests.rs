use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const N: u128 = NEAR_Y;
const T: u128 = TRUE_ONE;
const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
/// The average closes half its gap to the price every 30 s.
const HALF: u64 = 30;
/// Long enough for the average to have caught the price to within 1.6% of the gap (six half-lives).
const WINDOW: u64 = 6 * HALF;
const SEASON: u64 = 300;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, deposit: u128, ts_s: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acct(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_s * 1_000_000_000)
        .build());
}

fn fresh() -> TrueMine {
    ctx("deployer.near", 0, 1);
    TrueMine::new(HALF, SEASON, 60, 100)
}

/// A mined claim opened by alice: `stake` NEAR bonded, a 5 NEAR seed, opening at `prior`.
fn mined(v: &mut TrueMine, stake: u128, prior: u16, ts: u64) -> u64 {
    ctx("alice.near", CLAIM_FEE_Y + 5 * N + stake * N, ts);
    v.create_claim("pluto".into(), "Pluto is a dwarf planet.".into(), prior, Some(U128(stake * N)))
}

fn plain(v: &mut TrueMine, prior: u16, ts: u64) -> u64 {
    ctx("alice.near", CLAIM_FEE_Y + 5 * N, ts);
    v.create_claim("pluto".into(), "Pluto is a dwarf planet.".into(), prior, None)
}

fn price(v: &TrueMine, id: u64) -> u16 {
    v.get_claim(id).unwrap().price_bps
}

/// Buys until the price has crossed `target` (above it for Yes, below it for No).
fn push(v: &mut TrueMine, id: u64, who: &str, side: Side, target: u16, ts: u64) {
    for _ in 0..600 {
        let p = price(v, id);
        if (side == Side::Yes && p >= target) || (side == Side::No && p <= target) {
            return;
        }
        // The biggest step whose quoted price stays within 300 bps of the target, so the price lands close to where it was asked to.
        let sizes = [2 * N, N, N / 2, N / 5, N / 10, N / 20, N / 50, N / 100];
        let pick = sizes
            .iter()
            .copied()
            .find(|s| {
                let after = v.quote_buy(id, side, U128(*s), None).price_after_bps;
                if side == Side::Yes { after <= target + 300 } else { after + 300 >= target }
            })
            .unwrap_or(N / 100);
        ctx(who, pick, ts);
        v.buy(id, side, U128(0), None);
    }
    panic!("could not push the price to {target}");
}

fn register(v: &mut TrueMine, who: &str, ts: u64) {
    ctx(who, STORAGE_MIN_Y, ts);
    v.storage_deposit(None, None);
}

fn audit(v: &TrueMine, holders: &[&str]) {
    let a = v.get_accounting();
    assert_eq!(a.total_in.0 - a.total_out.0, a.liabilities.0 + a.kept.0, "accounting identity broke");
    let mut owed: u128 = v.fund_y;
    let mut locked: u128 = 0;
    let mut mining = 0u64;
    for c in v.claims.iter() {
        owed += t2y(c.collateral) + c.fee_pool_y + c.stake_y;
        locked += c.locked;
        assert_eq!(c.collateral, c.r_yes + c.user_yes);
        assert_eq!(c.collateral, c.r_no + c.user_no);
        if c.mine == MineState::Mining {
            mining += 1;
            assert!(c.locked + c.released <= cap_of(c.stake_y), "a mine holds more than its cap");
        } else {
            assert_eq!(c.stake_y, 0, "a closed mine still holds a bond");
            assert_eq!((c.locked, c.released), (0, 0), "a closed mine still holds tokens");
        }
    }
    for e in v.evidence.iter() {
        if e.bond_state == BondState::Open {
            owed += e.bond.0;
        }
    }
    assert_eq!(owed, a.liabilities.0, "running liabilities counter drifted from the real sum");
    assert_eq!(locked, v.locked_total, "locked counter drifted");
    assert_eq!(mining, v.n_mining, "mining counter drifted");
    let bal: u128 = holders.iter().map(|h| v.balance(&acct(h))).sum();
    assert_eq!(bal, v.liquid_supply, "balances do not add up to the liquid supply");
    assert_eq!(v.minted_total - v.burned_total, v.liquid_supply + v.locked_total, "mint/burn ledger does not match the supply");
}

const HOLDERS: [&str; 5] = ["alice.near", "bob.near", "carol.near", "dave.near", "erin.near"];

// ── the average and the ramp ────────────────────────────────────────────────────────────────────────

#[test]
fn average_moves_toward_the_price_and_never_overshoots() {
    let h = HALF * 1_000;
    let one = EMA_SCALE as u64;
    for (start, p) in [(5_000u16, 9_400u16), (9_400, 500), (5_000, 5_000), (1, 9_999), (9_999, 1)] {
        let e0 = u64::from(start) * one;
        let mut prev = e0;
        for dt in [0u64, 1, 999, 20_000, 30_000, 60_000, 99_999, 100_000, 5_000_000, 90 * 86_400_000] {
            let e = ema_step(e0, p, dt, h);
            let (lo, hi) = (e0.min(u64::from(p) * one), e0.max(u64::from(p) * one));
            assert!(e >= lo && e <= hi, "left [old, price]: {start}->{p} dt {dt} gave {e}");
            if p > start {
                assert!(e >= prev);
            } else if p < start {
                assert!(e <= prev);
            }
            prev = e;
        }
        assert_eq!(ema_step(e0, p, 0, h), e0, "no time, no movement");
        assert_eq!(ema_step(e0, p, 90 * 86_400_000, h), u64::from(p) * one, "after a very long time it is the price");
    }
}

#[test]
fn one_half_life_closes_half_the_gap() {
    let h = HALF * 1_000;
    let one = EMA_SCALE as i128;
    for (start, p) in [(5_000i128, 9_400i128), (9_000, 600), (3_000, 3_001)] {
        let e = ema_step((start * one) as u64, p as u16, h, h) as i128;
        let half = (start + p) * one / 2;
        assert!((e - half).abs() <= 2, "{start}->{p}: {e} vs {half}");
        let quarter = ema_step((start * one) as u64, p as u16, 2 * h, h) as i128;
        assert!((quarter - (start * one + 3 * p * one) / 4).abs() <= 4);
    }
    assert!(decay_fp(0, h) == FP as u128 && decay_fp(h, h).abs_diff(FP as u128 / 2) < 1_000);
}

#[test]
fn reading_the_average_often_or_rarely_gives_the_same_answer() {
    // The reason it is an exponential average: a spammer who calls `sync` every second must not slow it down, and a miner
    // who never does must not speed it up. Many small steps equal one big one to within rounding.
    let h = HALF * 1_000;
    let one = EMA_SCALE as u64;
    for (start, p, total) in [(5_000u16, 9_400u16, 100_000u64), (9_400, 500, 45_000), (5_000, 7_000, 250_000), (8_000, 8_100, 3_000)] {
        let e0 = u64::from(start) * one;
        let once = ema_step(e0, p, total, h);
        for pieces in [2u64, 7, 50, 1_000] {
            let mut e = e0;
            let mut left = total;
            for i in 0..pieces {
                let dt = if i + 1 == pieces { left } else { total / pieces };
                e = ema_step(e, p, dt, h);
                left -= dt;
            }
            assert!(e.abs_diff(once) <= pieces * 2 + 4, "{start}->{p} in {pieces} pieces: {e} vs {once}");
        }
    }
}

#[test]
fn ramp_and_cap() {
    assert_eq!(ramp_bps(0), 0);
    assert_eq!(ramp_bps(7_000), 0);
    assert_eq!(ramp_bps(7_001), 5);
    assert_eq!(ramp_bps(8_000), 5_000);
    assert_eq!(ramp_bps(9_000), 10_000);
    assert_eq!(ramp_bps(9_999), 10_000);
    assert_eq!(cap_of(N), 1_000 * T, "1 NEAR of bond is 1,000 $TRUE of cap");
    assert_eq!(cap_of(100 * N), 100_000 * T);
}

// ── mining ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_new_mine_mints_nothing_even_at_a_pumped_price() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    let c = v.get_claim(id).unwrap();
    assert!(c.price_bps >= 9_399 && c.mine.state == MineState::Mining);
    assert_eq!(c.mine.ema_bps, 5_000, "the average opens at 50% whatever the prior");
    assert_eq!(c.mine.target.0, 0);
    ctx("anyone.near", 0, 10);
    assert_eq!(v.sync(id).0, 0);
    audit(&v, &HOLDERS);
}

#[test]
fn belief_that_lasts_mints_in_proportion_to_the_average() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    // One half-life at 94%: the average is halfway from 50% to 94%, which is 72%, a tenth of the way up the ramp.
    ctx("anyone.near", 0, 10 + HALF);
    let held = v.sync(id).0;
    let c = v.get_claim(id).unwrap();
    assert!((7_190..7_210).contains(&c.mine.ema_bps), "ema {}", c.mine.ema_bps);
    assert_eq!(held, c.mine.locked.0);
    assert!(held > 190 * T && held < 210 * T, "a tenth of a 2,000 $TRUE cap, got {}", held / T);
    assert_eq!(v.get_supply().liquid.0, 0, "locked tokens are not spendable");
    assert_eq!(v.get_supply().locked.0, held);
    // Two more half-lives: the gap of 22 has become 5.5, so the average is 88.5%, which is 92.5% of the way up the ramp.
    ctx("anyone.near", 0, 10 + 3 * HALF);
    let held = v.sync(id).0;
    assert!(held > 1_840 * T && held < 1_860 * T, "92.5% of the cap, got {}", held / T);
    // Long enough: the average is at the price, which is over 90%, so the whole cap is minted.
    ctx("anyone.near", 0, 10 + 3 * HALF + WINDOW);
    assert_eq!(v.sync(id).0, 2_000 * T, "belief that has lasted reaches the cap");
    audit(&v, &HOLDERS);
}

#[test]
fn a_flash_pump_that_is_not_defended_mints_almost_nothing() {
    let mut v = fresh();
    let id = mined(&mut v, 5, 5_000, 10);
    push(&mut v, id, "bob.near", Side::Yes, 9_500, 10);
    // Two seconds later someone pushes it back down.
    push(&mut v, id, "carol.near", Side::No, 5_000, 12);
    ctx("anyone.near", 0, 12);
    assert_eq!(v.sync(id).0, 0, "two seconds at 95% moves a 100 s average by under 1%");
    ctx("anyone.near", 0, 500);
    assert_eq!(v.sync(id).0, 0, "and nothing mints afterwards, the price being back at 50%");
    audit(&v, &HOLDERS);
}

#[test]
fn a_claim_without_a_stake_never_mints() {
    let mut v = fresh();
    let id = plain(&mut v, 9_400, 10);
    ctx("anyone.near", 0, 1_000);
    assert_eq!(v.sync(id).0, 0);
    assert_eq!(v.get_claim(id).unwrap().mine.state, MineState::None);
    assert_eq!(v.get_supply().total.0, 0);
    audit(&v, &HOLDERS);
}

#[test]
fn losing_belief_burns_what_is_locked_without_slashing() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    ctx("anyone.near", 0, 70);
    assert!(v.sync(id).0 > 0);
    // The price falls to 50%: doubt, not refutation.
    push(&mut v, id, "bob.near", Side::No, 5_000, 70);
    ctx("anyone.near", 0, 70 + WINDOW + 1);
    assert_eq!(v.sync(id).0, 0, "the average is back at 50%, so nothing stays locked");
    let c = v.get_claim(id).unwrap();
    assert_eq!(c.mine.state, MineState::Mining, "doubt does not debunk");
    assert_eq!(c.mine.stake.0, 2 * N, "and does not slash");
    assert_eq!(v.fund_y, 0);
    assert!(v.burned_total > 0 && v.burned_total == v.minted_total);
    audit(&v, &HOLDERS);
}

#[test]
fn a_debunked_lie_burns_its_tokens_and_loses_its_bond_to_the_fund() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    ctx("anyone.near", 0, 70);
    assert!(v.sync(id).0 > 0);
    push(&mut v, id, "bob.near", Side::No, 600, 70);
    ctx("keeper.near", 0, 70 + WINDOW);
    assert_eq!(v.sync(id).0, 0);
    let c = v.get_claim(id).unwrap();
    assert_eq!(c.mine.state, MineState::Debunked);
    assert_eq!(c.mine.stake.0, 0);
    assert_eq!(v.fund_y, 2 * N, "the bond is in the Truth Fund");
    let s = v.get_supply();
    assert_eq!((s.locked.0, s.liquid.0, s.debunked, s.mining), (0, 0, 1, 0));
    assert_eq!(s.minted_total.0, s.burned_total.0);
    audit(&v, &HOLDERS);
}

#[test]
fn a_debunked_mine_stays_dead_when_the_price_recovers() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    push(&mut v, id, "bob.near", Side::No, 600, 15);
    ctx("anyone.near", 0, 15 + WINDOW);
    v.sync(id);
    assert_eq!(v.get_claim(id).unwrap().mine.state, MineState::Debunked);
    push(&mut v, id, "carol.near", Side::Yes, 9_400, 200);
    ctx("anyone.near", 0, 200 + 3 * WINDOW);
    assert_eq!(v.sync(id).0, 0, "a recovered claim does not mint again; open a new mine");
    assert_eq!(v.get_claim(id).unwrap().mine.state, MineState::Debunked);
    audit(&v, &HOLDERS);
}

#[test]
fn a_sell_updates_the_average_before_it_moves_the_price() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    // alice holds the opening YES shares; selling them at t=70 must credit the 60 s at 94% first.
    let shares = v.get_position(id, acct("alice.near")).yes;
    ctx("alice.near", 0, 70);
    v.sell(id, Side::Yes, U128(shares.0 / 2), U128(0));
    assert!(v.get_claim(id).unwrap().mine.locked.0 > 600 * T);
    audit(&v, &HOLDERS);
}

// ── season and release ──────────────────────────────────────────────────────────────────────────────

/// Opens a 2 NEAR mine at 94%, syncs once the average is at the price (so the season clock starts) and returns (id, t0).
fn season_started(v: &mut TrueMine) -> (u64, u64) {
    let id = mined(v, 2, 9_400, 10);
    let t0 = 10 + WINDOW;
    ctx("keeper.near", 0, t0);
    v.sync(id);
    assert_eq!(v.get_claim(id).unwrap().mine.locked.0, 2_000 * T);
    (id, t0)
}

#[test]
#[should_panic(expected = "full season")]
fn release_waits_for_the_whole_season() {
    let mut v = fresh();
    let (id, t0) = season_started(&mut v);
    ctx("alice.near", 0, t0 + SEASON - 1);
    v.release(id);
}

#[test]
#[should_panic(expected = "average is not at 90% yet")]
fn release_needs_the_average_at_ninety() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 8_000, 10);
    ctx("alice.near", 0, 10 + WINDOW);
    v.release(id);
}

#[test]
#[should_panic(expected = "only the claim's miner")]
fn only_the_miner_can_release() {
    let mut v = fresh();
    let (id, t0) = season_started(&mut v);
    ctx("bob.near", 0, t0 + SEASON);
    v.release(id);
}

#[test]
fn a_season_at_ninety_releases_the_tokens_and_they_can_be_spent() {
    let mut v = fresh();
    let (id, t0) = season_started(&mut v);
    ctx("alice.near", 0, t0 + SEASON);
    assert_eq!(v.release(id).0, 2_000 * T);
    assert_eq!(v.ft_balance_of(acct("alice.near")).0, 2_000 * T);
    assert_eq!(v.ft_total_supply().0, 2_000 * T);
    let s = v.get_supply();
    assert_eq!((s.liquid.0, s.locked.0), (2_000 * T, 0));
    register(&mut v, "bob.near", t0 + SEASON);
    ctx("alice.near", 1, t0 + SEASON);
    v.ft_transfer(acct("bob.near"), U128(500 * T), None);
    assert_eq!(v.ft_balance_of(acct("bob.near")).0, 500 * T);
    assert_eq!(v.ft_total_supply().0, 2_000 * T, "a transfer moves tokens, it does not mint");
    audit(&v, &HOLDERS);
}

#[test]
fn a_dip_below_ninety_restarts_the_season() {
    let mut v = fresh();
    let (id, t0) = season_started(&mut v);
    // A dip that is deep enough for the average to leave 90% but not 70%: hold 80% for a window.
    push(&mut v, id, "bob.near", Side::No, 8_000, t0 + 100);
    ctx("keeper.near", 0, t0 + 100 + WINDOW);
    v.sync(id);
    assert!(v.get_claim(id).unwrap().mine.release_in_ms.is_none(), "the season clock stopped");
    push(&mut v, id, "carol.near", Side::Yes, 9_400, t0 + 300);
    ctx("keeper.near", 0, t0 + 300 + WINDOW);
    v.sync(id);
    let c = v.get_claim(id).unwrap();
    assert!(c.mine.release_in_ms.unwrap() > SEASON * 1_000 - 5_000, "the season starts again from when 90% returned");
    audit(&v, &HOLDERS);
}

// ── debunk after release, retire, redeem ───────────────────────────────────────────────────────────

fn released(v: &mut TrueMine) -> (u64, u64) {
    let (id, t0) = season_started(v);
    let t1 = t0 + SEASON;
    ctx("alice.near", 0, t1);
    v.release(id);
    (id, t1)
}

#[test]
fn debunking_after_release_takes_the_tokens_back_from_the_miner() {
    let mut v = fresh();
    let (id, t1) = released(&mut v);
    push(&mut v, id, "bob.near", Side::No, 600, t1 + 5);
    ctx("keeper.near", 0, t1 + 5 + WINDOW);
    v.sync(id);
    assert_eq!(v.ft_balance_of(acct("alice.near")).0, 0, "the miner still held them, so they are burned");
    let s = v.get_supply();
    assert_eq!((s.liquid.0, s.locked.0, s.orphaned.0), (0, 0, 0));
    assert_eq!(s.fund.0, 2 * N);
    audit(&v, &HOLDERS);
}

#[test]
fn tokens_the_miner_already_moved_on_are_counted_as_orphaned() {
    let mut v = fresh();
    let (id, t1) = released(&mut v);
    register(&mut v, "bob.near", t1);
    ctx("alice.near", 1, t1);
    v.ft_transfer(acct("bob.near"), U128(1_500 * T), None);
    push(&mut v, id, "carol.near", Side::No, 600, t1 + 5);
    ctx("keeper.near", 0, t1 + 5 + WINDOW);
    v.sync(id);
    assert_eq!(v.ft_balance_of(acct("alice.near")).0, 0);
    assert_eq!(v.ft_balance_of(acct("bob.near")).0, 1_500 * T, "what left the miner's account cannot be clawed back");
    let s = v.get_supply();
    assert_eq!(s.orphaned.0, 1_500 * T, "the shortfall is on the record");
    assert_eq!(s.liquid.0, 1_500 * T);
    audit(&v, &HOLDERS);
}

#[test]
fn retiring_burns_everything_and_returns_the_bond() {
    let mut v = fresh();
    let (id, t1) = released(&mut v);
    let out_before = v.get_accounting().total_out.0;
    ctx("alice.near", 0, t1 + 1);
    assert_eq!(v.retire(id).0, 2 * N);
    assert_eq!(v.get_accounting().total_out.0 - out_before, 2 * N);
    assert_eq!(v.get_supply().total.0, 0);
    assert_eq!(v.get_claim(id).unwrap().mine.state, MineState::Retired);
    assert_eq!(v.get_supply().retired, 1);
    audit(&v, &HOLDERS);
}

#[test]
#[should_panic(expected = "no longer hold every token")]
fn retiring_needs_every_released_token_back() {
    let mut v = fresh();
    let (id, t1) = released(&mut v);
    register(&mut v, "bob.near", t1);
    ctx("alice.near", 1, t1);
    v.ft_transfer(acct("bob.near"), U128(T), None);
    ctx("alice.near", 0, t1 + 1);
    v.retire(id);
}

#[test]
#[should_panic(expected = "a refuted claim waits to be debunked")]
fn a_refuted_mine_cannot_retire_before_it_is_debunked() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    ctx("anyone.near", 0, 10 + 2 * HALF);
    assert!(v.sync(id).0 > 0, "it has minted");
    // Verifiers refute it: the price crashes, but the average (the contract's own clock) is still far above 30%.
    push(&mut v, id, "bob.near", Side::No, 1_000, 10 + 2 * HALF + 1);
    ctx("alice.near", 0, 10 + 2 * HALF + 2);
    assert!(v.get_claim(id).unwrap().mine.ema_bps > 3_000, "the average has not caught up, which is the window a liar would use");
    v.retire(id);
}

#[test]
#[should_panic(expected = "a refuted claim waits to be debunked")]
fn lifting_the_price_back_up_does_not_let_a_refuted_mine_retire() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    ctx("anyone.near", 0, 10 + 2 * HALF);
    v.sync(id);
    push(&mut v, id, "bob.near", Side::No, 1_000, 10 + 2 * HALF + 1);
    // The liar buys YES to lift the price over 50% (a touch, which stamps the low price that held before it) and retires at once.
    push(&mut v, id, "alice.near", Side::Yes, 6_500, 10 + 2 * HALF + 2);
    assert!(price(&v, id) >= 5_000, "the price is back over 50%");
    ctx("alice.near", 0, 10 + 2 * HALF + 3);
    v.retire(id);
}

#[test]
fn a_mine_can_retire_again_once_the_market_has_believed_it_for_a_whole_cooldown() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    push(&mut v, id, "bob.near", Side::No, 3_000, 11);
    push(&mut v, id, "alice.near", Side::Yes, 9_000, 12);
    let t = 12 + SEASON.max(3 * HALF) + 1;
    ctx("alice.near", 0, t);
    assert_eq!(v.retire(id).0, 2 * N);
    audit(&v, &HOLDERS);
}

#[test]
fn a_believed_mine_can_retire_while_it_is_under_attack_but_still_at_half() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    push(&mut v, id, "bob.near", Side::No, 5_500, 11);
    ctx("alice.near", 0, 12);
    assert_eq!(v.retire(id).0, 2 * N);
    audit(&v, &HOLDERS);
}

#[test]
fn redeeming_pays_a_pro_rata_share_of_the_fund() {
    let mut v = fresh();
    // Claim 0 is mined honestly and released to alice. Claim 1 is a lie that gets debunked: its 3 NEAR bond goes to the fund.
    let (_, t1) = released(&mut v);
    ctx("dave.near", CLAIM_FEE_Y + 5 * N + 3 * N, t1);
    let lie = v.create_claim("pluto".into(), "Pluto has twelve known moons.".into(), 9_400, Some(U128(3 * N)));
    push(&mut v, lie, "bob.near", Side::No, 600, t1 + 1);
    ctx("keeper.near", 0, t1 + 1 + WINDOW);
    v.sync(lie);
    assert_eq!(v.fund_y, 3 * N);
    assert_eq!(v.get_supply().total.0, 2_000 * T);
    // 2,000 $TRUE is under the 10,000 base, so the base is what the fund is divided by.
    assert_eq!(v.get_supply().floor_per_true.0, 3 * N / 10_000, "3 NEAR over the 10,000 $TRUE base");

    let out_before = v.get_accounting().total_out.0;
    ctx("alice.near", 0, t1 + 500);
    let paid = v.redeem(U128(1_000 * T)).0;
    assert!(paid <= 3 * N / 10 && paid > 3 * N / 10 - TICK * 2, "paid {paid}");
    assert_eq!(v.get_accounting().total_out.0 - out_before, paid);
    assert_eq!(v.ft_balance_of(acct("alice.near")).0, 1_000 * T);
    assert_eq!(v.fund_y, 3 * N - paid);
    audit(&v, &HOLDERS);
}

#[test]
fn locked_tokens_count_against_a_redeemer_once_the_supply_is_past_the_base() {
    let mut v = fresh();
    // Alice's 20 NEAR mine is released (20,000 $TRUE spendable). Erin's identical mine has 20,000 locked. A lie fills the fund with 3 NEAR.
    let id = mined(&mut v, 20, 9_400, 10);
    let t0 = 10 + WINDOW;
    ctx("keeper.near", 0, t0);
    v.sync(id);
    let t1 = t0 + SEASON;
    ctx("alice.near", 0, t1);
    assert_eq!(v.release(id).0, 20_000 * T);
    ctx("erin.near", CLAIM_FEE_Y + 5 * N + 20 * N, t1);
    let m2 = v.create_claim("everest".into(), "Mount Everest is in Asia.".into(), 9_400, Some(U128(20 * N)));
    ctx("dave.near", CLAIM_FEE_Y + 5 * N + 3 * N, t1);
    let lie = v.create_claim("pluto".into(), "Pluto has twelve known moons.".into(), 9_400, Some(U128(3 * N)));
    push(&mut v, lie, "bob.near", Side::No, 600, t1 + 1);
    ctx("keeper.near", 0, t1 + 1 + WINDOW);
    v.sync(lie);
    v.sync(m2);
    assert_eq!(v.fund_y, 3 * N);
    assert_eq!(v.get_supply().total.0, 40_000 * T, "20,000 spendable and 20,000 locked");
    ctx("alice.near", 0, t1 + 500);
    let paid = v.redeem(U128(10_000 * T)).0;
    // 10,000 of 40,000 is a quarter. Leaving the locked tokens out of the denominator would have paid half.
    assert!(paid <= 3 * N / 4 && paid > 3 * N / 4 - TICK * 2, "paid {paid}");
    audit(&v, &HOLDERS);
}

#[test]
fn a_small_supply_cannot_sweep_the_fund() {
    let mut v = fresh();
    let (_, t1) = released(&mut v);
    ctx("dave.near", CLAIM_FEE_Y + 5 * N + 3 * N, t1);
    let lie = v.create_claim("pluto".into(), "Pluto has twelve known moons.".into(), 9_400, Some(U128(3 * N)));
    push(&mut v, lie, "bob.near", Side::No, 600, t1 + 1);
    ctx("keeper.near", 0, t1 + 1 + WINDOW);
    v.sync(lie);
    assert_eq!(v.get_supply().total.0, 2_000 * T, "alice holds the whole supply");
    ctx("alice.near", 0, t1 + 500);
    let paid = v.redeem(U128(2_000 * T)).0;
    assert!(paid <= 3 * N / 5, "the whole supply of 2,000 redeems a fifth of the fund at most, not all of it: paid {paid}");
    assert!(v.fund_y >= 3 * N * 4 / 5 - TICK * 2, "the rest of the fund is still there");
    audit(&v, &HOLDERS);
}

#[test]
#[should_panic(expected = "nothing to pay")]
fn the_fund_is_empty_until_a_lie_is_debunked() {
    let mut v = fresh();
    let (_, t1) = released(&mut v);
    ctx("alice.near", 0, t1 + 1);
    v.redeem(U128(T));
}

// ── the token ───────────────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "has not registered")]
fn tokens_cannot_be_sent_to_an_unregistered_account() {
    let mut v = fresh();
    let (_, t1) = released(&mut v);
    ctx("alice.near", 1, t1);
    v.ft_transfer(acct("nobody.near"), U128(T), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_transfer_needs_one_yocto() {
    let mut v = fresh();
    let (_, t1) = released(&mut v);
    register(&mut v, "bob.near", t1);
    ctx("alice.near", 0, t1);
    v.ft_transfer(acct("bob.near"), U128(T), None);
}

#[test]
#[should_panic(expected = "insufficient")]
fn locked_tokens_cannot_be_transferred() {
    let mut v = fresh();
    let id = mined(&mut v, 2, 9_400, 10);
    ctx("anyone.near", 0, 10 + WINDOW);
    v.sync(id);
    register(&mut v, "bob.near", 120);
    ctx("alice.near", 1, 120);
    v.ft_transfer(acct("bob.near"), U128(T), None);
}

#[test]
fn registering_keeps_the_storage_fee_and_refunds_the_rest() {
    let mut v = fresh();
    ctx("bob.near", STORAGE_MIN_Y + 7 * N, 5);
    let b = v.storage_deposit(Some(acct("carol.near")), None);
    assert_eq!(b.total.0, STORAGE_MIN_Y);
    assert!(v.storage_balance_of(acct("carol.near")).is_some() && v.storage_balance_of(acct("bob.near")).is_none());
    assert_eq!(v.kept, STORAGE_MIN_Y);
    assert_eq!(v.get_accounting().total_out.0, 7 * N, "the excess goes back to whoever paid");
    ctx("bob.near", 3 * N, 6);
    v.storage_deposit(Some(acct("carol.near")), None);
    assert_eq!(v.get_accounting().total_out.0, 10 * N, "registering twice refunds the second deposit whole");
    audit(&v, &HOLDERS);
}

#[test]
fn metadata_says_what_the_token_is() {
    let v = fresh();
    let m = v.ft_metadata();
    assert_eq!((m.symbol.as_str(), m.decimals, m.spec.as_str()), ("TRUE", 18, "ft-1.0.0"));
}

// ── guards ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "stake must be between 1 and 100 NEAR")]
fn a_stake_under_one_near_is_refused() {
    let mut v = fresh();
    ctx("alice.near", CLAIM_FEE_Y + 5 * N, 5);
    v.create_claim("pluto".into(), "Pluto is a dwarf planet.".into(), 5_000, Some(U128(N / 2)));
}

#[test]
#[should_panic(expected = "stake must be between 1 and 100 NEAR")]
fn a_stake_over_one_hundred_near_is_refused() {
    let mut v = fresh();
    ctx("alice.near", CLAIM_FEE_Y + 5 * N + 101 * N, 5);
    v.create_claim("pluto".into(), "Pluto is a dwarf planet.".into(), 5_000, Some(U128(101 * N)));
}

#[test]
#[should_panic(expected = "seed must be at least 0.5 NEAR")]
fn the_stake_does_not_count_as_seed() {
    let mut v = fresh();
    ctx("alice.near", CLAIM_FEE_Y + 2 * N, 5);
    v.create_claim("pluto".into(), "Pluto is a dwarf planet.".into(), 5_000, Some(U128(2 * N)));
}

#[test]
fn evidence_bonds_still_work_and_are_refunded_when_capital_follows() {
    let mut v = fresh();
    let id = plain(&mut v, 5_000, 3);
    ctx("res.near", EVIDENCE_FEE_Y + MIN_BOND_Y, 4);
    let ev = v.post_evidence(id, Stance::Refute, "https://en.wikipedia.org/wiki/Pluto".into(), HASH.into(), "\"five moons\"".into());
    ctx("bob.near", 3 * N, 5);
    v.buy(id, Side::No, U128(0), Some(ev));
    ctx("anyone.near", 0, 4 + 61);
    assert_eq!(v.settle_bond(ev), BondState::Refunded);
    audit(&v, &HOLDERS);
}

#[test]
fn evidence_bond_is_forfeited_when_nobody_follows() {
    let mut v = fresh();
    let id = plain(&mut v, 5_000, 3);
    ctx("res.near", EVIDENCE_FEE_Y + MIN_BOND_Y, 4);
    let ev = v.post_evidence(id, Stance::Support, "https://en.wikipedia.org/wiki/Pluto".into(), HASH.into(), "x".into());
    ctx("anyone.near", 0, 4 + 61);
    assert_eq!(v.settle_bond(ev), BondState::Forfeited);
    audit(&v, &HOLDERS);
}

#[test]
fn round_trip_never_profits() {
    for side in [Side::Yes, Side::No] {
        let mut v = fresh();
        let id = plain(&mut v, 3_000, 2);
        ctx("bob.near", 2 * N, 3);
        let shares = v.buy(id, side, U128(0), None);
        ctx("bob.near", 0, 4);
        let back = v.sell(id, side, shares, U128(0)).0;
        assert!(back < 2 * N - POSITION_FEE_Y && back > 2 * N * 97 / 100, "round trip returned {back}");
        audit(&v, &HOLDERS);
    }
}

#[test]
fn quotes_match_execution() {
    let mut v = fresh();
    let id = plain(&mut v, 6_000, 2);
    ctx("bob.near", N, 3);
    let q = v.quote_buy(id, Side::No, U128(N - POSITION_FEE_Y), None);
    let got = v.buy(id, Side::No, U128(0), None);
    assert_eq!(q.out.0, got.0);
    assert_eq!(q.price_after_bps, price(&v, id));
}

#[test]
fn product_never_decreases() {
    let mut ry = 10_000_000_000u128;
    let mut rn = 10_000_000_000u128;
    let mut seed: u64 = 12345;
    for _ in 0..3_000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let side = if seed >> 63 == 0 { Side::Yes } else { Side::No };
        let k = ry * rn;
        let amt = 1 + u128::from((seed >> 20) % 2_000_000_000);
        let b = buy_calc(ry, rn, side, amt, 100).unwrap();
        assert!(b.r_yes * b.r_no >= k);
        ry = b.r_yes;
        rn = b.r_no;
        let held = b.shares / 2;
        if held > 0 {
            let k2 = ry * rn;
            let s = sell_calc(ry, rn, side, held, 100).unwrap();
            assert!(s.r_yes * s.r_no >= k2);
            ry = s.r_yes;
            rn = s.r_no;
        }
    }
}

// ── everything at once ──────────────────────────────────────────────────────────────────────────────

/// Three accounts open mines and a plain claim; five accounts buy, sell, sync, release, retire, transfer and redeem at random
/// while time moves. After every step the NEAR identity and the token identity must hold.
#[test]
fn a_long_random_walk_keeps_both_ledgers_balanced() {
    let mut v = fresh();
    let mut now: u64 = 10;
    let mut ids = Vec::new();
    for (i, who) in ["alice.near", "bob.near", "carol.near"].iter().enumerate() {
        ctx(who, CLAIM_FEE_Y + 6 * N + (2 + i as u128) * N, now);
        ids.push(v.create_claim("t".into(), format!("Claim number {i} is believed."), 9_000 - 800 * i as u16, Some(U128((2 + i as u128) * N))));
    }
    ctx("dave.near", CLAIM_FEE_Y + 6 * N, now);
    ids.push(v.create_claim("t".into(), "A plain claim with no bond.".into(), 5_000, None));
    for h in HOLDERS {
        register(&mut v, h, now);
    }
    let mut rng: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    let (mut released, mut retired, mut debunked, mut redeemed, mut moved) = (0, 0, 0, 0, 0);
    for step in 0..2_500u64 {
        let r = next();
        now += 1 + r % 45;
        let who = HOLDERS[(r >> 3) as usize % HOLDERS.len()];
        let id = ids[(r >> 9) as usize % ids.len()];
        // Claim 0's miner defends it, so it can reach a season and be released; claim 2 is attacked until it is debunked.
        if r % 2 == 0 && price(&v, ids[0]) < 9_300 && v.get_claim(ids[0]).unwrap().mine.state == MineState::Mining {
            ctx("alice.near", 2 * N, now);
            let _ = v.buy(ids[0], Side::Yes, U128(0), None);
        }
        if step > 1_200 && (r >> 5) % 4 == 0 && price(&v, ids[2]) > 1_500 && v.get_claim(ids[2]).unwrap().mine.state == MineState::Mining {
            ctx("bob.near", N, now);
            let _ = v.buy(ids[2], Side::No, U128(0), None);
        }
        match (r >> 16) % 12 {
            0..=3 => {
                let side = if (r >> 20) & 1 == 0 { Side::Yes } else { Side::No };
                ctx(who, N / 20 + u128::from((r >> 24) % 400) * N / 1_000, now);
                let _ = v.buy(id, side, U128(0), None);
            }
            4 | 5 => {
                let pos = v.get_position(id, acct(who));
                let side = if (r >> 20) & 1 == 0 { Side::Yes } else { Side::No };
                let held = if side == Side::Yes { pos.yes.0 } else { pos.no.0 };
                if held >= TICK * 10 {
                    ctx(who, 0, now);
                    v.sell(id, side, U128(held / (1 + u128::from((r >> 24) % 3))), U128(0));
                }
            }
            6 | 7 => {
                ctx(who, 0, now);
                v.sync(id);
            }
            8 => {
                let c = v.get_claim(id).unwrap();
                if c.mine.state == MineState::Mining && c.mine.release_in_ms == Some(0) && c.mine.locked.0 > 0 && c.creator == acct(who) {
                    ctx(who, 0, now);
                    if v.claims.get(id as u32).unwrap().full_since_ms.is_some() {
                        v.release(id);
                        released += 1;
                    }
                }
            }
            9 => {
                let c = v.claims.get(id as u32).unwrap().clone();
                let cooled = c.last_low_ms.map_or(true, |t| now * 1_000 >= t + v.retire_cooldown_ms());
                if step > 600 && c.mine == MineState::Mining && price(&v, id) >= 5_000 && cooled && c.creator == acct(who) && v.balance(&acct(who)) >= c.released && (r >> 40) % 3 == 0 {
                    ctx(who, 0, now);
                    v.retire(id);
                    retired += 1;
                }
            }
            10 => {
                let to = HOLDERS[(r >> 30) as usize % HOLDERS.len()];
                let bal = v.balance(&acct(who));
                if to != who && bal > 0 {
                    ctx(who, 1, now);
                    v.ft_transfer(acct(to), U128(bal / (1 + u128::from((r >> 36) % 4))), None);
                    moved += 1;
                }
            }
            _ => {
                let bal = v.balance(&acct(who));
                if bal >= TICK * 4 && v.fund_y > 0 && (r >> 44) % 2 == 0 {
                    ctx(who, 0, now);
                    v.redeem(U128(bal / 2));
                    redeemed += 1;
                }
            }
        }
        debunked = debunked.max(v.n_debunked);
        if step % 5 == 0 || step > 2_480 {
            audit(&v, &HOLDERS);
        }
    }
    audit(&v, &HOLDERS);
    // Epilogue: one more mine goes the whole way (bond, mint, season, release, retire) on top of whatever state the walk left.
    now += 1;
    ctx("erin.near", CLAIM_FEE_Y + 5 * N + 2 * N, now);
    let last = v.create_claim("t".into(), "A last claim, believed throughout.".into(), 9_400, Some(U128(2 * N)));
    now += WINDOW;
    ctx("erin.near", 0, now);
    v.sync(last);
    now += SEASON;
    ctx("erin.near", 0, now);
    assert_eq!(v.release(last).0, 2_000 * T);
    audit(&v, &HOLDERS);
    ctx("erin.near", 0, now + 1);
    assert_eq!(v.retire(last).0, 2 * N);
    retired += 1;
    audit(&v, &HOLDERS);
    eprintln!("random walk: {released} releases, {retired} retirements, {debunked} debunks, {redeemed} redemptions, {moved} transfers, minted {} $TRUE, burned {}", v.minted_total / T, v.burned_total / T);
    assert!(v.minted_total > 0 && released > 0 && retired > 0 && debunked > 0 && moved > 0 && redeemed > 0, "the walk left a path unexercised");
}
