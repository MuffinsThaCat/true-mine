import test from "node:test";
import assert from "node:assert/strict";
import { Analyst } from "../src/agents/analyst.js";
import { MemoryActivity } from "../src/lib/activity.js";
import type { Chain } from "../src/lib/chain.js";
import type { Judge } from "../src/lib/judge.js";
import type { Source, SourceProvider } from "../src/lib/sources.js";
import type { ClaimView } from "../src/lib/types.js";

const claim = (id: number, text: string, locked: string, state = "Mining"): ClaimView => ({
  id, topic: "t", text, creator: "m.test", created_ms: 0, price_bps: 9_400, evidence: [],
  mine: { state, locked, released: "0", target: locked, stake: "0", cap: "0", ema_bps: 9_400, debunk_due: false, release_in_ms: null },
}) as unknown as ClaimView;

const doc: Source = { title: "Doc", url: "https://example.org/doc", text: "text", contentHash: "b".repeat(64), provider: "stub" };

/** Records which claim texts the judge is asked about, in order. It never takes a side, so nothing is traded. */
function harness(claims: ClaimView[]) {
  const judged: string[] = [];
  const judge: Judge = { name: "stub", judge: async (text) => { judged.push(text); return { stance: "irrelevant", probability: 0.5, relevance: 0, quote: "", rationale: "" }; } };
  const sources: SourceProvider = { name: "stub", find: async () => [doc] };
  const chain = { accountId: "skeptic.test", allClaims: async () => claims, balance: async () => 100n * 10n ** 24n, evidenceFor: async () => [] } as unknown as Chain;
  const make = (persona: "skeptic" | "researcher") =>
    new Analyst({ name: "A", persona, chain, judge, sources, activity: new MemoryActivity(), maxClaimsPerCycle: 1, sourcesPerClaim: 1, recheckAfterMs: -1 });
  return { judged, make };
}

test("a skeptic looks at a claim it has never seen before it rechecks one it has", async () => {
  // The old mine holds the most tokens, so it ranks first on the first pass. On the second, with every claim due a recheck, the new
  // claim must still come first: ranking by tokens alone would send the skeptic back to the old mine.
  const old = claim(0, "An old, heavily minted claim.", (2_000n * 10n ** 18n).toString());
  const fresh = claim(1, "A claim that has just appeared.", "0");
  const { judged, make } = harness([old, fresh]);
  const a = make("skeptic");
  await a.cycle();
  await a.cycle();
  assert.deepEqual(judged, ["An old, heavily minted claim.", "A claim that has just appeared."]);
});

test("a skeptic with several unseen claims takes the one holding the most tokens first", async () => {
  const small = claim(0, "Small mine.", (100n * 10n ** 18n).toString());
  const big = claim(1, "Big mine.", (1_000n * 10n ** 18n).toString());
  const { judged, make } = harness([small, big]);
  await make("skeptic").cycle();
  assert.deepEqual(judged, ["Big mine."]);
});

test("a researcher also takes a claim it has not seen before one it has", async () => {
  const first = claim(0, "First claim.", "0");
  const second = claim(1, "Second claim.", "0");
  const { judged, make } = harness([first, second]);
  const a = make("researcher");
  await a.cycle();
  await a.cycle();
  assert.deepEqual(judged, ["First claim.", "Second claim."]);
});

test("a closed mine is left alone", async () => {
  const dead = claim(0, "A debunked claim.", "0", "Debunked");
  const live = claim(1, "A live claim.", "0");
  const { judged, make } = harness([dead, live]);
  await make("skeptic").cycle();
  assert.deepEqual(judged, ["A live claim."]);
});
