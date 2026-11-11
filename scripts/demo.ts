/**
 * One-command local demo: a real local NEAR node (near-sandbox), the real contract, a keeper, miners, verifiers and the web UI.
 *
 *   npm run build:contract && npm run build && npm run demo
 *
 * No API key needed: the default reads real pinned Wikipedia revisions (shipped in seed-cache/) with a rule-based judge. Set
 * ANTHROPIC_API_KEY (or LLM_BASE_URL + LLM_API_KEY) for a language-model judge, MINE_MOCK=1 for a tiny static corpus.
 *
 * The clocks are short so a whole life of a claim fits in a couple of minutes: the price average closes half its gap to the
 * price every MINE_HALF_LIFE_SECS (default 8), and a claim must stay at 90% for MINE_SEASON_SECS (default 30) before its tokens
 * can be released.
 */
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { Chain } from "../src/lib/chain.js";
import { Analyst } from "../src/agents/analyst.js";
import { MineKeeper } from "../src/agents/keeper.js";
import { Miner } from "../src/agents/miner.js";
import { FileActivity } from "../src/lib/activity.js";
import { sleep } from "../src/lib/log.js";
import { startServer, type AgentInfo } from "../src/server.js";
import { deal, factsOf, liesOf, loadSeedDir, validateSeeds } from "../src/demo/seeds.js";

if (process.argv.includes("--offline")) process.env.MINE_CACHE_ONLY = "1";
const { makeBrain } = await import("../src/lib/brain.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const NEAR = 10n ** 24n;
// Not 8787 or 8788: other projects on this machine serve there, and the server listens on localhost only.
const PORT = Number(process.env.PORT ?? 8791);
const HALF_LIFE_SECS = Number(process.env.MINE_HALF_LIFE_SECS ?? 8);
const SEASON_SECS = Number(process.env.MINE_SEASON_SECS ?? 30);

if (!process.env.DIR_TO_DOWNLOAD_BINARY) {
  const sibling = path.join(root, "../verity/.sandbox-bin");
  const sibling2 = path.join(root, "../1Hundo-near/.sandbox-bin");
  process.env.DIR_TO_DOWNLOAD_BINARY = existsSync(path.join(root, ".sandbox-bin")) ? path.join(root, ".sandbox-bin")
    : existsSync(sibling2) ? sibling2 : existsSync(sibling) ? sibling : path.join(root, ".sandbox-bin");
}
const dataDir = path.join(root, "data/demo");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const activityFile = path.join(dataDir, "activity.jsonl");

const brain = makeBrain();
console.log(`judge: ${brain.judgeLabel}\nsources: ${brain.sourcesLabel}`);

const seedFiles = loadSeedDir(path.join(root, "seed"));
validateSeeds(seedFiles);
const facts = factsOf(seedFiles);
const lies = liesOf(seedFiles);

const sandbox = await Sandbox.start({});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 4000).unref();
  await sandbox.tearDown().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const rpc = sandbox.rpcUrl;
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
  mine: await mk("mine", 40n * NEAR),
  minerA: await mk("miner-a", 220n * NEAR), minerB: await mk("miner-b", 220n * NEAR), charlatan: await mk("charlatan", 120n * NEAR),
  researchA: await mk("researcher-a", 200n * NEAR), skepticA: await mk("skeptic-a", 200n * NEAR),
  researchB: await mk("researcher-b", 200n * NEAR), skepticB: await mk("skeptic-b", 200n * NEAR),
  keeper: await mk("keeper", 60n * NEAR), you: await mk("you", 400n * NEAR),
};
const chain = (id: string) => new Chain(id, keys.get(id), ids.mine, rpc);

await new Account(ids.mine, rpc, keys.get(ids.mine) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/true-mine/res/true_mine.wasm")));
await chain(ids.mine).call("new", { half_life_secs: HALF_LIFE_SECS, season_secs: SEASON_SECS, bond_window_secs: 45, fee_bps: 100 });
// Every account that will hold released tokens registers once (NEP-145), the way a wallet would on first receipt.
for (const id of [ids.minerA, ids.minerB, ids.charlatan, ids.you]) await chain(id).register();

const activity = new FileActivity(activityFile);
const [factsA, factsB] = deal(facts, 2);
const shared = { judge: brain.judge, sources: brain.sources, activity };
const verifierOpts = { ...shared, maxTradeNear: 1.5, maxClaimsPerCycle: 4, sourcesPerClaim: 4, recheckAfterMs: 90_000, reserveNear: 5, minAgeMs: Number(process.env.MINE_AUDIT_DELAY_MS ?? 12_000) };
const minerOpts = { ...shared, stakeNear: 2, seedNear: 2, reserveNear: 5 };

const MINER_EVERY = Number(process.env.MINER_INTERVAL_MS ?? 12_000);
const AGENT_EVERY = Number(process.env.AGENT_INTERVAL_MS ?? 5_000);
const CHARLATAN_EVERY = Number(process.env.CHARLATAN_INTERVAL_MS ?? 70_000);
const roster: Array<{ info: AgentInfo; every: number; startAfter: number; run: { cycle(): Promise<number> } }> = [
  { info: { name: "Keeper", role: "keeper", accountId: ids.keeper, startNear: 60 }, every: 2_000, startAfter: 0, run: new MineKeeper(chain(ids.keeper), "Keeper", activity, Date.now, 0.5) },
  { info: { name: "Researcher A", role: "verifier", accountId: ids.researchA, startNear: 200 }, every: AGENT_EVERY, startAfter: 1_500, run: new Analyst({ name: "Researcher A", persona: "researcher", chain: chain(ids.researchA), ...verifierOpts }) },
  { info: { name: "Skeptic A", role: "verifier", accountId: ids.skepticA, startNear: 200 }, every: AGENT_EVERY, startAfter: 2_500, run: new Analyst({ name: "Skeptic A", persona: "skeptic", chain: chain(ids.skepticA), ...verifierOpts }) },
  { info: { name: "Researcher B", role: "verifier", accountId: ids.researchB, startNear: 200 }, every: AGENT_EVERY, startAfter: 3_500, run: new Analyst({ name: "Researcher B", persona: "researcher", chain: chain(ids.researchB), ...verifierOpts }) },
  { info: { name: "Skeptic B", role: "verifier", accountId: ids.skepticB, startNear: 200 }, every: AGENT_EVERY, startAfter: 4_500, run: new Analyst({ name: "Skeptic B", persona: "skeptic", chain: chain(ids.skepticB), ...verifierOpts }) },
  { info: { name: "Miner A", role: "miner", accountId: ids.minerA, startNear: 220 }, every: MINER_EVERY, startAfter: 2_000, run: new Miner({ name: "Miner A", chain: chain(ids.minerA), candidates: factsA, ...minerOpts }) },
  { info: { name: "Miner B", role: "miner", accountId: ids.minerB, startNear: 220 }, every: MINER_EVERY, startAfter: 8_000, run: new Miner({ name: "Miner B", chain: chain(ids.minerB), candidates: factsB, ...minerOpts }) },
  { info: { name: "Charlatan", role: "charlatan", accountId: ids.charlatan, startNear: 120 }, every: CHARLATAN_EVERY, startAfter: 45_000, run: new Miner({ name: "Charlatan", chain: chain(ids.charlatan), candidates: lies.map((l) => ({ topic: l.topic, text: l.text })), check: false, openingPriceBps: 9_400, ...minerOpts }) },
];

startServer({
  port: PORT, network: "local sandbox", contractId: ids.mine, rpcUrl: rpc, activityFile,
  judgeLabel: brain.judgeLabel, sourcesLabel: brain.sourcesLabel, mockCorpus: process.env.MINE_MOCK === "1",
  demo: { accountId: ids.you, privateKey: keys.get(ids.you)! }, pollMs: 2000, agents: roster.map((r) => r.info), lies,
});
console.log(`\nTRUE Mine demo is live:  http://localhost:${PORT}\n(half-life ${HALF_LIFE_SECS}s, season ${SEASON_SECS}s. Ctrl+C stops the chain.)\n`);

await Promise.all(roster.map(async ({ info, run, every, startAfter }) => {
  await sleep(startAfter);
  while (!stopping) {
    try { await run.cycle(); } catch (e) { activity.emit({ agent: info.name, kind: "error", text: e instanceof Error ? e.message.split("\n")[0]! : String(e) }); }
    await sleep(every);
  }
}));
