import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActivityTail } from "./lib/activity.js";
import { Chain, TRUE_ONE } from "./lib/chain.js";
import { Limiter, verifyEvidenceContent } from "./lib/sources.js";
import type { Accounting, ClaimView, Evidence, MineConfig, Supply } from "./lib/types.js";
import { YOCTO_PER_NEAR } from "./lib/units.js";
import { describeSource } from "./lib/uri.js";
import { quotedText } from "./lib/wikitext.js";
import type { LieOption } from "./demo/seeds.js";

export interface AgentInfo {
  name: string;
  role: "verifier" | "miner" | "keeper" | "charlatan";
  accountId: string;
  startNear?: number;
}

export interface ServerOpts {
  port: number;
  /** Address to listen on. Default 127.0.0.1 (or the HOST variable); set 0.0.0.0 only for a server with no demo account. */
  host?: string;
  network: string;
  contractId: string;
  rpcUrl: string;
  activityFile: string;
  judgeLabel: string;
  sourcesLabel: string;
  mockCorpus?: boolean;
  /** A funded account the page may act as (a local demo only). */
  demo?: { accountId: string; privateKey: string };
  pollMs?: number;
  agents?: AgentInfo[];
  lies?: LieOption[];
  webDir?: string;
  verifyHosts?: string[];
  verifyFetch?: typeof fetch;
  trustProxy?: boolean;
}

export interface AgentRow extends AgentInfo {
  near: string;
  true: string;
  /** $TRUE this account's mines hold, locked and released. */
  locked: string;
  released: string;
  mines: number;
  reads: number;
  evidence: number;
  trades: number;
  syncs: number;
  debunks: number;
  releases: number;
  errors: number;
  lastAt: number | null;
  now: { kind: string; text: string; claimId: number | null; ts: number } | null;
  active: boolean;
}

export interface VerifyResult {
  id: number;
  uri: string;
  expected: string;
  actual: string | null;
  ok: boolean | null;
  quoteFound: boolean | null;
  note: string | null;
  checkedAt: number;
}

export interface SupplyPoint { t: number; locked: string; liquid: string; fund: string; mining: number; debunked: number }
export interface ClaimPoint { t: number; price: number; ema: number; held: string }

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
const toYocto = (near: number) => BigInt(Math.round(near * 1e6)) * (YOCTO_PER_NEAR / 1_000_000n);
const ACTIVE_MS = 9_000;
const HISTORY_SUPPLY = 900;
const HISTORY_CLAIM = 240;

/** The contract's panic text, without the RPC wrapper around it. */
export function cleanError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const m = /panic_msg: \\?"([^"\\]+)/.exec(text) ?? /Smart contract panicked: ([^\n]+)/.exec(text);
  return (m ? m[1]! : text.split("\n")[0]!).trim();
}

const httpError = (code: number, message: string) => Object.assign(new Error(message), { code });

/** Who is asking. Behind a proxy, the last X-Forwarded-For entry (the one the proxy itself appended) is used. */
export function clientAddress(req: Pick<http.IncomingMessage, "headers" | "socket">, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const last = (Array.isArray(fwd) ? fwd.join(",") : fwd ?? "").split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "?";
}

/** $TRUE written by a person ("1,500.5") to base units; null when it is not a plain positive number with at most 6 decimals. */
export function parseTrue(s: unknown): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(String(s ?? "").replace(/,/g, "").trim());
  if (!m) return null;
  const v = BigInt(m[1]!) * TRUE_ONE + (m[2] ? (BigInt(m[2].padEnd(6, "0")) * TRUE_ONE) / 1_000_000n : 0n);
  return v > 0n ? v : null;
}

export function startServer(o: ServerOpts) {
  const view = new Chain("view.invalid", undefined, o.contractId, o.rpcUrl);
  const demoChain = o.demo ? new Chain(o.demo.accountId, o.demo.privateKey, o.contractId, o.rpcUrl) : null;
  const webDir = o.webDir ?? path.resolve(here, "../../web");
  const tail = new ActivityTail(o.activityFile);
  const verifyHosts = o.verifyHosts ?? (process.env.MINE_VERIFY_HOSTS?.split(",").map((s) => s.trim()).filter(Boolean) ?? ["wikipedia.org"]);
  const verifyLimiter = new Limiter(120);

  const snap: {
    config: MineConfig | null; supply: Supply | null; accounting: Accounting | null; claims: ClaimView[];
    ok: boolean; error: string | null; at: number;
  } = { config: null, supply: null, accounting: null, claims: [], ok: false, error: null, at: 0 };
  const supplyHistory: SupplyPoint[] = [];
  const claimHistory = new Map<number, ClaimPoint[]>();
  let agentRows: AgentRow[] = [];
  let agentsAt = 0;
  let agentsBusy = false;

  // ───────────── polling ─────────────

  async function pollOnce() {
    try {
      const [supply, accounting, claims] = await Promise.all([view.supply(), view.accounting(), view.allClaims()]);
      if (!snap.config) snap.config = await view.config();
      snap.supply = supply; snap.accounting = accounting; snap.claims = claims; snap.ok = true; snap.error = null; snap.at = Date.now();
      const t = Date.now();
      const last = supplyHistory[supplyHistory.length - 1];
      if (!last || last.locked !== supply.locked || last.liquid !== supply.liquid || last.fund !== supply.fund || t - last.t > 4_000) {
        supplyHistory.push({ t, locked: supply.locked, liquid: supply.liquid, fund: supply.fund, mining: supply.mining, debunked: supply.debunked });
        if (supplyHistory.length > HISTORY_SUPPLY) supplyHistory.splice(0, supplyHistory.length - HISTORY_SUPPLY);
      }
      for (const c of claims) {
        let h = claimHistory.get(c.id);
        if (!h) claimHistory.set(c.id, (h = []));
        const held = (BigInt(c.mine.locked) + BigInt(c.mine.released)).toString();
        const prev = h[h.length - 1];
        if (!prev || t - prev.t >= 1_500 || prev.price !== c.price_bps) {
          h.push({ t, price: c.price_bps, ema: c.mine.ema_bps, held });
          if (h.length > HISTORY_CLAIM) h.splice(0, h.length - HISTORY_CLAIM);
        }
      }
      // In the background: it is about two RPC calls per agent, one after another, and on a slow RPC it would hold every state update back.
      if (Date.now() - agentsAt > 5_000 && !agentsBusy) {
        agentsBusy = true;
        void refreshAgents().catch(() => {}).finally(() => { agentsBusy = false; });
      }
    } catch (e) {
      snap.ok = false;
      snap.error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    }
  }
  let polling: Promise<void> | null = null;
  function poll(): Promise<void> {
    if (!polling) polling = pollOnce().finally(() => { polling = null; });
    return polling;
  }
  /** A poll that starts after now: one in flight may have read the chain before the caller's write. */
  async function pollFresh(): Promise<void> {
    if (polling) await polling;
    return poll();
  }

  async function refreshAgents() {
    tail.refresh();
    const rows: AgentRow[] = [];
    for (const a of o.agents ?? []) {
      try {
        const c = new Chain(a.accountId, undefined, o.contractId, o.rpcUrl);
        const [near, tr] = await Promise.all([c.balance(), c.trueBalance()]);
        const counts = tail.agents.get(a.name);
        const real = counts?.lastReal ?? null;
        let locked = 0n, released = 0n, mines = 0;
        for (const cl of snap.claims) if (cl.creator === a.accountId && cl.mine.state === "Mining") { locked += BigInt(cl.mine.locked); released += BigInt(cl.mine.released); mines++; }
        rows.push({
          ...a, near: near.toString(), true: tr.toString(), locked: locked.toString(), released: released.toString(), mines,
          reads: counts?.reads ?? 0, evidence: counts?.evidence ?? 0, trades: counts?.trades ?? 0, syncs: counts?.syncs ?? 0,
          debunks: counts?.debunks ?? 0, releases: counts?.releases ?? 0, errors: counts?.errors ?? 0,
          lastAt: counts?.last?.ts ?? null,
          now: real ? { kind: real.kind, text: real.text, claimId: real.claimId ?? null, ts: real.ts } : null,
          active: !!counts?.last && Date.now() - counts.last.ts < ACTIVE_MS,
        });
      } catch {
        const prev = agentRows.find((r) => r.name === a.name);
        if (prev) rows.push(prev);
      }
    }
    agentRows = rows;
    agentsAt = Date.now();
  }

  // ───────────── evidence verification ─────────────

  const verifyCache = new Map<number, VerifyResult>();
  const verifyRunning = new Map<number, Promise<VerifyResult>>();

  async function verifyEvidence(id: number): Promise<VerifyResult> {
    const cached = verifyCache.get(id);
    if (cached && Date.now() - cached.checkedAt < 5 * 60_000) return cached;
    const running = verifyRunning.get(id);
    if (running) return running;
    const p = (async (): Promise<VerifyResult> => {
      // The address comes from the chain, never from the request, and only an allowed host is ever fetched.
      const e = await view.evidence(id);
      if (!e) throw httpError(404, "no such evidence");
      const base = { id, uri: e.uri, expected: e.content_hash, checkedAt: Date.now() };
      if (describeSource(e.uri, { mockCorpus: o.mockCorpus }).mock) return { ...base, actual: null, ok: null, quoteFound: null, note: "This is the offline test corpus; there is nothing to fetch." };
      let host = "";
      try { host = new URL(e.uri).host; } catch { return { ...base, actual: null, ok: null, quoteFound: null, note: "the evidence address is not a valid URL" }; }
      const raw = /(^|\.)wikipedia\.org$/.test(host) && /[?&]action=raw\b/.test(e.uri);
      const quote = raw ? quotedText(e.note) : null;
      try {
        const r = await verifyEvidenceContent(e.uri, e.content_hash, quote, o.verifyFetch ?? fetch, { allowHosts: verifyHosts, limiter: verifyLimiter, retries: 2 });
        return { ...base, actual: r.actual, ok: r.ok, quoteFound: r.quoteFound, note: null };
      } catch (err) {
        return { ...base, actual: null, ok: null, quoteFound: null, note: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
      }
    })().then((r) => { if (r.ok !== null) verifyCache.set(id, r); return r; }).finally(() => verifyRunning.delete(id));
    verifyRunning.set(id, p);
    return p;
  }

  // ───────────── request plumbing ─────────────

  const hits = new Map<string, { n: number; at: number }>();
  function throttle(req: http.IncomingMessage, limit = 60, windowMs = 10_000) {
    const who = clientAddress(req, o.trustProxy === true);
    const now = Date.now();
    if (hits.size > 5_000) for (const [k, v] of hits) if (now - v.at > windowMs) hits.delete(k);
    const h = hits.get(who);
    if (!h || now - h.at > windowMs) { hits.set(who, { n: 1, at: now }); return; }
    if (++h.n > limit) throw httpError(429, "too many requests; try again in a few seconds");
  }

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: http.IncomingMessage, max = 20_000): Promise<any> {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > max) throw httpError(413, "body too large"); chunks.push(c as Buffer); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw httpError(400, "the request body is not valid JSON"); }
  }

  // One demo action at a time, and a pause after each: two visitors acting together would collide on the demo account's nonce.
  let demoBusy = false;
  let demoLast = 0;
  const budgetNear = Number(process.env.DEMO_HOURLY_BUDGET_NEAR ?? 150);
  const spent: Array<{ at: number; near: number }> = [];
  let meCache: { at: number; body: { account: string; near: string; true: string } } | null = null;
  async function demoAction<T>(costNear: number, fn: (c: Chain) => Promise<T>): Promise<T> {
    if (!demoChain) throw httpError(404, "demo controls are not enabled on this server");
    if (demoBusy) throw httpError(429, "another demo action is still running");
    if (Date.now() - demoLast < 1_500) throw httpError(429, "slow down: one demo action every moment");
    demoBusy = true;
    try {
      if ((await demoChain.balance()) < toYocto(costNear + 1)) throw httpError(503, "the demo account is out of funds; restart the demo");
      while (spent.length && Date.now() - spent[0]!.at > 3_600_000) spent.shift();
      if (spent.reduce((a, x) => a + x.near, 0) + costNear > budgetNear) throw httpError(429, "the demo's hourly spending limit is reached; try again later");
      spent.push({ at: Date.now(), near: costNear });
      return await fn(demoChain);
    } finally { demoBusy = false; demoLast = Date.now(); meCache = null; }
  }

  const state = () => ({
    now: Date.now(), network: o.network, contractId: o.contractId, rpcUrl: o.rpcUrl, ok: snap.ok, error: snap.error, at: snap.at,
    judge: o.judgeLabel, sources: o.sourcesLabel, mockCorpus: o.mockCorpus === true,
    demo: !!demoChain, demoAccount: o.demo?.accountId ?? null,
    config: snap.config, supply: snap.supply, accounting: snap.accounting,
    // The tape is the heaviest part of a claim and the page reads history from /api/history instead.
    claims: snap.claims.map((c) => ({ ...c, tape: c.tape.slice(-8) })),
    agents: agentRows, lies: o.lies ?? [],
    history: supplyHistory.slice(-300),
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("content-security-policy", "frame-ancestors 'self'");

      if (p === "/api/state") { throttle(req, 120); return json(res, 200, state()); }
      if (p === "/api/claim") {
        throttle(req);
        const id = Number(url.searchParams.get("id"));
        if (!Number.isInteger(id) || id < 0) throw httpError(400, "bad claim id");
        const claim = await view.claim(id);
        if (!claim) throw httpError(404, "no such claim");
        const evidence: Evidence[] = await view.evidenceFor(id);
        return json(res, 200, {
          claim, history: claimHistory.get(id) ?? [],
          evidence: evidence.map((e) => ({ ...e, source: describeSource(e.uri, { mockCorpus: o.mockCorpus }) })),
        });
      }
      if (p === "/api/activity") {
        const since = Number(url.searchParams.get("since") ?? 0);
        tail.refresh();
        return json(res, 200, tail.recent.filter((a) => a.ts > since).slice(-300));
      }
      if (p === "/api/verify") {
        throttle(req, 30);
        const id = Number(url.searchParams.get("evidence"));
        if (!Number.isInteger(id) || id < 0) throw httpError(400, "bad evidence id");
        return json(res, 200, await verifyEvidence(id));
      }
      if (p === "/api/quote") {
        throttle(req);
        const id = Number(url.searchParams.get("claim"));
        const side = url.searchParams.get("side") === "No" ? "No" : "Yes";
        const near = Number(url.searchParams.get("near"));
        if (!Number.isInteger(id) || !(near > 0) || near > 1000) return json(res, 400, { error: "bad claim or amount" });
        return json(res, 200, await view.quoteBuy(id, side, toYocto(near), o.demo?.accountId));
      }

      // ── demo account: the page acts as one funded visitor ──
      if (p === "/api/demo/me") {
        if (!demoChain) return json(res, 404, { error: "demo controls are not enabled" });
        if (!meCache || Date.now() - meCache.at > 1_500) {
          const [near, tr] = await Promise.all([demoChain.balance(), demoChain.trueBalance()]);
          meCache = { at: Date.now(), body: { account: o.demo!.accountId, near: near.toString(), true: tr.toString() } };
        }
        return json(res, 200, meCache.body);
      }
      if (p === "/api/demo/mine" && req.method === "POST") {
        const b = await readBody(req);
        const lie = typeof b.lie_id === "string" ? (o.lies ?? []).find((l) => l.id === b.lie_id) : undefined;
        if (typeof b.lie_id === "string" && !lie) throw httpError(400, "unknown lie");
        const text = String(lie?.text ?? b.text ?? "").trim();
        const topic = String(lie?.topic ?? b.topic ?? "yours");
        if (!/^[a-z0-9_:/-]{1,64}$/.test(topic)) throw httpError(400, "bad topic");
        if (text.length < 8 || text.length > 280 || /[\u0000-\u001f]/.test(text)) throw httpError(400, "claim must be 8-280 characters, no control characters");
        // A picked lie always costs the same; only a typed claim may choose its amounts.
        const stake = lie ? 2 : Math.min(10, Math.max(1, Number(b.stake_near ?? 2)));
        const seed = lie ? 2 : Math.min(5, Math.max(0.5, Number(b.seed_near ?? 2)));
        const prior = lie ? 9_400 : Math.min(9_400, Math.max(5_000, Number(b.prior_bps ?? 9_000)));
        if (![stake, seed, prior].every(Number.isFinite)) throw httpError(400, "stake_near, seed_near and prior_bps must be numbers");
        const out = await demoAction(stake + seed + 0.07, async (c) => {
          const at = Date.now();
          const id = Number(await c.createClaim(topic, text, Math.round(prior), toYocto(seed), toYocto(stake)));
          await pollFresh();
          return { id, at, claim: await view.claim(id) };
        });
        return json(res, 200, out);
      }
      if (p === "/api/demo/trade" && req.method === "POST") {
        const b = await readBody(req);
        const id = Number(b.claim_id);
        const side = b.side === "No" ? "No" : "Yes";
        const near = Math.min(5, Number(b.near));
        if (!Number.isInteger(id) || !(near >= 0.012)) throw httpError(400, "bad claim or amount");
        const evidence = b.evidence_id === null || b.evidence_id === undefined ? null : Number(b.evidence_id);
        const out = await demoAction(near, async (c) => {
          const shares = await c.buy(id, side, toYocto(near), 0n, evidence);
          await pollFresh();
          return { shares, claim: await view.claim(id) };
        });
        return json(res, 200, out);
      }
      if (p === "/api/demo/release" && req.method === "POST") {
        const id = Number((await readBody(req)).claim_id);
        if (!Number.isInteger(id)) throw httpError(400, "bad claim id");
        const out = await demoAction(0, async (c) => { const got = await c.release(id); await pollFresh(); return { released: got }; });
        return json(res, 200, out);
      }
      if (p === "/api/demo/retire" && req.method === "POST") {
        const id = Number((await readBody(req)).claim_id);
        if (!Number.isInteger(id)) throw httpError(400, "bad claim id");
        const out = await demoAction(0, async (c) => { const stake = await c.retire(id); await pollFresh(); return { stake }; });
        return json(res, 200, out);
      }
      if (p === "/api/demo/redeem" && req.method === "POST") {
        const amount = parseTrue((await readBody(req)).amount);
        if (amount === null) throw httpError(400, "amount must be a positive number of $TRUE");
        const out = await demoAction(0, async (c) => { const paid = await c.redeem(amount); await pollFresh(); return { paid }; });
        return json(res, 200, out);
      }

      // The pure text functions the agents use, served so the browser reduces a page to text the same way.
      if (p === "/lib/wikitext.js") {
        const data = await readFile(path.join(here, "lib/wikitext.js")).catch(() => null);
        if (!data) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-cache" });
        return res.end(data.toString("utf8").replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "\n"));
      }

      // static files
      let rel: string;
      try { rel = decodeURIComponent(p === "/" ? "/index.html" : p); } catch { return json(res, 400, { error: "bad path" }); }
      const file = path.normalize(path.join(webDir, rel));
      if (file !== webDir && !file.startsWith(webDir + path.sep)) return json(res, 403, { error: "forbidden" });
      const data = await readFile(file).catch(() => null);
      if (!data) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    } catch (e) {
      const code = (e as { code?: number }).code;
      json(res, typeof code === "number" && code >= 400 && code < 600 ? code : 500, { error: cleanError(e) });
    }
  });

  // Localhost unless asked otherwise: the demo account's endpoints are unauthenticated, so on a shared network anyone could spend it.
  server.listen(o.port, o.host ?? process.env.HOST ?? "127.0.0.1");
  void poll();
  const timer = setInterval(() => void poll(), o.pollMs ?? 2000);
  return { server, poll, pollFresh, stop: () => { clearInterval(timer); server.close(); } };
}
