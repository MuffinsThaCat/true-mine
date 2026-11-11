import { Account } from "near-api-js";
import type { Accounting, BondState, ClaimView, Evidence, MineConfig, Quote, Side, Stance, Supply } from "./types.js";
import { TGAS } from "./units.js";

export interface CallOpts {
  deposit?: bigint;
  gas?: bigint;
}

/** One $TRUE, in the token's base units (18 decimals). */
export const TRUE_ONE = 10n ** 18n;

/** Thin typed wrapper over the TRUE Mine contract. */
export class Chain {
  readonly account: Account;

  constructor(
    readonly accountId: string,
    secretKey: string | undefined,
    readonly contractId: string,
    readonly rpcUrl: string,
  ) {
    this.account = secretKey
      ? new Account(accountId, rpcUrl, secretKey as `ed25519:${string}`)
      : new Account(accountId, rpcUrl);
  }

  view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.account.provider.callFunction<any>({ contractId: this.contractId, method, args }) as Promise<T>;
  }

  call<T = unknown>(methodName: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<T> {
    return this.account.callFunction<any>({
      contractId: this.contractId,
      methodName,
      args,
      deposit: opts.deposit ?? 0n,
      gas: opts.gas ?? 80n * TGAS,
    }) as Promise<T>;
  }

  balance(): Promise<bigint> {
    return this.account.getBalance();
  }

  // views
  config() { return this.view<MineConfig>("get_config"); }
  supply() { return this.view<Supply>("get_supply"); }
  accounting() { return this.view<Accounting>("get_accounting"); }
  claim(id: number) { return this.view<ClaimView | null>("get_claim", { claim_id: id }); }
  claims(from = 0, limit = 50) { return this.view<ClaimView[]>("get_claims", { from_index: from, limit }); }
  evidenceFor(claimId: number) { return this.view<Evidence[]>("get_claim_evidence", { claim_id: claimId }); }
  evidencePage(from: number, limit = 100) { return this.view<Evidence[]>("get_evidence_page", { from_index: from, limit }); }
  evidence(id: number) { return this.view<Evidence | null>("get_evidence", { evidence_id: id }); }
  position(claimId: number, account: string) {
    return this.view<{ yes: string; no: string }>("get_position", { claim_id: claimId, account });
  }
  /** Pass `account` so the quote includes the 0.002 NEAR a first trade of the claim costs that account. */
  quoteBuy(claimId: number, side: Side, amount: bigint, account?: string) {
    return this.view<Quote>("quote_buy", { claim_id: claimId, side, amount: amount.toString(), account: account ?? null });
  }
  quoteSell(claimId: number, side: Side, shares: bigint) {
    return this.view<Quote>("quote_sell", { claim_id: claimId, side, shares: shares.toString() });
  }
  async trueBalance(account: string = this.accountId): Promise<bigint> {
    return BigInt(await this.view<string>("ft_balance_of", { account_id: account }));
  }

  /** Every claim, paged. */
  async allClaims(): Promise<ClaimView[]> {
    const out: ClaimView[] = [];
    for (let from = 0; ; from += 50) {
      const page = await this.claims(from, 50);
      out.push(...page);
      if (page.length < 50) return out;
    }
  }

  // writes
  /** Opens a claim. With `stake`, the NEAR is bonded to the claim as a mine; `seed` is the liquidity that opens the market. */
  createClaim(topic: string, text: string, priorBps: number, seed: bigint, stake: bigint = 0n) {
    return this.call<number>("create_claim", { topic, text, prior_bps: priorBps, stake: stake > 0n ? stake.toString() : null }, { deposit: CLAIM_FEE + seed + stake });
  }
  postEvidence(claimId: number, stance: Stance, uri: string, contentHash: string, note: string, deposit: bigint) {
    return this.call<number>("post_evidence", { claim_id: claimId, stance, uri, content_hash: contentHash, note }, { deposit });
  }
  buy(claimId: number, side: Side, deposit: bigint, minShares = 0n, evidenceId: number | null = null) {
    return this.call<string>("buy", { claim_id: claimId, side, min_shares: minShares.toString(), evidence_id: evidenceId }, { deposit });
  }
  sell(claimId: number, side: Side, shares: bigint, minProceeds = 0n) {
    return this.call<string>("sell", { claim_id: claimId, side, shares: shares.toString(), min_proceeds: minProceeds.toString() });
  }
  settleBond(evidenceId: number) { return this.call<BondState>("settle_bond", { evidence_id: evidenceId }); }
  withdrawFees(claimId: number) { return this.call<string>("withdraw_fees", { claim_id: claimId }); }
  sync(claimId: number) { return this.call<string>("sync", { claim_id: claimId }, { gas: 60n * TGAS }); }
  release(claimId: number) { return this.call<string>("release", { claim_id: claimId }, { gas: 60n * TGAS }); }
  retire(claimId: number) { return this.call<string>("retire", { claim_id: claimId }, { gas: 60n * TGAS }); }
  redeem(amount: bigint) { return this.call<string>("redeem", { amount: amount.toString() }, { gas: 60n * TGAS }); }
  register(account: string = this.accountId) {
    // 0.0025 NEAR: the contract keeps this much for a token account's registration entry and balance entry.
    return this.call("storage_deposit", { account_id: account, registration_only: true }, { deposit: 25n * 10n ** 20n });
  }
  transfer(to: string, amount: bigint) {
    return this.call("ft_transfer", { receiver_id: to, amount: amount.toString(), memo: null }, { deposit: 1n });
  }
  transferCall(to: string, amount: bigint, msg: string) {
    return this.call("ft_transfer_call", { receiver_id: to, amount: amount.toString(), memo: null, msg }, { deposit: 1n, gas: 120n * TGAS });
  }
}

/** Kept by the contract for every claim it opens: 0.07 NEAR. */
export const CLAIM_FEE = 70n * 10n ** 21n;

export const bps = (x: number) => x / 10_000;

/** $TRUE base units as a decimal string ("1,234.5"). */
export function fmtTrue(base: bigint | string, frac = 1): string {
  const v = typeof base === "bigint" ? base : BigInt(base);
  const whole = v / TRUE_ONE;
  const f = ((v % TRUE_ONE) * 10n ** BigInt(frac)) / TRUE_ONE;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac > 0 && f > 0n ? `${w}.${f.toString().padStart(frac, "0")}` : w;
}
