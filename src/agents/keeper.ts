import type { Chain } from "../lib/chain.js";
import { fmtTrue } from "../lib/chain.js";
import type { ActivitySink } from "../lib/activity.js";
import type { ClaimView } from "../lib/types.js";
import { BondKeeper } from "./bonds.js";

const near = (y: string | bigint) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(2);

/**
 * Keeps every mine up to date. The contract moves a claim's moving average only when something touches the claim, so a lie
 * that nobody trades is never debunked and a believed claim never mints unless somebody calls `sync`. Anyone can; this is the
 * one that always does. It syncs a mine when the average says there is something to do (mint, burn, debunk), and otherwise
 * about four times a window so the contract's clock for "believed at 90%" is observed in time.
 *
 * It also settles evidence bonds (see BondKeeper). It earns nothing for either, so it stops, out loud, when its balance runs low.
 */
export class MineKeeper {
  private readonly lastSync = new Map<number, number>();
  private readonly bonds: BondKeeper;
  private lowOnFunds = false;

  constructor(
    private readonly chain: Chain,
    private readonly name: string,
    private readonly activity: ActivitySink,
    private readonly now: () => number = Date.now,
    private readonly minBalanceNear = 0.5,
  ) {
    this.bonds = new BondKeeper(chain, name, activity, now);
  }

  /** What `sync` would change, judged from the view (which projects the average to now). */
  static needsSync(c: ClaimView, halfLifeMs: number, sinceLastMs: number): boolean {
    const m = c.mine;
    if (m.state !== "Mining") return false;
    const held = BigInt(m.locked) + BigInt(m.released);
    if (m.debunk_due) return true;
    if (BigInt(m.target) > held) return true;
    if (BigInt(m.target) < held && BigInt(m.locked) > 0n) return true;
    // The average is exact however often it is read, so this is only about when the contract notices things: that the average
    // has crossed 90% (which starts the season) and that a mine needs releasing.
    return sinceLastMs >= Math.max(2_000, halfLifeMs / 2);
  }

  /** Returns the number of claims synced this pass. */
  async cycle(): Promise<number> {
    const cfg = await this.chain.config();
    const claims = await this.chain.allClaims();
    const due = claims.filter((c) => MineKeeper.needsSync(c, cfg.half_life_ms, this.now() - (this.lastSync.get(c.id) ?? 0)));
    let synced = 0;
    if (due.length > 0) {
      if ((await this.chain.balance()) < BigInt(Math.round(this.minBalanceNear * 1e6)) * 10n ** 18n) {
        if (!this.lowOnFunds) this.activity.emit({ agent: this.name, kind: "skip", text: `${due.length} mine(s) need a sync, but this account is below ${this.minBalanceNear} NEAR; waiting for funds` });
        this.lowOnFunds = true;
      } else {
        this.lowOnFunds = false;
        for (const c of due) {
          try {
            await this.chain.sync(c.id);
            this.lastSync.set(c.id, this.now());
            synced++;
            const after = await this.chain.claim(c.id);
            if (after) this.report(c, after);
          } catch (e) {
            this.activity.emit({ agent: this.name, kind: "error", claimId: c.id, text: `claim #${c.id}: sync failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` });
          }
        }
      }
    }
    await this.bonds.cycle();
    return synced;
  }

  /** One line for what the sync did, read off the claim before and after. */
  private report(before: ClaimView, after: ClaimView) {
    const b = before.mine;
    const a = after.mine;
    const claimId = after.id;
    const text = `claim #${claimId}`;
    if (b.state === "Mining" && a.state === "Debunked") {
      const gone = BigInt(b.locked) + BigInt(b.released);
      // Locked tokens burn for certain. Released ones are taken back only as far as the miner still holds them (the rest is "orphaned"
      // on chain), so they are reported as at risk, not as burned.
      const burned = BigInt(b.locked) > 0n ? `${fmtTrue(b.locked)} $TRUE burned` : "no locked tokens left to burn";
      const clawed = BigInt(b.released) > 0n ? `, up to ${fmtTrue(b.released)} released $TRUE taken back from the miner` : "";
      this.activity.emit({
        agent: this.name, kind: "debunk", claimId,
        text: `${text} DEBUNKED: ${burned}${clawed}, ${near(b.stake)} NEAR bond to the Truth Fund`,
        data: { burned: b.locked, released: b.released, atRisk: gone.toString(), stake: b.stake, ema: a.ema_bps },
      });
      return;
    }
    const was = BigInt(b.locked) + BigInt(b.released);
    const is = BigInt(a.locked) + BigInt(a.released);
    if (is > was) {
      this.activity.emit({ agent: this.name, kind: "mint", claimId, text: `${text} minted ${fmtTrue(is - was)} $TRUE (believed at ${(a.ema_bps / 100).toFixed(0)}% on average)`, data: { amount: (is - was).toString(), ema: a.ema_bps } });
    } else if (is < was) {
      this.activity.emit({ agent: this.name, kind: "burn", claimId, text: `${text} burned ${fmtTrue(was - is)} $TRUE (belief fell to ${(a.ema_bps / 100).toFixed(0)}% on average)`, data: { amount: (was - is).toString(), ema: a.ema_bps } });
    }
  }
}
