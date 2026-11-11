// $TRUE, the page. Everything here is read from the server's view of the chain (/api/state, /api/claim, /api/activity);
// the only thing it computes itself is the in-browser check of an evidence source, which is the point of doing it here.

// The text functions the agents use, loaded when a source is first checked. If they cannot be loaded the page still works and a
// check simply does not look for the quote.
let textTools;
async function loadTextTools() {
  if (textTools === undefined) textTools = await import("./lib/wikitext.js").catch(() => null);
  return textTools;
}

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T18 = 10n ** 18n;
const trueNum = (s) => Number(BigInt(s || "0") / 10n ** 12n) / 1e6;
const fmtTrue = (s, d = 0) => trueNum(s).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const nearNum = (y) => Number(BigInt(y || "0") / 10n ** 18n) / 1e6;
const nearTxt = (y, d = 2) => nearNum(y).toFixed(d);
const pct = (bps) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 1);
const short = (a) => (a.length > 24 ? a.slice(0, 10) + "…" + a.slice(-10) : a);
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const secs = (ms) => (ms >= 90_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(0, Math.round(ms / 1000))}s`);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`);
  return j;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

let state = null;
let acts = [];
let lastAct = 0;
let me = null;
let selected = null;
let detail = null;
const verified = new Map();
let prevTotal = null;
let deltaUntil = 0;

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 6500);
}

// ───────────────────────────── captions mode (?captions=1) ─────────────────────────────
// A silent walk-through for screen recording: on-screen captions, highlights, and a scripted pass over the page that plays the story.

const CAPTIONS = new URLSearchParams(location.search).has("captions");
function caption(text, kind = "") {
  if (!CAPTIONS) return;
  const el = $("#cap");
  el.hidden = false;
  el.className = kind;
  el.textContent = text;
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
}
const captionOff = () => { if (CAPTIONS) $("#cap").hidden = true; };
function spot(target) {
  document.querySelectorAll(".spot").forEach((e) => e.classList.remove("spot"));
  const el = typeof target === "string" ? $(target) : target;
  if (el) el.classList.add("spot");
}
const STORY_CAPS = [
  "Bonding 2 NEAR to a false claim",
  "The market believes it, so it mints $TRUE: locked, not spendable",
  "A verifier reads Wikipedia against the claim",
  "Evidence on chain: a verbatim quote, a hash, a bond",
  "The price falls and the average follows it down",
  "Debunked: the tokens burn and the 2 NEAR bond goes to the Truth Fund",
];
// A visible cursor that glides to a real element, presses, and clicks it, so a recording shows what is being operated.
let ghostEl;
function ghost() {
  if (!ghostEl) {
    ghostEl = document.createElement("div");
    ghostEl.id = "ghost";
    ghostEl.innerHTML = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    ghostEl.style.transform = `translate(${Math.round(innerWidth * 0.6)}px, ${Math.round(innerHeight * 0.62)}px)`;
    document.body.appendChild(ghostEl);
  }
  return ghostEl;
}
/** Moves the cursor onto `target` (an element, or a selector that is looked up again at the moment of the click, because the drawer redraws) and clicks. */
async function clickOn(target) {
  const find = () => (typeof target === "string" ? $(target) : target);
  let el = find();
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(950);
  el = find() ?? el;
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, 110);
  const y = r.top + Math.min(r.height / 2, 26);
  const g = ghost();
  g.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  await sleep(1050);
  g.classList.add("press");
  const rip = document.createElement("div");
  rip.className = "ripple";
  rip.style.left = `${x}px`; rip.style.top = `${y}px`;
  document.body.appendChild(rip);
  setTimeout(() => rip.remove(), 800);
  await sleep(170);
  (find() ?? el).click();
  await sleep(280);
  g.classList.remove("press");
  return true;
}
async function waitFor(fn, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch { /* keep waiting */ } await sleep(400); }
  return null;
}

async function directedDemo() {
  await waitFor(() => state && state.claims.filter((c) => c.mine.state === "Mining").length >= 2, 120000);
  await sleep(1500);
  window.scrollTo({ top: 0, behavior: "smooth" });
  caption("$TRUE: a token minted from what a market believes");
  spot("#supply"); await sleep(4500);
  caption("Every claim is a market that never resolves. Bond NEAR to one and it mints $TRUE while the market believes it.");
  spot("#claims"); await sleep(5500);
  const mining = state.claims.find((c) => c.mine.state === "Mining" && c.mine.ema_bps >= 7000) ?? state.claims.find((c) => c.mine.state === "Mining");
  if (mining) {
    const card = cardEls.get(mining.id);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(900);
    caption("Dot = the price now. Ring = its running average. Only the ring can mint.");
    spot(card?.querySelector(".gauge")); await sleep(5500);
    caption("Open a claim: the average trails the price, so a pump nobody defends mints almost nothing");
    spot(null); await clickOn(card); await sleep(6500);
    await clickOn("[data-close]");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  await sleep(700);
  caption("Now: bond 2 NEAR to a false claim, and watch what happens");
  await sleep(2500);
  await clickOn("#playStory");
  await waitFor(() => story && story.claimId !== null, 30000);
  await waitFor(() => !story || story.ended, 240000);
  document.body.dataset.storyResult = story && story.reached >= 5 ? "debunked" : "incomplete";
  const s = story;
  if (s?.claimId !== null && s?.claimId !== undefined) {
    caption("Open the claim that was just debunked");
    await clickOn("#story [data-claim]");
    await waitFor(() => !$("#drawer").hidden && document.querySelector("#drawerBody .evcard"), 15000);
    caption("The evidence: a verbatim quote from Wikipedia, the page's hash, and a bond. Anyone can re-check it.");
    await sleep(6500);
    if (document.querySelector("#drawerBody [data-verify]") && !s.verified) {
      caption("Verify in your browser: it fetches the page itself and re-hashes it");
      await clickOn("#drawerBody [data-verify]");
      await waitFor(() => /Verified|MISMATCH|NOT in|cannot be checked|could not/i.test(document.querySelector("#drawerBody .vres")?.textContent ?? ""), 25000);
      await sleep(1200);
    }
    caption(s.verified || /Verified in your browser/.test(document.querySelector("#drawerBody .vres")?.textContent ?? "") ? "Verified in the browser: it re-hashed the page itself. No oracle, no referee." : "On a live run the browser re-hashes the Wikipedia page itself. No oracle, no referee.");
    await sleep(6000);
    await clickOn("[data-close]");
  }
  const ready = [...cardEls.values()].find((el) => /ready to release/.test($(".status", el)?.textContent ?? ""));
  if (ready) {
    ready.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(900);
    caption("Tokens only become spendable after a claim has stayed at 90% for a whole season", "");
    spot(ready); await sleep(4500);
    spot(null); await clickOn(ready); await sleep(5500);
    await clickOn("[data-close]");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  await sleep(700);
  caption("The Truth Fund: burn $TRUE, take your share of the bonds of lies that were debunked");
  spot("#fund"); await sleep(6000);
  caption("Running on a local NEAR node. Not on testnet yet. DESIGN.md lists what this does not prove.", "warn");
  spot(null); await sleep(6500);
  captionOff();
  document.body.dataset.directed = "done";
}

const claimOf = (id) => state?.claims.find((c) => c.id === id) ?? null;
const heldOf = (c) => BigInt(c.mine.locked) + BigInt(c.mine.released);
const remaining = (c) => (c.mine.release_in_ms === null ? null : Math.max(0, c.mine.release_in_ms - (Date.now() - state.at)));

// ───────────────────────────── badges ─────────────────────────────

function renderBadges() {
  const s = state;
  const b = [];
  b.push(`<span class="badge ${s.ok ? "live" : "bad"}">${s.ok ? "live" : "chain unreachable"}</span>`);
  b.push(`<span class="badge">${esc(s.network)}</span>`);
  b.push(`<span class="badge ${s.mockCorpus ? "warn" : ""}" title="what reads the sources">${esc(s.judge)}</span>`);
  if (s.config) b.push(`<span class="badge" title="how long the price average takes to close half its gap to the price">half-life ${secs(s.config.half_life_ms)}</span><span class="badge" title="how long a claim must stay at 90% before its tokens can be released">season ${secs(s.config.season_ms)}</span>`);
  setHTML($("#badges"), b.join(""));
}

const sigs = new WeakMap();
function setHTML(el, html) {
  if (sigs.get(el) === html) return;
  sigs.set(el, html);
  el.innerHTML = html;
}

// ───────────────────────────── supply ─────────────────────────────

function renderSupply() {
  const s = state.supply;
  if (!s) return;
  const total = BigInt(s.total);
  const liquid = BigInt(s.liquid);
  const locked = BigInt(s.locked);
  const pctOf = (x) => (total === 0n ? 0 : Number((x * 10000n) / total) / 100);
  if (prevTotal !== null && total !== prevTotal) deltaUntil = Date.now() + 6000;
  const d = prevTotal === null ? 0n : total - prevTotal;
  if (total !== prevTotal) { prevTotal = total; lastDelta = d; }
  const showDelta = Date.now() < deltaUntil && lastDelta !== 0n;
  const n = fmtTrue(s.total);
  const html = `
    <h3>Supply</h3>
    <div class="big"><span class="n num" id="supplyN">${n}</span><span class="u">$TRUE</span>${showDelta ? `<span class="delta ${lastDelta > 0n ? "up" : "down"} num">${lastDelta > 0n ? "+" : ""}${fmtTrue(lastDelta.toString())}</span>` : ""}</div>
    <div class="stack" role="img" aria-label="${fmtTrue(s.liquid)} spendable, ${fmtTrue(s.locked)} locked"><i class="liquid" style="width:${pctOf(liquid)}%"></i><i class="locked" style="width:${pctOf(locked)}%"></i></div>
    <div class="legend">
      <span><i class="dot liquid"></i>spendable <b class="num">${fmtTrue(s.liquid)}</b></span>
      <span><i class="dot locked"></i>locked in live mines <b class="num">${fmtTrue(s.locked)}</b></span>
      <span><i class="dot mint"></i>minted ever <b class="num">${fmtTrue(s.minted_total)}</b></span>
      <span><i class="dot burn"></i>burned ever <b class="num">${fmtTrue(s.burned_total)}</b></span>
    </div>
    ${sparkSVG(state.history)}
    <div class="kpis">
      <div class="kpi"><span>mining now</span><b>${s.mining}</b></div>
      <div class="kpi"><span>debunked</span><b>${s.debunked}</b></div>
      <div class="kpi"><span>retired</span><b>${s.retired}</b></div>
      <div class="kpi"><span>left behind by debunks</span><b title="released by a mine that was debunked after the miner had already moved them on">${fmtTrue(s.orphaned)}</b></div>
    </div>`;
  setHTML($("#supply"), html);

  const floor = BigInt(s.floor_per_true);
  setHTML($("#fund"), `
    <h3>The Truth Fund</h3>
    <div class="amt num">${nearTxt(s.fund, 2)} <span class="u" style="font-size:15px;color:var(--ink-3)">NEAR</span></div>
    <div class="sub">the bonds of lies that were debunked</div>
    <div class="floor">Burn $TRUE, take your share. Today one $TRUE redeems for <b>${floor === 0n ? "0" : (nearNum(floor.toString()) < 0.0001 ? "<0.0001" : nearNum(floor.toString()).toFixed(4))} NEAR</b>.</div>
    <p class="why">The only way to make $TRUE is to be believed, and the only way to lose a bond is to be refuted. So the floor is paid for by liars.</p>`);
}
let lastDelta = 0n;

function sparkSVG(hist) {
  if (!hist || hist.length < 2) return `<svg class="spark" viewBox="0 0 600 92" role="img" aria-label="supply over time"></svg>`;
  const W = 600, H = 92, pad = 4;
  const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 1);
  const pts = hist.map((h) => ({ x: pad + ((h.t - t0) / (t1 - t0)) * (W - 2 * pad), l: Number(BigInt(h.liquid) / 10n ** 15n) / 1e3, k: Number(BigInt(h.locked) / 10n ** 15n) / 1e3 }));
  const max = Math.max(1, ...pts.map((p) => p.l + p.k));
  const y = (v) => H - pad - (v / max) * (H - 2 * pad - 6);
  const step = (arr, f) => arr.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${y(f(p)).toFixed(1)}`).join(" ");
  const area = (top, bottom) => `${step(pts, top)} ${pts.slice().reverse().map((p) => `L${p.x.toFixed(1)},${y(bottom(p)).toFixed(1)}`).join(" ")} Z`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="supply over the last few minutes">
    <path d="${area((p) => p.l + p.k, (p) => p.l)}" fill="var(--amber)" fill-opacity=".55"/>
    <path d="${area((p) => p.l, () => 0)}" fill="var(--ice)" fill-opacity=".6"/>
    <path d="${step(pts, (p) => p.l + p.k)}" fill="none" stroke="var(--ink-2)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// ───────────────────────────── claims (keyed, so gauges animate) ─────────────────────────────

const cardEls = new Map();
const cardTemplate = `
  <div class="head"><span class="chip st"></span><span class="chip plain topic"></span><span class="by"></span></div>
  <div class="text"></div>
  <div class="gauge" aria-hidden="true"><div class="track"></div><i class="tick" style="left:30%"></i><i class="tick" style="left:70%"></i><i class="tick" style="left:90%"></i><i class="avg"></i><i class="price"></i></div>
  <div class="gauge-legend"><span>debunk &lt;30</span><span class="f gl"></span><span>mints &gt;70 · full 90</span></div>
  <div class="tokens"><div class="bar"><i class="l"></i><i class="r"></i></div><div class="row"><span>locked <b class="lk"></b></span><span>released <b class="rl"></b></span><span>cap <b class="cp"></b></span></div></div>
  <div class="foot"><span class="status"></span><span class="meta"></span></div>`;

function statusOf(c) {
  const m = c.mine;
  if (m.state === "Debunked") return ["bad", "average fell under 30%: tokens burned, bond confiscated"];
  if (m.state === "Retired") return ["", "closed by its miner: tokens burned, bond returned"];
  if (m.state === "None") return ["", "a plain market: it mints nothing"];
  if (m.debunk_due) return ["bad", "average under 30%: debunk is due"];
  const r = remaining(c);
  if (r !== null) return r <= 0 ? ["go", "believed at 90% for a full season: ready to release"] : ["go", `average at ${pct(m.ema_bps)}%: release in ${secs(r)}`];
  if (m.ema_bps > 7000) return ["go", `average at ${pct(m.ema_bps)}%: minting`];
  return ["warn", `average at ${pct(m.ema_bps)}%: not minting (needs 70%)`];
}

function updateCard(el, c) {
  const m = c.mine;
  const dead = m.state === "Debunked";
  el.classList.toggle("dead", dead);
  const st = $(".st", el);
  st.className = `chip st ${m.state === "Mining" ? "mining" : dead ? "dead" : m.state === "Retired" ? "retired" : "plain"}`;
  st.textContent = m.state === "None" ? "plain" : m.state.toLowerCase();
  $(".topic", el).textContent = c.topic;
  $(".by", el).textContent = `#${c.id} · ${short(c.creator)}`;
  $(".text", el).textContent = c.text;
  $(".price", el).style.left = `${c.price_bps / 100}%`;
  const avg = $(".avg", el);
  avg.style.left = `${m.ema_bps / 100}%`;
  avg.style.display = m.state === "None" ? "none" : "";
  $(".gl", el).textContent = `price ${pct(c.price_bps)}% · avg ${pct(m.ema_bps)}%`;
  const cap = BigInt(m.cap) || 1n;
  const lk = BigInt(m.locked), rl = BigInt(m.released);
  $(".tokens .l", el).style.width = `${Math.min(100, Number((lk * 10000n) / cap) / 100)}%`;
  $(".tokens .r", el).style.width = `${Math.min(100, Number((rl * 10000n) / cap) / 100)}%`;
  $(".lk", el).textContent = fmtTrue(m.locked);
  $(".rl", el).textContent = fmtTrue(m.released);
  $(".cp", el).textContent = m.state === "Mining" ? fmtTrue(m.cap) : "0";
  $(".tokens", el).style.display = m.state === "None" ? "none" : "";
  const [cls, txt] = statusOf(c);
  const sEl = $(".status", el);
  sEl.className = `status ${cls}`;
  sEl.textContent = txt;
  $(".meta", el).textContent = `${c.evidence.length} evidence · ${nearTxt(c.mine.stake, 1)} NEAR bonded`;
  // A flash when something happened to it since the last look.
  const prev = el._prev;
  if (prev) {
    if (prev.state === "Mining" && dead) flash(el, "flash-dead");
    else if (heldOf(c) > prev.held) flash(el, "flash-mint");
    else if (heldOf(c) < prev.held) flash(el, "flash-burn");
  }
  el._prev = { state: m.state, held: heldOf(c) };
}
function flash(el, cls) { el.classList.remove("flash-mint", "flash-burn", "flash-dead"); void el.offsetWidth; el.classList.add(cls); }

function renderClaims() {
  const box = $("#claims");
  if (state.claims.length) box.querySelector(".empty")?.remove();
  const rank = (c) => (c.mine.state === "Mining" ? 0 : c.mine.state === "Debunked" ? 1 : c.mine.state === "Retired" ? 2 : 3);
  const list = state.claims.slice().sort((a, b) => rank(a) - rank(b) || Number(heldOf(b) - heldOf(a)) || b.id - a.id);
  $("#mineCount").textContent = `${state.claims.length} claims`;
  for (const c of list) {
    let el = cardEls.get(c.id);
    if (!el) {
      el = document.createElement("button");
      el.type = "button";
      el.className = "claim";
      el.dataset.id = c.id;
      el.innerHTML = cardTemplate;
      cardEls.set(c.id, el);
      box.appendChild(el);
    }
    updateCard(el, c);
  }
  // Order only when it changed, so a card under the pointer does not jump while it is being clicked.
  const want = list.map((c) => c.id).join(",");
  if (box._order !== want) {
    box._order = want;
    list.forEach((c, i) => { if (box.children[i] !== cardEls.get(c.id)) box.insertBefore(cardEls.get(c.id), box.children[i] ?? null); });
  }
  if (!state.claims.length && !box.querySelector(".empty")) box.insertAdjacentHTML("afterbegin", `<p class="empty">No claims yet. The miners are reading sources; the first mine opens in a few seconds.</p>`);
}

// ───────────────────────────── side panels ─────────────────────────────

function renderAgents() {
  const rows = state.agents.map((a) => {
    const held = BigInt(a.locked) + BigInt(a.released);
    const bits = [];
    if (a.true !== "0") bits.push(`${fmtTrue(a.true)} $TRUE`);
    if (held > 0n) bits.push(`${fmtTrue(held.toString())} in mines`);
    bits.push(`${nearTxt(a.near, 1)} NEAR`);
    return `<div class="agent"><span class="pulse ${a.active ? "on" : ""}"></span><div><span class="nm">${esc(a.name)}</span><span class="role ${a.role}">${esc(a.role)}</span></div><span class="bal">${bits.join(" · ")}</span>
      <div class="now">${a.now ? esc(a.now.text) : "waiting"}</div></div>`;
  }).join("");
  setHTML($("#agents"), `<h3>Who is working</h3>${rows || `<p class="empty">No agents are attached to this server.</p>`}`);
}

const KIND_LABEL = { mine: "mine", mint: "mint", burn: "burn", debunk: "debunk", release: "release", evidence: "evidence", trade: "trade", judge: "read", source: "read", settle: "bond", error: "error", skip: "skip", info: "info" };
function renderFeed() {
  const shown = acts.filter((a) => !["scan", "source", "skip"].includes(a.kind)).slice(-40).reverse();
  const rows = shown.map((a) => `<div class="ev ${["debunk", "mint", "burn", "release", "mine"].includes(a.kind) ? "big" : ""}"><time>${clock(a.ts)}</time><div class="t"><span class="k ${a.kind}">${KIND_LABEL[a.kind] ?? a.kind}</span>${esc(a.agent)}: ${esc(a.text)}</div></div>`).join("");
  setHTML($("#feed"), `<h3>What just happened</h3>${rows || `<p class="empty">Nothing yet.</p>`}`);
}

// the "you" card: its forms are built once so a poll never clears what is being typed
function buildYou() {
  const el = $("#you");
  el.classList.add("you");
  if (!state.demo) { el.innerHTML = `<h3>Act</h3><p class="empty">This server has no demo account. Read-only.</p>`; return; }
  el.innerHTML = `
    <h3>You (a funded demo account)</h3>
    <div id="youStats"></div>
    <form id="lieForm"><label>Bond 2 NEAR to a lie, and watch what happens
      <select id="lieSel"></select></label>
      <button class="primary" type="submit">Mine this lie</button></form>
    <form id="ownForm"><label>Or mine a claim of your own
      <textarea id="ownText" maxlength="280" placeholder="Pluto was discovered in 1930 by Clyde Tombaugh."></textarea></label>
      <div class="inline"><label>Bond (NEAR)<input id="ownStake" type="number" min="1" max="10" step="0.5" value="2"></label><label>Opens at (%)<input id="ownPrior" type="number" min="50" max="94" step="1" value="90"></label></div>
      <button class="ghost" type="submit">Bond &amp; open</button>
      <span class="hint">Verifiers only move a claim they can find a source for.</span></form>
    <form id="redeemForm"><label>Redeem $TRUE from the Truth Fund
      <div class="inline"><input id="redeemAmt" inputmode="decimal" placeholder="amount"><button class="ghost" type="submit">Redeem</button></div></label></form>
    <div class="hint" id="youMsg"></div>`;
  const sel = $("#lieSel");
  for (const l of state.lies) sel.insertAdjacentHTML("beforeend", `<option value="${esc(l.id)}">${esc(l.text)}</option>`);
  $("#lieForm").addEventListener("submit", async (e) => { e.preventDefault(); await act("mining the lie", () => post("api/demo/mine", { lie_id: sel.value })); });
  $("#ownForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await act("opening your claim", () => post("api/demo/mine", { text: $("#ownText").value, topic: "yours", stake_near: Number($("#ownStake").value), prior_bps: Number($("#ownPrior").value) * 100 }));
  });
  $("#redeemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await act("redeeming", () => post("api/demo/redeem", { amount: $("#redeemAmt").value }));
    if (r) toast(`Redeemed for ${nearTxt(r.paid, 3)} NEAR from the Truth Fund.`);
  });
}

async function act(what, fn) {
  const msg = $("#youMsg");
  if (msg) msg.textContent = `${what}…`;
  try {
    const r = await fn();
    if (msg) msg.textContent = "";
    await refresh();
    return r;
  } catch (e) {
    if (msg) msg.textContent = e.message;
    toast(e.message, "err");
    return null;
  }
}

function renderYou() {
  const el = $("#youStats");
  if (!el || !me) return;
  const mine = state.claims.filter((c) => c.creator === me.account && c.mine.state === "Mining");
  const locked = mine.reduce((a, c) => a + BigInt(c.mine.locked), 0n);
  setHTML(el, `<div class="row"><span>NEAR</span><b>${nearTxt(me.near, 2)}</b></div>
    <div class="row"><span>$TRUE spendable</span><b>${fmtTrue(me.true, 1)}</b></div>
    <div class="row"><span>$TRUE locked in your mines</span><b>${fmtTrue(locked.toString(), 1)}</b></div>`);
}

// ───────────────────────────── claim drawer ─────────────────────────────

function openClaim(id) {
  selected = id;
  detail = null;
  $("#drawer").hidden = false;
  document.body.style.overflow = "hidden";
  renderDrawer();
  void loadDetail();
}
function closeClaim() {
  selected = null;
  $("#drawer").hidden = true;
  document.body.style.overflow = "";
}
async function loadDetail() {
  if (selected === null) return;
  try { detail = await api(`api/claim?id=${selected}`); renderDrawer(); } catch { /* the next poll tries again */ }
}

function chartSVG(hist, claim) {
  const W = 680, H = 230, L = 34, R = 10, Tp = 10, B = 22;
  if (!hist || hist.length < 2) return `<svg class="chart" viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle">collecting history…</text></svg>`;
  const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 1);
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (bps) => Tp + (1 - bps / 10000) * (H - Tp - B);
  const line = (f) => hist.map((h, i) => `${i === 0 ? "M" : "L"}${x(h.t).toFixed(1)},${y(f(h)).toFixed(1)}`).join(" ");
  const bands = [[0, 3000, "var(--red-d)", 1], [7000, 9000, "var(--mint)", 0.12], [9000, 10000, "var(--mint)", 0.24]];
  const zones = bands.map(([a, b, fill, op]) => `<rect x="${L}" y="${y(b).toFixed(1)}" width="${W - L - R}" height="${(y(a) - y(b)).toFixed(1)}" fill="${fill}" fill-opacity="${op}"/>`).join("");
  const grid = [3000, 7000, 9000].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line-2)" stroke-dasharray="3 4"/><text x="${L - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v / 100}</text>`).join("");
  const ends = [0, 5000, 10000].map((v) => `<text x="${L - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v / 100}</text>`).join("");
  const span = Math.round((t1 - t0) / 1000);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="price and average over the last ${span} seconds">
    ${zones}${grid}${ends}
    <path d="${line((h) => h.price)}" fill="none" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="${line((h) => h.ema)}" fill="none" stroke="${claim?.mine.state === "Debunked" ? "var(--red)" : "var(--mint)"}" stroke-width="2.6" stroke-linejoin="round"/>
    <text x="${L}" y="${H - 6}">${span}s ago</text><text x="${W - R}" y="${H - 6}" text-anchor="end">now</text>
    <text x="${W - R - 4}" y="${Tp + 10}" text-anchor="end" fill="var(--ink)">— price</text><text x="${W - R - 4}" y="${Tp + 22}" text-anchor="end" style="fill:var(--mint)">— average</text>
  </svg>`;
}
function heldSVG(hist, cap) {
  const W = 680, H = 90, L = 34, R = 10;
  if (!hist || hist.length < 2 || !cap || cap === 0n) return "";
  const t0 = hist[0].t, t1 = Math.max(hist[hist.length - 1].t, t0 + 1);
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (h) => H - 14 - Math.min(1, Number((BigInt(h) * 10000n) / cap) / 10000) * (H - 24);
  const pts = hist.map((h) => `${x(h.t).toFixed(1)},${y(h.held).toFixed(1)}`);
  return `<svg class="chart" style="height:90px" viewBox="0 0 ${W} ${H}" role="img" aria-label="tokens held by this claim">
    <path d="M${x(t0)},${H - 14} L${pts.join(" L")} L${x(t1)},${H - 14} Z" fill="var(--amber)" fill-opacity=".5" stroke="var(--amber)"/>
    <text x="${L - 4}" y="12" text-anchor="end">cap</text><text x="${L}" y="${H - 2}">$TRUE held by the claim (locked + released)</text>
  </svg>`;
}

function evidenceCard(e) {
  const key = `${e.uri}\n${e.content_hash}`;
  const v = verified.get(key);
  const busy = v?.status === "busy";
  const src = e.source;
  const link = src.readable ? `<a href="${esc(src.readable)}" target="_blank" rel="noopener noreferrer">${esc(src.label)}</a>` : esc(src.label);
  return `<div class="evcard"><span class="st ${e.stance === "Support" ? "s" : "r"}">${e.stance === "Support" ? "supports" : "refutes"}</span>
    <q>${esc(e.note.replace(/^"|"$/g, ""))}</q>
    <div class="meta"><span>${link}</span><span title="${esc(e.content_hash)}">sha256 <code>${esc(e.content_hash.slice(0, 12))}…</code></span><span>${nearTxt(e.backing, 2)} NEAR behind it</span><span>bond ${esc(e.bond_state.toLowerCase())}</span>
    ${src.mock ? `<span>offline test corpus: nothing to fetch</span>` : `<button class="vbtn" data-verify data-eid="${e.id}" ${busy ? "disabled" : ""}>${v && !busy ? "Verify again" : "Verify in your browser"}</button>`}</div>
    ${v ? `<span class="vres ${v.status}">${esc(v.text)}</span>` : ""}</div>`;
}

function renderDrawer() {
  if (selected === null) return;
  const c = claimOf(selected) ?? detail?.claim;
  if (!c) return;
  const m = c.mine;
  const [, status] = statusOf(c);
  const cap = BigInt(m.cap);
  const mineHere = !!me && c.creator === me.account;
  const r = remaining(c);
  const canRelease = mineHere && m.state === "Mining" && r === 0 && BigInt(m.locked) > 0n;
  const canRetire = mineHere && m.state === "Mining";
  const why = [];
  if (m.state === "Mining") {
    why.push(`The price is <b>${pct(c.price_bps)}%</b>. Its running average is <b>${pct(m.ema_bps)}%</b>. The average closes half its gap to the price every ${state.config ? secs(state.config.half_life_ms) : "…"}, so a pump has to be <i>held</i>, not just made.`);
    why.push(`Above 70% the claim mints, up to its cap of ${fmtTrue(m.cap)} $TRUE (1,000 per NEAR bonded) at 90%. Minted tokens are locked: they count in the supply, but cannot be spent.`);
    why.push(`After the average has stayed at 90% for a whole season, the miner may release the locked tokens. Under 70% they burn again. Under <b>30% at any time</b>, the claim is debunked: its tokens burn and the ${nearTxt(m.stake, 1)} NEAR bond goes to the Truth Fund.`);
  } else if (m.state === "Debunked") why.push("This claim's average fell under 30%. Its tokens were burned (or taken back from the miner), and its bond is in the Truth Fund. The market is still open: prices keep moving, but this mine is closed for good.");
  else if (m.state === "Retired") why.push("Its miner burned everything the claim had minted and took the bond back.");
  else why.push("Nobody bonded NEAR to this claim, so it mints nothing. It is still a market.");
  const html = `
    <button class="ghost dclose" type="button" data-close>Close</button>
    <div class="head" style="display:flex;gap:8px;align-items:center;color:var(--ink-3);font-size:12px"><span class="chip ${m.state === "Mining" ? "mining" : m.state === "Debunked" ? "dead" : "plain"}">${m.state === "None" ? "plain" : m.state.toLowerCase()}</span><span>#${c.id} · ${esc(c.topic)} · by ${esc(short(c.creator))}</span></div>
    <h2>${esc(c.text)}</h2>
    <p class="hint">${esc(status)}</p>
    <div class="stats">
      <div class="stat"><span>price</span><b>${pct(c.price_bps)}%</b></div>
      <div class="stat"><span>average</span><b>${pct(m.ema_bps)}%</b></div>
      <div class="stat"><span>locked</span><b>${fmtTrue(m.locked)}</b></div>
      <div class="stat"><span>released</span><b>${fmtTrue(m.released)}</b></div>
      <div class="stat"><span>bond</span><b>${nearTxt(m.stake, 1)} NEAR</b></div>
      <div class="stat"><span>market depth</span><b>${nearTxt(c.collateral, 1)} NEAR</b></div>
    </div>
    ${chartSVG(detail?.history, c)}
    ${heldSVG(detail?.history, cap)}
    <ul class="rules">${why.map((w) => `<li>${w}</li>`).join("")}</ul>
    ${state.demo ? `<div class="inline" style="margin:10px 0 4px">
      <button class="ghost" data-trade="Yes">Defend: buy YES (0.5 NEAR)</button>
      <button class="ghost danger" data-trade="No">Attack: buy NO (0.5 NEAR)</button>
      ${mineHere ? `<button class="ghost" data-release ${canRelease ? "" : "disabled"} title="needs a season at 90%">Release tokens</button><button class="ghost" data-retire ${canRetire ? "" : "disabled"} title="burns everything the claim minted and returns the bond; refused for a season after the market last disbelieved the claim">Retire</button>` : ""}
    </div>` : ""}
    <h3 style="margin-top:16px">Evidence on chain</h3>
    ${detail ? (detail.evidence.length ? detail.evidence.map(evidenceCard).join("") : `<p class="empty">None yet. A verifier posts evidence when a price is wrong by enough to be worth correcting; a claim priced where its source says it should be draws none.</p>`) : `<p class="empty">loading…</p>`}`;
  setHTML($("#drawerBody"), html);
}

// ───────────────────────────── in-browser verification ─────────────────────────────

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const sameTitle = (a, b) => String(a).replace(/_/g, " ").trim().toLowerCase() === String(b).replace(/_/g, " ").trim().toLowerCase();

function setVerified(key, status, text) {
  verified.set(key, { status, text });
  if (selected !== null) renderDrawer();
  return verified.get(key);
}

/**
 * Check a source against what is on chain. The browser does it when it can: Wikipedia's API allows cross-origin reads, and the
 * wikitext it returns hashes to exactly the bytes the agents fetched. It checks the hash, that the revision belongs to the page the
 * source is labelled as, and that the quote the agent posted is really in the page, reduced to text by the very code the agents
 * ran. What it cannot remove is trust in Wikipedia and in the connection to it. Otherwise the server refetches, allowlisted hosts only.
 */
async function verify(e) {
  const key = `${e.uri}\n${e.content_hash}`;
  setVerified(key, "busy", "fetching the revision…");
  const src = e.source;
  let titleNote = "";
  if (/(^|\.)wikipedia\.org$/.test(src.host) && src.rev) {
    try {
      const apiUrl = `https://${src.host}/w/api.php?action=query&prop=revisions&revids=${src.rev}&rvprop=content&rvslots=main&format=json&formatversion=2&origin=*`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const j = await fetch(apiUrl, { signal: ctl.signal }).then((r) => r.json()).finally(() => clearTimeout(timer));
      const page = j.query.pages[0];
      const content = page.revisions[0].slots.main.content;
      const digest = await sha256Hex(new TextEncoder().encode(content));
      if (digest !== e.content_hash) {
        setVerified(key, "busy", "your browser's copy hashed differently; asking the server to compare the raw page…");
      } else if (src.title && !sameTitle(page.title, src.title)) {
        titleNote = ` The revision now belongs to the page “${page.title}”, not “${src.title}” as this source is labelled: it may have been renamed since, or the label may be wrong.`;
        setVerified(key, "busy", "the page title differs from the label; asking the server to compare the raw page…");
      } else {
        const tools = await loadTextTools();
        const quote = tools && e.note ? tools.quotedText(e.note) : null;
        const quoteOk = quote ? tools.quoteIsInSource(quote, tools.cleanWikitext(content)) : null;
        if (quoteOk === false) return setVerified(key, "bad", "✗ The hash matches, but the quoted text is NOT in that page. The agent's quote cannot be trusted.");
        const extra = quoteOk ? ", and the quoted text is in it word for word" : !tools && e.note ? " (the quote was not checked: the text module could not be loaded)" : "";
        return setVerified(key, "ok", `✓ Verified in your browser: revision ${src.rev} of “${page.title}” hashes to ${e.content_hash.slice(0, 12)}…, exactly what was posted${extra}. You are still trusting Wikipedia and your connection to it.`);
      }
    } catch {
      setVerified(key, "busy", "the browser could not fetch it; asking the server…");
    }
  }
  try {
    const r = await api(`api/verify?evidence=${e.id}`);
    if (r.ok === true && r.quoteFound === false) setVerified(key, "bad", "✗ The page hashes correctly, but the quoted text is NOT in it. The agent's quote cannot be trusted.");
    else if (r.ok === true) setVerified(key, "ok", `✓ Verified by the server: the page it fetched hashes to the recorded value${r.quoteFound ? " and contains the quote" : ""}.${titleNote || " (The page title was not checked on this path.)"}`);
    else if (r.ok === false) setVerified(key, "bad", `✗ MISMATCH. The page now hashes to ${r.actual.slice(0, 12)}…, not ${r.expected.slice(0, 12)}…`);
    else setVerified(key, "na", r.note || "this source cannot be checked");
  } catch (err) { setVerified(key, "na", err.message); }
  return verified.get(key);
}

// ───────────────────────────── the story ─────────────────────────────

const STEPS = ["A lie is bonded", "Belief mints $TRUE", "A verifier reads the source", "Evidence goes on chain", "The market turns", "Debunked", "You verify it"];
let story = null;

function storyHTML() {
  const s = story;
  const isDone = (i) => (s.claimId !== null && i <= s.reached) || (i === 6 && s.verified);
  const steps = STEPS.map((l, i) => `<span class="${isDone(i) ? "done" : !s.ended && i === s.reached + 1 ? "now" : ""}">${i + 1} ${esc(l)}</span>`).join("");
  return `<h3>The story: a lie meets the mine</h3><div class="steps">${steps}</div>
    <div class="narr">${s.narr.map((p) => `<p>${p}</p>`).join("")}</div>
    ${s.facts.length ? `<div class="facts">${s.facts.map(([k, v]) => `<div class="fact">${esc(k)}<b class="num">${esc(v)}</b></div>`).join("")}</div>` : ""}
    <div class="end">${s.ended ? `<button class="primary" type="button" data-story-again>Play again</button>` : `<button class="ghost" type="button" data-story-stop>Stop</button>`}
      ${s.claimId !== null ? `<button class="ghost" type="button" data-claim="${s.claimId}">Open the claim</button>` : ""}
      ${s.ended ? `<button class="ghost" type="button" data-story-close>Close</button>` : ""}</div>`;
}
function paintStory() { const el = $("#story"); el.hidden = false; setHTML(el, storyHTML()); }

async function playStory() {
  if (story && !story.ended) return;
  if (!state?.demo) return toast("This server has no demo account, so there is nothing to play as.", "err");
  const onChain = new Set(state.claims.map((c) => c.text));
  const lie = state.lies.find((l) => !onChain.has(l.text)) ?? state.lies[0];
  if (!lie) return toast("There is no lie to inject on this server.", "err");
  story = { reached: 0, verified: false, narr: [], facts: [], ended: false, claimId: null, lie, maxLocked: 0n, startedAt: Date.now(), before: { near: me?.near ?? "0", supply: state.supply?.total ?? "0" } };
  $("#playStory").disabled = true;
  story.narr = [`Bonding 2 NEAR to “${esc(lie.text)}”. That statement is false.`];
  paintStory();
  $("#story").scrollIntoView({ behavior: "smooth", block: "nearest" });
  let r;
  try { r = await post("api/demo/mine", { lie_id: lie.id }); }
  catch (e) { story.narr = [`Could not start: ${esc(e.message)}`]; story.ended = true; $("#playStory").disabled = false; paintStory(); return; }
  story.claimId = r.id;
  story.enter = r.claim.price_bps;
  story.narr = [
    `You bonded <b>2 NEAR</b> to a false statement and opened its market. It opens at <b>${pct(story.enter)}%</b>, and nothing has been minted: the price average starts at 50%, so a claim must be <i>believed for a while</i> before it earns a token.`,
  ];
  story.facts = [["bond at risk", "2 NEAR"], ["opening price", `${pct(story.enter)}%`], ["supply now", `${fmtTrue(state.supply.total)} $TRUE`]];
  paintStory();
  void driveStory();
}

async function driveStory() {
  const s = story;
  while (s === story && !s.ended) {
    await sleep(1000);
    await refresh().catch(() => {});
    const c = claimOf(s.claimId);
    if (!c) continue;
    let d = null;
    try { d = await api(`api/claim?id=${s.claimId}`); if (selected === s.claimId) { detail = d; renderDrawer(); } } catch { /* try again next second */ }
    const held = heldOf(c);
    if (held > s.maxLocked) s.maxLocked = held;
    const read = acts.find((a) => a.claimId === s.claimId && (a.kind === "judge" || a.kind === "source"));
    const ev = d?.evidence?.[0];
    const supply = BigInt(state.supply.total);
    const quote = ev ? esc(ev.note.replace(/^"|"$/g, "").slice(0, 160)) : "";
    const never = s.maxLocked === 0n;

    // Which step the lie has reached. It only moves forward: a price that bounces does not un-read a source.
    const reached = c.mine.state === "Debunked" ? 5 : c.price_bps < 5000 ? 4 : ev ? 3 : read ? 2 : s.maxLocked > 0n ? 1 : 0;
    s.reached = Math.max(s.reached, reached);
    if (CAPTIONS && (s.capShown ?? -1) < s.reached) {
      // When the chain is quick the story can jump several steps between two looks (evidence and the price crash in one pass). A viewer
      // should still be told every step, in order, so each skipped caption is shown for a moment before the latest one.
      const from = (s.capShown ?? -1) + 1;
      s.capShown = s.reached;
      for (let i = from; i <= s.reached; i++) {
        caption(STORY_CAPS[i], i === 5 ? "bad" : "");
        if (i < s.reached) await sleep(2300);
      }
    }

    if (c.mine.state === "Debunked") {
      // The tokens burn gradually as the average falls, so by the debunk itself little is left to burn. What the lie lost is what it ever held.
      const burned = s.maxLocked - held;
      s.narr = [
        `<b>Debunked.</b> The average fell under 30%. ${never ? "The lie never lasted long enough to mint anything, but its" : `The mine burned <b>${fmtTrue(burned.toString())} $TRUE</b> and its`} <b>2 NEAR bond</b> went into the Truth Fund, which now holds <b>${nearTxt(state.supply.fund, 2)} NEAR</b>. Nobody judged this and no oracle was asked: the price fell because a verifier was paid to correct it, and the contract only watched the average.`,
        ev ? "Now check the evidence yourself. The refutation quotes Wikipedia and pins the page's hash; your browser can fetch the same revision and compare." : "",
      ].filter(Boolean);
      s.facts = [
        ["minted by the lie", `${fmtTrue(s.maxLocked.toString())} $TRUE`], ["burned", `${fmtTrue(burned.toString())} $TRUE`],
        ["bond to the Fund", "2 NEAR"], ["your NEAR", `${nearTxt(me.near, 2)} (was ${nearTxt(s.before.near, 2)})`],
      ];
      paintStory();
      if (ev) {
        if (ev.source?.mock) { s.narr.push("(This run reads an offline test corpus, so there is nothing on Wikipedia to fetch.)"); }
        else { const v = await verify(ev); s.narr.push(esc(v.text)); s.verified = v.status === "ok"; }
      }
      s.ended = true;
      $("#playStory").disabled = false;
      paintStory();
      return;
    }

    if (reached === 4) {
      s.narr = [
        `A verifier read the source and <b>${ev?.stance === "Refute" ? "refuted" : "disagreed with"}</b> the lie, putting its own money behind a quoted passage. The price fell from ${pct(s.enter)}% to <b>${pct(c.price_bps)}%</b>. The average follows it down, and the ${fmtTrue(c.mine.locked)} $TRUE still locked will burn as it goes.`,
        quote ? `“${quote}”` : "",
      ].filter(Boolean);
      s.facts = [["price", `${pct(c.price_bps)}%`], ["average", `${pct(c.mine.ema_bps)}%`], ["still locked", `${fmtTrue(c.mine.locked)} $TRUE`]];
    } else if (reached === 3) {
      s.narr = ["Evidence is on chain: a source address, the sha256 of what was read, a verbatim quote, and a bond. The verifier is trading on it.", `“${quote}”`];
      s.facts = [["price", `${pct(c.price_bps)}%`], ["average", `${pct(c.mine.ema_bps)}%`], ["locked", `${fmtTrue(c.mine.locked)} $TRUE`]];
    } else if (reached === 2) {
      s.narr = [`<b>${esc(read.agent)}</b> is reading: ${esc(read.text.slice(0, 200))}`, ...(held > 0n ? [`Meanwhile the lie has minted ${fmtTrue(held.toString())} $TRUE.`] : [])];
      s.facts = [["price", `${pct(c.price_bps)}%`], ["average", `${pct(c.mine.ema_bps)}%`], ["locked", `${fmtTrue(c.mine.locked)} $TRUE`]];
    } else if (reached === 1) {
      s.narr = [
        `The market has held the lie for ${secs(Date.now() - s.startedAt)}. Its average is <b>${pct(c.mine.ema_bps)}%</b>, so the mine has minted <b>${fmtTrue(held.toString())} $TRUE</b> against it (cap ${fmtTrue(c.mine.cap)}). Supply is up to ${fmtTrue(supply.toString())}. These tokens are locked: they cannot be spent and will burn if belief fails.`,
        "Nobody has checked it yet. A verifier only acts on a price it can prove wrong.",
      ];
      s.facts = [["average", `${pct(c.mine.ema_bps)}%`], ["minted (locked)", `${fmtTrue(held.toString())} $TRUE`], ["supply", `${fmtTrue(supply.toString())} $TRUE`]];
    } else {
      s.facts = [["price", `${pct(c.price_bps)}%`], ["average", `${pct(c.mine.ema_bps)}%`], ["supply", `${fmtTrue(supply.toString())} $TRUE`]];
    }
    if (Date.now() - s.startedAt > 180_000) {
      s.narr.push("No verifier has finished with this claim after three minutes. If no agent is running, a false claim just stays priced high: the mechanism pays verifiers, it cannot summon them.");
      s.ended = true;
      $("#playStory").disabled = false;
    }
    paintStory();
  }
}

// ───────────────────────────── plumbing ─────────────────────────────

async function refresh() {
  state = await api("api/state");
  renderBadges();
  renderSupply();
  renderClaims();
  renderAgents();
  renderYou();
  renderFeed();
  setHTML($("#foot"), `<span>Contract <code>${esc(state.contractId)}</code> on ${esc(state.network)}. Every number on this page is read from it.</span><span>The judge is “${esc(state.judge)}”. ${state.mockCorpus ? "It reads an offline test corpus." : "Sources: " + esc(state.sources) + "."} Verifiers are assumed to exist; the mine pays them, it cannot summon them.</span>`);
  if (selected !== null) renderDrawer();
}

async function pullActivity() {
  const fresh = await api(`api/activity?since=${lastAct}`);
  if (!fresh.length) return;
  lastAct = fresh[fresh.length - 1].ts;
  acts.push(...fresh);
  if (acts.length > 400) acts.splice(0, acts.length - 400);
  for (const a of fresh) {
    if (a.kind === "debunk") toast(a.text, "dead");
    else if (a.kind === "release") toast(a.text);
    else if (a.kind === "mine") toast(a.text);
    else if (a.kind === "burn") toast(a.text, "burn");
  }
}

async function loop() {
  for (;;) {
    try {
      await refresh();
      await pullActivity();
      renderFeed();
      if (state.demo) { me = await api("api/demo/me"); renderYou(); }
    } catch (e) { setHTML($("#badges"), `<span class="badge bad">${esc(e.message)}</span>`); }
    await sleep(1500);
  }
}

document.addEventListener("click", (e) => {
  const card = e.target.closest(".claim");
  if (card && !e.target.closest("[data-claim]")) return openClaim(Number(card.dataset.id));
  const cl = e.target.closest("[data-claim]");
  if (cl) return openClaim(Number(cl.dataset.claim));
  if (e.target.closest("[data-close]") || e.target === $("#drawer")) return closeClaim();
  const v = e.target.closest("[data-verify]");
  if (v && detail) { const ev = detail.evidence.find((x) => x.id === Number(v.dataset.eid)); if (ev) void verify(ev); return; }
  const t = e.target.closest("[data-trade]");
  if (t && selected !== null) { void act("trading", () => post("api/demo/trade", { claim_id: selected, side: t.dataset.trade, near: 0.5 })).then(() => loadDetail()); return; }
  if (e.target.closest("[data-release]")) { void act("releasing", () => post("api/demo/release", { claim_id: selected })).then((r) => { if (r) toast(`Released ${fmtTrue(r.released)} $TRUE to your account.`); }); return; }
  if (e.target.closest("[data-retire]")) { void act("retiring", () => post("api/demo/retire", { claim_id: selected })).then((r) => { if (r) toast(`Retired: the bond (${nearTxt(r.stake, 1)} NEAR) is back.`); }); return; }
  if (e.target.closest("[data-story-again]")) return void playStory();
  if (e.target.closest("[data-story-stop]")) { if (story) { story.ended = true; story.narr.push("Stopped."); $("#playStory").disabled = false; paintStory(); } return; }
  if (e.target.closest("[data-story-close]")) { $("#story").hidden = true; story = null; return; }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected !== null) closeClaim(); });
$("#playStory").addEventListener("click", () => void playStory());
setInterval(() => { if (selected !== null) void loadDetail(); }, 2000);
setInterval(() => { if (state) renderClaims(); }, 1000);

// First paint waits for the first state so the forms can be built with the lie list.
(async () => {
  for (;;) {
    try { state = await api("api/state"); if (state.demo) me = await api("api/demo/me"); break; } catch { await sleep(1000); }
  }
  buildYou();
  void loop();
  if (CAPTIONS) {
    document.body.classList.add("captions");
    // A step that throws must be visible to whoever is recording, not leave them waiting.
    directedDemo().catch((e) => { document.body.dataset.error = String((e && e.message) || e); document.body.dataset.directed = "failed"; });
  }
})();

// Test hooks: the UI check reads these rather than the DOM's wording.
window.__true = { get state() { return state; }, get story() { return story; }, verify, openClaim, playStory };
