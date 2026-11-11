import type { Chain } from "../lib/chain.js";
import { fmtTrue } from "../lib/chain.js";
import type { ActivitySink } from "../lib/activity.js";
import type { Judge } from "../lib/judge.js";
import type { SourceProvider } from "../lib/sources.js";
import type { ClaimView } from "../lib/types.js";
import { YOCTO_PER_NEAR } from "../lib/units.js";
import { chooseReading, gatherSources, type Reading } from "./analyst.js";

export interface Candidate {
  topic: string;
  text: string;
}

export interface MinerOpts {
  name: string;
  chain: Chain;
  judge: Judge;
  sources: SourceProvider;
  activity: ActivitySink;
  /** Statements this miner considers bonding NEAR to, in order. */
  candidates: Candidate[];
  /** NEAR bonded to each mine (1 to 100). It sets the cap: 1,000 $TRUE per NEAR. */
  stakeNear?: number;
  /** NEAR that seeds the claim's market (at least 0.5). */
  seedNear?: number;
  /** New mines opened per pass. */
  perCycle?: number;
  /** A statement is bonded only if a source supports it with at least this probability. */
  minProbability?: number;
  /** NEAR the miner never touches. */
  reserveNear?: number;
  /**
   * False makes a charlatan: it bonds whatever it is given without reading a source. The demo uses one to show what an
   * unchecked lie costs; nothing else about it differs, and the contract cannot tell the two apart.
   */
  check?: boolean;
  openingPriceBps?: number;
}

const toYocto = (n: number) => BigInt(Math.round(n * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
/** How many times a statement that failed to open is tried before it is given up on. */
export const MAX_OPEN_ATTEMPTS = 3;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * A miner finds statements that are true and bonds NEAR to them. Before it bonds it reads a source; a statement the source
 * does not support is left alone, because a mine that gets debunked loses its bond. It also releases whatever its mines have
 * earned once the contract allows it (a whole season believed at 90%).
 */
export class Miner {
  private readonly tried = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly o: Required<MinerOpts>;

  constructor(opts: MinerOpts) {
    this.o = { stakeNear: 2, seedNear: 2, perCycle: 1, minProbability: 0.8, reserveNear: 5, check: true, openingPriceBps: 9_000, ...opts };
  }

  get name() { return this.o.name; }

  private say(kind: Parameters<ActivitySink["emit"]>[0]["kind"], text: string, claimId?: number, data?: Record<string, unknown>) {
    this.o.activity.emit({ agent: this.o.name, kind, text, claimId, data });
  }

  /** Returns what it did this pass: mines opened plus releases. */
  async cycle(): Promise<number> {
    const claims = await this.o.chain.allClaims();
    return (await this.releaseEarned(claims)) + (await this.openMines(claims));
  }

  private async releaseEarned(claims: ClaimView[]): Promise<number> {
    let n = 0;
    for (const c of claims) {
      if (c.creator !== this.o.chain.accountId || c.mine.state !== "Mining") continue;
      if (c.mine.release_in_ms !== 0 || BigInt(c.mine.locked) === 0n) continue;
      try {
        await this.o.chain.sync(c.id);
        const got = await this.o.chain.release(c.id);
        n++;
        this.say("release", `claim #${c.id}: a full season believed at 90%, released ${fmtTrue(BigInt(got))} $TRUE to my account`, c.id, { amount: got });
      } catch (e) {
        this.say("skip", `claim #${c.id}: not released yet (${(e instanceof Error ? e.message : String(e)).split("\n")[0]})`, c.id);
      }
    }
    return n;
  }

  private async openMines(claims: ClaimView[]): Promise<number> {
    const onChain = new Set(claims.map((c) => norm(c.text)));
    let opened = 0;
    for (const cand of this.o.candidates) {
      if (opened >= this.o.perCycle) break;
      const key = norm(cand.text);
      if (onChain.has(key) || this.tried.has(key)) continue;
      const balance = await this.o.chain.balance();
      if (balance < toYocto(this.o.stakeNear + this.o.seedNear + this.o.reserveNear + 0.1)) {
        this.say("skip", "not enough NEAR to bond another mine");
        return opened;
      }
      let prior = this.o.openingPriceBps;
      if (this.o.check) {
        const reading = await this.read(cand);
        this.tried.add(key);
        if (!reading) continue;
        // A miner that bonds NEAR to a statement is betting it is true, so it opens at 92% to 95%, higher the better the source
        // supports it. (A mine whose average never reaches 90% is never released, so a miner that is only half sure should not
        // bond at all.)
        const sure = Math.min(1, Math.max(0, (reading.v.probability - this.o.minProbability) / (0.95 - this.o.minProbability)));
        prior = 9_200 + Math.round(sure * 300);
      } else {
        this.tried.add(key);
        this.say("info", `bonding "${cand.text}" without reading a source`);
      }
      try {
        const id = Number(await this.o.chain.createClaim(cand.topic, cand.text, prior, toYocto(this.o.seedNear), toYocto(this.o.stakeNear)));
        opened++;
        this.say("mine", `claim #${id}: bonded ${this.o.stakeNear} NEAR (cap ${(this.o.stakeNear * 1000).toLocaleString("en-US")} $TRUE) to "${cand.text}", opening at ${Math.round(prior / 100)}%`, id, { stake: this.o.stakeNear, prior });
      } catch (e) {
        this.say("error", `could not open "${cand.text}": ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
        // A transient failure (a dropped RPC call) must not cost a true statement for good; give it a few more passes.
        const failures = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, failures);
        if (failures < MAX_OPEN_ATTEMPTS) this.tried.delete(key);
      }
    }
    return opened;
  }

  /** The best supporting reading of a candidate, or null (and a line saying why not). */
  private async read(cand: Candidate): Promise<Reading | null> {
    const found = await gatherSources(this.o.sources, cand.text, 3);
    if (found.length === 0) {
      this.say("skip", `"${cand.text}": no sources found, not bonding`);
      return null;
    }
    const reads: Reading[] = [];
    for (const src of found) {
      this.say("source", `reading "${src.title}" for "${cand.text}"`, undefined, { url: src.url });
      const v = await this.o.judge.judge(cand.text, src);
      if (v && v.stance !== "irrelevant" && v.relevance >= 0.5) reads.push({ src, v });
    }
    const choice = chooseReading(reads);
    if (!choice || choice.pick.v.stance !== "support" || choice.belief < this.o.minProbability) {
      this.say("skip", `"${cand.text}": ${choice ? `a source ${choice.pick.v.stance === "refute" ? "contradicts it" : "only half supports it"}` : "no source speaks to it"}, not bonding`);
      return null;
    }
    this.say("judge", `"${cand.text}": supported (${Math.round(choice.belief * 100)}%) — "${choice.pick.v.quote.slice(0, 120)}"`, undefined, { source: choice.pick.src.title });
    return choice.pick;
  }
}
