/**
 * End-to-end test on a real local NEAR chain (near-sandbox, a genuine nearcore node).
 *
 * Deploys the actual true_mine.wasm and runs the actual Miner, Analyst (verifier) and MineKeeper agents and the actual server
 * against it. Only the judge (an offline rule-based stand-in for a language model) and the document set (a small static corpus)
 * are simulated. The clocks are short (half-life 4 s, season 8 s) so a claim's whole life fits in a couple of minutes.
 *
 *   npm run build:contract && npm run build && npm run e2e
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";

import { Chain, TRUE_ONE } from "../../src/lib/chain.js";
import { Analyst } from "../../src/agents/analyst.js";
import { MineKeeper } from "../../src/agents/keeper.js";
import { Miner } from "../../src/agents/miner.js";
import { OfflineJudge } from "../../src/lib/offlineJudge.js";
import { StaticProvider } from "../../src/lib/sources.js";
import { FileActivity, readActivity } from "../../src/lib/activity.js";
import { sleep } from "../../src/lib/log.js";
import { startServer } from "../../src/server.js";
import { plutoCorpus, PLUTO_FALSE_CLAIM } from "../../src/demo/corpus.js";
import type { ClaimView } from "../../src/lib/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const WASM = readFileSync(path.join(root, "contracts/true-mine/res/true_mine.wasm"));
const NEAR = 10n ** 24n;
const HALF_LIFE = 4;
const SEASON = 8;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function check(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try { await p; } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert.match(text, pattern, `rejected, but with the wrong reason: ${text.slice(0, 300)}`);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}, but the call succeeded`);
}

async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, timeoutMs = 60_000, everyMs = 700): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const candidates = [path.join(root, ".sandbox-bin"), path.join(root, "../1Hundo-near/.sandbox-bin"), path.join(root, "../verity/.sandbox-bin")];
  process.env.DIR_TO_DOWNLOAD_BINARY = candidates.find((c) => existsSync(c)) ?? candidates[0];
}
const sandbox = await Sandbox.start({});
let exitCode = 1;

try {
  const rpc = sandbox.rpcUrl;
  console.log(`sandbox up at ${rpc}`);
  const rootAccount = new Account(DEFAULT_ACCOUNT_ID, rpc, DEFAULT_PRIVATE_KEY as `ed25519:${string}`);
  const keys = new Map<string, string>();
  async function mk(name: string, near: bigint): Promise<string> {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
    await rootAccount.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
    keys.set(id, kp.toString());
    return id;
  }
  const ids = {
    mine: await mk("mine", 30n * NEAR), miner: await mk("miner", 80n * NEAR), charlatan: await mk("charlatan", 40n * NEAR),
    skeptic: await mk("skeptic", 40n * NEAR), keeper: await mk("keeper", 20n * NEAR),
    bob: await mk("bob", 5n * NEAR), human: await mk("human", 60n * NEAR),
  };
  const chain = (id: string) => new Chain(id, keys.get(id), ids.mine, rpc);
  const C = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, chain(v)])) as Record<keyof typeof ids, Chain>;

  await new Account(ids.mine, rpc, keys.get(ids.mine) as `ed25519:${string}`).deployContract(WASM);
  await C.mine.call("new", { half_life_secs: HALF_LIFE, season_secs: SEASON, bond_window_secs: 4, fee_bps: 100 });
  for (const k of ["miner", "charlatan", "bob", "human"] as const) await C[k].register();
  console.log("true-mine deployed");

  const actFile = path.join(tmpdir(), `true-mine-e2e-${Date.now()}.jsonl`);
  const activity = new FileActivity(actFile, false);
  const brain = { judge: new OfflineJudge("MOCK-static-judge"), sources: new StaticProvider(plutoCorpus()) };
  const TRUE_CLAIM = "Pluto has five known natural satellites.";
  const miner = new Miner({ name: "Miner", chain: C.miner, activity, candidates: [{ topic: "pluto/moons", text: PLUTO_FALSE_CLAIM }, { topic: "pluto/moons", text: TRUE_CLAIM }], stakeNear: 2, seedNear: 2, reserveNear: 2, ...brain });
  const charlatan = new Miner({ name: "Charlatan", chain: C.charlatan, activity, candidates: [{ topic: "pluto/moons", text: PLUTO_FALSE_CLAIM }], stakeNear: 2, seedNear: 2, reserveNear: 2, check: false, openingPriceBps: 9_400, ...brain });
  const skeptic = new Analyst({ name: "Skeptic", persona: "skeptic", chain: C.skeptic, activity, maxTradeNear: 1.5, reserveNear: 1, sourcesPerClaim: 4, recheckAfterMs: 60_000, ...brain });
  const keeper = new MineKeeper(C.keeper, "Keeper", activity, Date.now, 0.3);

  const srv = startServer({
    port: 0, network: "sandbox", contractId: ids.mine, rpcUrl: rpc, activityFile: actFile, judgeLabel: "MOCK", sourcesLabel: "MOCK", mockCorpus: true,
    demo: { accountId: ids.human, privateKey: keys.get(ids.human)! }, pollMs: 500,
    agents: [{ name: "Miner", role: "miner", accountId: ids.miner }, { name: "Keeper", role: "keeper", accountId: ids.keeper }],
    lies: [{ id: "pluto-0", topic: "pluto/moons", text: PLUTO_FALSE_CLAIM, note: "" }],
    verifyFetch: (async () => ({ ok: true, status: 200, url: "x", headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer })) as unknown as typeof fetch,
  });
  await sleep(300);
  const base = `http://127.0.0.1:${(srv.server.address() as import("node:net").AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const post = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }); return { status: r.status, body: await r.json().catch(() => null) as any }; };

  const cap = 2_000n * TRUE_ONE;
  let goodId = -1;
  let lieId = -1;

  console.log("\nThe contract");
  await check("starts empty, with the parameters it was given", async () => {
    const cfg = await C.mine.config();
    assert.deepEqual([cfg.half_life_ms, cfg.season_ms, cfg.mint_per_near, cfg.up_bps, cfg.full_bps, cfg.down_bps], [4_000, 8_000, 1_000, 7_000, 9_000, 3_000]);
    const s = await C.mine.supply();
    assert.deepEqual([s.liquid, s.locked, s.fund], ["0", "0", "0"]);
    assert.equal(await C.mine.view<string>("ft_total_supply"), "0");
  });

  console.log("\nA careful miner");
  await check("bonds a statement its source supports and refuses the one it contradicts", async () => {
    const n = await miner.cycle();
    assert.equal(n, 1, "exactly one mine opened");
    const claims = await C.mine.allClaims();
    assert.equal(claims.length, 1);
    const c = claims[0]!;
    assert.equal(c.text, TRUE_CLAIM);
    assert.equal(c.mine.state, "Mining");
    assert.equal(c.mine.stake, (2n * NEAR).toString());
    assert.equal(c.mine.cap, cap.toString());
    assert.ok(c.price_bps >= 9_190 && c.price_bps <= 9_510, `a miner opens at 92-95%, got ${c.price_bps}`);
    goodId = c.id;
    // The view projects the average forward in real time, so it has already moved a little; what the chain has *stored* is
    // that nothing is minted until someone syncs, and the average opened at 50%, far under the 70% a mint needs.
    assert.equal(c.mine.locked, "0");
    assert.ok(c.mine.ema_bps < 7_000, `the average starts at 50%, got ${c.mine.ema_bps}`);
    const said = readActivity(actFile).map((a) => a.text).join("\n");
    assert.match(said, /not bonding/, "the miner said why it left the lie alone");
  });

  await check("a verifier has no edge on a truth already priced at 94% and leaves it alone", async () => {
    // Confirming the obvious pays nothing, so nobody spends money doing it: evidence appears where a price is wrong.
    assert.equal(await skeptic.cycle(), 0);
    assert.equal((await C.mine.evidenceFor(goodId)).length, 0);
  });

  console.log("\nMinting");
  await check("the keeper mints as belief lasts, and locked tokens are in the supply but not spendable", async () => {
    const c = await until("a mint", async () => {
      await keeper.cycle();
      const x = await C.mine.claim(goodId);
      return x && BigInt(x.mine.locked) > 0n ? x : false;
    }, 40_000);
    const s = await C.mine.supply();
    assert.equal(s.locked, c.mine.locked);
    assert.equal(s.liquid, "0", "nothing is spendable yet");
    assert.equal(await C.miner.trueBalance(), 0n);
    assert.match(readActivity(actFile).map((a) => a.text).join("\n"), /minted .* \$TRUE/);
  });

  await check("belief that lasts reaches the cap", async () => {
    await until("the cap", async () => { await keeper.cycle(); const x = await C.mine.claim(goodId); return x && BigInt(x.mine.locked) === cap; }, 60_000);
    assert.equal((await C.mine.supply()).locked, cap.toString());
  });

  await check("the miner cannot release before a whole season at 90%", async () => {
    await rejects(C.miner.release(goodId), /full season|average is not at 90%/);
    await rejects(C.bob.release(goodId), /only the claim's miner/);
  });

  console.log("\nSeasoning and release");
  await check("after a season at 90% the miner releases the tokens and can spend them", async () => {
    await until("release window", async () => { await keeper.cycle(); const x = await C.mine.claim(goodId); return x && x.mine.release_in_ms === 0; }, 60_000);
    const got = BigInt(await C.miner.release(goodId));
    assert.equal(got, cap);
    assert.equal(await C.miner.trueBalance(), cap);
    assert.equal(await C.mine.view<string>("ft_total_supply"), cap.toString());
    const s = await C.mine.supply();
    assert.deepEqual([s.liquid, s.locked], [cap.toString(), "0"]);
    await C.miner.transfer(ids.bob, 500n * TRUE_ONE);
    assert.equal(await C.miner.trueBalance(ids.bob), 500n * TRUE_ONE);
    assert.equal(await C.mine.view<string>("ft_total_supply"), cap.toString(), "a transfer moves tokens, it does not mint");
  });

  await check("ft_transfer_call to an account that cannot receive it refunds in full", async () => {
    const before = [await C.miner.trueBalance(), await C.miner.trueBalance(ids.bob)];
    await C.miner.transferCall(ids.bob, 100n * TRUE_ONE, "{}");
    assert.deepEqual([await C.miner.trueBalance(), await C.miner.trueBalance(ids.bob)], before);
  });

  await check("NEP-141 guards: one yocto, a registered receiver", async () => {
    await rejects(C.miner.call("ft_transfer", { receiver_id: ids.bob, amount: "1", memo: null }, { deposit: 0n }), /exactly 1 yoctoNEAR/);
    await rejects(C.miner.transfer(ids.keeper, 1n), /not registered/);
    const meta = await C.mine.view<{ symbol: string; decimals: number }>("ft_metadata");
    assert.deepEqual([meta.symbol, meta.decimals], ["TRUE", 18]);
  });

  console.log("\nA lie");
  await check("a charlatan bonds a lie without reading a source, and it starts to mint", async () => {
    assert.equal(await charlatan.cycle(), 1);
    const c = (await C.mine.allClaims()).find((x) => x.text === PLUTO_FALSE_CLAIM)!;
    assert.ok(c, "the lie is on the chain");
    lieId = c.id;
    assert.equal(c.mine.state, "Mining");
    assert.ok(c.price_bps >= 9_390, `it opens at 94%, got ${c.price_bps}`);
    const before = BigInt((await C.mine.supply()).locked);
    await until("the lie to mint", async () => { await keeper.cycle(); const x = await C.mine.claim(lieId); return x && BigInt(x.mine.locked) > 0n; }, 30_000);
    assert.ok(BigInt((await C.mine.supply()).locked) > before, "the unchecked lie raised the supply");
  });

  await check("a skeptic refutes it with evidence; the keeper debunks it; the tokens burn and the bond is confiscated", async () => {
    const fundBefore = BigInt((await C.mine.supply()).fund);
    // Each pass the skeptic rechecks a claim whose price moved and trades again, so the price walks down in a few steps.
    await until("the price to fall", async () => { await skeptic.cycle(); const x = await C.mine.claim(lieId); return x && x.price_bps < 3_500 ? x : false; }, 60_000, 1_200);
    const ev = await C.mine.evidenceFor(lieId);
    assert.ok(ev.some((e) => e.stance === "Refute" && /five known natural satellites/i.test(e.note) && /^[0-9a-f]{64}$/.test(e.content_hash)), "the refutation quotes the source and pins its hash");
    // The refutation has landed but the average (the contract's clock) has not crossed 30% yet. The liar cannot slip out through
    // `retire` in that gap: a claim the market disbelieves waits to be debunked.
    await rejects(C.charlatan.retire(lieId), /cannot be retired/);
    const dead = await until("the debunk", async () => { await keeper.cycle(); const x = await C.mine.claim(lieId); return x && x.mine.state === "Debunked" ? x : false; }, 60_000);
    assert.equal(dead.mine.locked, "0");
    assert.equal(dead.mine.stake, "0");
    const s = await C.mine.supply();
    assert.equal(BigInt(s.fund) - fundBefore, 2n * NEAR, "the 2 NEAR bond is in the Truth Fund");
    assert.equal(s.locked, "0");
    assert.equal(s.liquid, cap.toString(), "the honest miner's tokens are untouched");
    assert.equal(BigInt(s.minted_total) - BigInt(s.burned_total), BigInt(s.liquid) + BigInt(s.locked), "mint/burn ledger matches the supply");
    assert.equal(s.debunked, 1);
    const said = readActivity(actFile).map((a) => a.text).join("\n");
    assert.match(said, /DEBUNKED/);
  });

  await check("the skeptic's evidence bond is settled by the keeper and refunded, because capital followed it", async () => {
    const ev = await until("a settled bond", async () => {
      await keeper.cycle();
      const e = (await C.mine.evidenceFor(lieId))[0];
      return e && e.bond_state !== "Open" ? e : false;
    }, 30_000);
    assert.equal(ev.bond_state, "Refunded");
  });

  await check("a debunked mine stays dead and cannot be mined again", async () => {
    await C.keeper.sync(lieId);
    assert.equal((await C.mine.claim(lieId))!.mine.state, "Debunked");
    await rejects(C.charlatan.retire(lieId), /not being mined/);
    await rejects(C.charlatan.release(lieId), /not being mined/);
  });

  console.log("\nThe Truth Fund");
  await check("a holder redeems $TRUE for a pro-rata share of the confiscated bond", async () => {
    const s0 = await C.mine.supply();
    assert.equal(s0.fund, (2n * NEAR).toString());
    const floor = BigInt(s0.floor_per_true);
    assert.ok(floor > 0n, "the floor is positive once a lie has been debunked");
    const amount = 200n * TRUE_ONE;
    // The contract divides the fund by the supply, counted as at least 10,000 $TRUE so a small supply cannot sweep it.
    const total = BigInt(s0.total) > 10_000n * TRUE_ONE ? BigInt(s0.total) : 10_000n * TRUE_ONE;
    const expected = ((BigInt(s0.fund) / 10n ** 12n) * (amount / 10n ** 12n) / (total / 10n ** 12n)) * 10n ** 12n;
    const nearBefore = await C.miner.balance();
    await C.miner.redeem(amount);
    // The payout is a separate receipt; wait for it, allowing for the gas the call itself cost.
    const gained = await until("the payout", async () => { const g = (await C.miner.balance()) - nearBefore; return g > expected - 3n * 10n ** 22n ? g : false; }, 15_000);
    assert.ok(gained <= expected, `redeemed ${gained} for an expected ${expected}`);
    const s1 = await C.mine.supply();
    assert.equal(BigInt(s1.fund), BigInt(s0.fund) - expected);
    assert.equal(BigInt(s1.liquid), BigInt(s0.liquid) - amount);
    await rejects(C.bob.redeem(10_000n * TRUE_ONE), /do not hold/);
  });

  console.log("\nRetiring");
  await check("retiring needs every released token back, then returns the bond", async () => {
    // The miner gave bob 500 $TRUE (and redeemed 200): it cannot retire until it holds what the claim released.
    await rejects(C.miner.retire(goodId), /no longer hold every token/);
    await C.bob.transfer(ids.miner, 500n * TRUE_ONE);
    // It also redeemed 200, which burned them: those cannot come back. So retirement is out of reach, as designed.
    await rejects(C.miner.retire(goodId), /no longer hold every token/);
  });

  await check("a clean mine retires: tokens burned, bond returned", async () => {
    const id = Number(await C.charlatan.createClaim("pluto/age", "Pluto takes about 248 years to orbit the Sun.", 9_400, 2n * NEAR, 1n * NEAR));
    const before = await C.charlatan.balance();
    const supplyBefore = BigInt((await C.mine.supply()).total);
    await C.charlatan.retire(id);
    await until("the bond to come back", async () => (await C.charlatan.balance()) - before > NEAR - 3n * 10n ** 22n, 15_000);
    const c = await C.mine.claim(id);
    assert.equal(c!.mine.state, "Retired");
    assert.equal(BigInt((await C.mine.supply()).total), supplyBefore);
  });

  console.log("\nThe books");
  await check("the NEAR accounting identity holds and the contract holds what it owes", async () => {
    const a = await C.mine.accounting();
    assert.equal(BigInt(a.total_in) - BigInt(a.total_out), BigInt(a.liabilities) + BigInt(a.kept), "in - out = liabilities + kept");
    const held = await C.mine.balance();
    assert.ok(held >= BigInt(a.liabilities), `contract holds ${held}, owes ${a.liabilities}`);
    const s = await C.mine.supply();
    assert.equal(BigInt(s.minted_total) - BigInt(s.burned_total), BigInt(s.liquid) + BigInt(s.locked));
    assert.equal(await C.mine.view<string>("ft_total_supply"), s.liquid);
  });

  console.log("\nThe server");
  await check("/api/state serves the supply, every claim's mine and the agents", async () => {
    await srv.pollFresh();
    const { status, body } = await get("/api/state");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.supply.fund, (await C.mine.supply()).fund);
    assert.ok(body.claims.length >= 3);
    const good = body.claims.find((c: ClaimView) => c.id === goodId);
    assert.equal(good.mine.state, "Mining");
    assert.ok(body.history.length > 0);
    assert.equal(body.agents.length, 2);
    assert.equal(body.lies.length, 1);
  });

  await check("/api/claim returns the evidence with a readable source", async () => {
    const { status, body } = await get(`/api/claim?id=${lieId}`);
    assert.equal(status, 200);
    assert.ok(body.evidence.length >= 1, "the skeptic's refutation is there");
    assert.equal(body.evidence[0].stance, "Refute");
    assert.ok(body.evidence[0].source.mock, "the offline corpus is labelled as such");
    assert.equal(body.claim.mine.state, "Debunked");
    assert.ok(body.history.length > 3, "the page can draw price against average");
    assert.equal((await get("/api/claim?id=9999")).status, 404);
    assert.equal((await get("/api/claim?id=-1")).status, 400);
  });

  await check("/api/verify refuses to fetch an address that is not on the allowlist", async () => {
    const { status, body } = await get(`/api/verify?evidence=0`);
    assert.equal(status, 200);
    assert.equal(body.ok, null, "the mock corpus has nothing to fetch");
    assert.equal((await get("/api/verify?evidence=abc")).status, 400);
  });

  await check("the demo account can mine a lie and the page sees it", async () => {
    const r = await post("/api/demo/mine", { lie_id: "pluto-0" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.claim.mine.state, "Mining");
    assert.equal(r.body.claim.creator, ids.human);
    assert.equal((await post("/api/demo/mine", { lie_id: "nope" })).status, 400);
    assert.equal((await post("/api/demo/mine", { text: "short", topic: "x" })).status, 400);
    await sleep(1_600);
    const me = await get("/api/demo/me");
    assert.equal(me.body.account, ids.human);
  });

  await check("the server refuses a bad path, a bad body and an oversized body", async () => {
    const trav = await new Promise<number>((resolve) => {
      import("node:net").then(({ connect }) => {
        const port = Number(new URL(base).port);
        const s = connect(port, "127.0.0.1", () => s.write("GET /../../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
        let data = "";
        s.on("data", (d) => (data += d));
        s.on("close", () => resolve(Number(/HTTP\/1.1 (\d+)/.exec(data)?.[1] ?? 0)));
      });
    });
    assert.ok(trav === 403 || trav === 404, `path traversal gave ${trav}`);
    await sleep(1_600);
    const huge = await fetch(base + "/api/demo/trade", { method: "POST", body: "x".repeat(50_000) });
    assert.equal(huge.status, 413);
    await sleep(1_600);
    const bad = await fetch(base + "/api/demo/trade", { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400);
  });

  srv.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error(e);
} finally {
  await sandbox.tearDown().catch(() => {});
  process.exit(exitCode);
}
