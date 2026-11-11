export type Side = "Yes" | "No";
export type Stance = "Support" | "Refute";
export type BondState = "Open" | "Refunded" | "Forfeited";
export type MineState = "None" | "Mining" | "Retired" | "Debunked";

export interface TradeRec {
  ts_ms: number;
  who: string;
  side: Side;
  buy: boolean;
  amount: string;
  price_bps: number;
  evidence: number | null;
}

export interface MineView {
  state: MineState;
  /** NEAR (yocto) bonded to the mine. */
  stake: string;
  /** The moving average of the price as of now, in basis points. */
  ema_bps: number;
  /** $TRUE (18 decimals) minted to this claim and not yet spendable. */
  locked: string;
  /** $TRUE released to the miner and not yet burned or clawed back. */
  released: string;
  /** What the claim would hold at the average as of now. */
  target: string;
  /** The average is under 30% and the mine only waits for someone to call sync. */
  debunk_due: boolean;
  /** Milliseconds until the locked tokens can be released (0: now); null when the average is under 90%. */
  release_in_ms: number | null;
  cap: string;
}

export interface ClaimView {
  id: number;
  topic: string;
  text: string;
  creator: string;
  created_ms: number;
  price_bps: number;
  collateral: string;
  reserve_yes: string;
  reserve_no: string;
  volume: string;
  trades: number;
  fee_pool: string;
  evidence: number[];
  tape: TradeRec[];
  mine: MineView;
}

export interface Evidence {
  id: number;
  claim_id: number;
  author: string;
  stance: Stance;
  uri: string;
  content_hash: string;
  note: string;
  bond: string;
  backing: string;
  independent: string;
  posted_ms: number;
  price_at_post_bps: number;
  bond_state: BondState;
}

export interface Quote {
  out: string;
  fee: string;
  price_before_bps: number;
  price_after_bps: number;
}

export interface Accounting {
  total_in: string;
  total_out: string;
  liabilities: string;
  kept: string;
  stranded: string;
}

export interface Supply {
  liquid: string;
  locked: string;
  total: string;
  minted_total: string;
  burned_total: string;
  orphaned: string;
  fund: string;
  floor_per_true: string;
  mining: number;
  debunked: number;
  retired: number;
}

export interface MineConfig {
  fee_bps: number;
  half_life_ms: number;
  season_ms: number;
  bond_window_ms: number;
  claims: number;
  evidence: number;
  mint_per_near: number;
  up_bps: number;
  full_bps: number;
  down_bps: number;
}
