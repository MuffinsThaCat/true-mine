import test from "node:test";
import assert from "node:assert/strict";
import { Miner, MAX_OPEN_ATTEMPTS } from "../src/agents/miner.js";
import { MineKeeper } from "../src/agents/keeper.js";
import { MemoryActivity } from "../src/lib/activity.js";
import type { Chain } from "../src/lib/chain.js";
import type { Judge } from "../src/lib/judge.js";
import type { Source, SourceProvider } from "../src/lib/sources.js";
import type { ClaimView } from "../src/lib/types.js";

const STATEMENT = "Pluto has five known natural satellites.";

const source: Source = { title: "Pluto", url: "https://example.org/pluto", text: STATEMENT, contentHash: "a".repeat(64), provider: "stub" };
const sources: SourceProvider = { name: "stub", find: async () => [source] };
const supports: Judge = { name: "stub", judge: async () => ({ stance: "support", probability: 0.9, relevance: 1, quote: STATEMENT, rationale: "same" }) };

/** Just enough of a Chain for the miner: createClaim fails its first `failFirst` calls, as an RPC that drops would. */
class FakeChain {
  readonly accountId = "miner.test";
  readonly calls: Array<{ text: string; prior: number; stake: bigint }> = [];
  readonly claims: ClaimView[] = [];
  constructor(private readonly failFirst: number) {}
  async balance() { return 100n * 10n ** 24n; }
  async allClaims() { return this.claims; }
  async createClaim(_topic: string, text: string, prior: number, _seed: bigint, stake: bigint) {
    this.calls.push({ text, prior, stake });
    if (this.calls.length <= this.failFirst) throw new Error("rpc connection dropped");
    const id = this.claims.length;
    this.claims.push({ id, text, creator: this.accountId, mine: { state: "Mining", release_in_ms: null, locked: "0" } } as unknown as ClaimView);
    return id;
  }
}

const miner = (chain: FakeChain, activity = new MemoryActivity()) =>
  new Miner({ name: "Miner", chain: chain as unknown as Chain, judge: supports, sources, activity, candidates: [{ topic: "pluto/moons", text: STATEMENT }], stakeNear: 2, seedNear: 2 });

test("a miner opens the statement a source supports, at 92 to 95 percent", async () => {
  const chain = new FakeChain(0);
  assert.equal(await miner(chain).cycle(), 1);
  assert.equal(chain.calls.length, 1);
  assert.ok(chain.calls[0]!.prior >= 9_200 && chain.calls[0]!.prior <= 9_500, `prior ${chain.calls[0]!.prior}`);
  assert.equal(chain.calls[0]!.stake, 2n * 10n ** 24n);
});

test("a miner does not open the same statement twice", async () => {
  const chain = new FakeChain(0);
  const m = miner(chain);
  await m.cycle();
  assert.equal(await m.cycle(), 0);
  assert.equal(chain.calls.length, 1);
});

test("one dropped call does not cost a true statement for good", async () => {
  const chain = new FakeChain(1);
  const m = miner(chain);
  assert.equal(await m.cycle(), 0, "the first attempt failed");
  assert.equal(await m.cycle(), 1, "the next pass tries again and succeeds");
  assert.equal(chain.calls.length, 2);
});

test("a statement that keeps failing is given up on after a few attempts, not retried for ever", async () => {
  const chain = new FakeChain(1_000);
  const activity = new MemoryActivity();
  const m = miner(chain, activity);
  for (let i = 0; i < MAX_OPEN_ATTEMPTS + 4; i++) await m.cycle();
  assert.equal(chain.calls.length, MAX_OPEN_ATTEMPTS);
  assert.ok(activity.items.some((a) => a.kind === "error" && /could not open/.test(a.text)));
});

const claimWith = (m: Partial<ClaimView["mine"]>): ClaimView => ({ mine: { state: "Mining", locked: "0", released: "0", target: "0", debunk_due: false, ...m } } as unknown as ClaimView);

test("the keeper syncs a mine that has something to do, and leaves a settled one alone until it is time to look", () => {
  const half = 10_000;
  assert.equal(MineKeeper.needsSync(claimWith({ state: "Debunked" }), half, 1e9), false, "a closed mine needs nothing");
  assert.equal(MineKeeper.needsSync(claimWith({ debunk_due: true }), half, 0), true);
  assert.equal(MineKeeper.needsSync(claimWith({ target: "5" }), half, 0), true, "something to mint");
  assert.equal(MineKeeper.needsSync(claimWith({ locked: "5", target: "1" }), half, 0), true, "something to burn");
  assert.equal(MineKeeper.needsSync(claimWith({ released: "5", target: "1" }), half, 0), false, "released tokens are not burned by falling belief");
  assert.equal(MineKeeper.needsSync(claimWith({}), half, 1_000), false, "nothing to do and looked recently");
  assert.equal(MineKeeper.needsSync(claimWith({}), half, 5_000), true, "looked half a half-life ago");
  assert.equal(MineKeeper.needsSync(claimWith({}), 1_000, 1_999), false, "never more often than every two seconds");
  assert.equal(MineKeeper.needsSync(claimWith({}), 1_000, 2_000), true);
});
