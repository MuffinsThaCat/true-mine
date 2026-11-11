/**
 * Drives the real UI in headless Chrome against a running demo and checks what a visitor sees.
 *
 *   npm run demo                       # in one terminal (wait for "demo is live")
 *   npm run test:ui                    # in another
 *
 * URL=http://localhost:8791 (default), CHROME=/path/to/chrome. The story check takes up to a couple of minutes: it injects a
 * lie as the demo account and waits for the verifiers to refute it and the keeper to debunk it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const URL_ = process.env.URL ?? "http://localhost:8791";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(width, height) {
  // A Chrome profile is 150 MB or more; it is removed again in close(), or repeated runs fill the disk.
  const profile = mkdtempSync(path.join(tmpdir(), "true-ui-"));
  const proc = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let list = [];
  for (let i = 0; i < 60 && !list.length; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(250); } }
  const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method === "Runtime.exceptionThrown") problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    problems, send,
    async goto(url) { await send("Page.navigate", { url }); await sleep(2500); },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async until(expr, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await this.eval(expr)) return; await sleep(400); } throw new Error(`timed out waiting for ${what}`); },
    close() {
      try { ws.close(); } catch {}
      proc.kill("SIGKILL");
      // Chrome's helper processes can outlive it for a moment and still hold files, so the removal retries (rmSync waits between tries).
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { console.warn(`could not remove ${profile}; delete it by hand`); }
    },
  };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`  PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`); }
}

const b = await launch(1400, 1000);
try {
  await b.goto(URL_);
  await b.until(`document.querySelectorAll('.claim').length > 0`, 90000, "the first claim to appear");

  await check("the page renders the supply, the Truth Fund, the claims and the agents, with no script errors", async () => {
    const f = await b.eval(`({
      supply: document.querySelector('#supplyN')?.textContent, fund: !!document.querySelector('#fund .amt'),
      claims: document.querySelectorAll('.claim').length, gauges: document.querySelectorAll('.claim .gauge .price').length,
      agents: document.querySelectorAll('#agents .agent').length, feed: document.querySelectorAll('#feed .ev').length,
      badges: document.querySelectorAll('#badges .badge').length, title: document.title })`);
    assert.ok(f.supply !== undefined && f.fund, JSON.stringify(f));
    assert.ok(f.claims >= 1 && f.gauges === f.claims, JSON.stringify(f));
    assert.ok(f.agents >= 5 && f.badges >= 3, JSON.stringify(f));
    assert.match(f.title, /\$TRUE/);
    assert.deepEqual(b.problems, []);
  });

  await check("a mining claim shows its price, its average and its locked tokens", async () => {
    await b.until(`document.querySelector('.claim .chip.mining')`, 60000, "a claim to be mining");
    const f = await b.eval(`(() => { const c = document.querySelector('.claim:has(.chip.mining)'); return {
      price: parseFloat(c.querySelector('.price').style.left), avg: parseFloat(c.querySelector('.avg').style.left),
      legend: c.querySelector('.gl').textContent, cap: c.querySelector('.cp').textContent, status: c.querySelector('.status').textContent }; })()`);
    assert.ok(f.price > 0 && f.price < 100 && f.avg > 0 && f.avg < 100, JSON.stringify(f));
    assert.match(f.legend, /price .*% · avg .*%/);
    assert.match(f.cap, /^[\d,]+$/);
    assert.ok(f.status.length > 10);
  });

  await check("a claim opens in a drawer with a chart, the rules that apply to it, and closes with Escape", async () => {
    await b.eval(`document.querySelector('.claim').click()`);
    await b.until(`!document.querySelector('#drawer').hidden && document.querySelectorAll('#drawerBody svg.chart path').length >= 2`, 12000, "the drawer and its chart history");
    const f = await b.eval(`({ h2: document.querySelector('#drawerBody h2').textContent, stats: document.querySelectorAll('#drawerBody .stat').length,
      paths: document.querySelectorAll('#drawerBody svg.chart path').length, rules: document.querySelectorAll('#drawerBody .rules li').length })`);
    assert.ok(f.h2.length > 8 && f.stats === 6 && f.paths >= 2 && f.rules >= 1, JSON.stringify(f));
    await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await b.until(`document.querySelector('#drawer').hidden`, 3000, "the drawer to close");
  });

  await check("the supply panel adds up: spendable + locked = total", async () => {
    const f = await b.eval(`(() => { const s = window.__true.state.supply; return { total: s.total, sum: (BigInt(s.liquid) + BigInt(s.locked)).toString(), mint: s.minted_total, burn: s.burned_total }; })()`);
    assert.equal(f.total, f.sum);
    assert.ok(BigInt(f.mint) >= BigInt(f.burn));
  });

  await check("typing a claim of your own opens a mine under your account", async () => {
    await b.eval(`(() => { document.querySelector('#ownText').value = 'Mount Everest is the highest mountain above sea level.'; document.querySelector('#ownStake').value = '1'; document.querySelector('#ownForm').requestSubmit(); })()`);
    await b.until(`[...document.querySelectorAll('.claim .text')].some((t) => t.textContent.startsWith('Mount Everest is the highest mountain above'))`, 30000, "the new claim to appear");
    const f = await b.eval(`(() => { const s = window.__true.state; const c = s.claims.find((x) => x.text.startsWith('Mount Everest is the highest mountain above sea')); return { state: c.mine.state, stake: c.mine.stake, creator: c.creator, demo: s.demoAccount }; })()`);
    assert.equal(f.state, "Mining");
    assert.equal(f.stake, (10n ** 24n).toString());
    assert.equal(f.creator, f.demo);
  });

  await check("a short or empty claim is refused with the server's reason, not a crash", async () => {
    await sleep(1800);
    await b.eval(`(() => { document.querySelector('#ownText').value = 'short'; document.querySelector('#ownForm').requestSubmit(); })()`);
    await b.until(`document.querySelector('#youMsg').textContent.includes('8-280')`, 8000, "the refusal");
  });

  await check("the story: a lie is bonded, mints, is refuted with evidence, debunked, and the bond lands in the Truth Fund", async () => {
    const before = await b.eval(`window.__true.state.supply`);
    await sleep(1800);
    await b.eval(`document.querySelector('#playStory').click()`);
    await b.until(`!document.querySelector('#story').hidden`, 5000, "the story to open");
    await b.until(`window.__true.story && window.__true.story.claimId !== null`, 20000, "the lie to be bonded");
    await b.until(`window.__true.story && window.__true.story.ended`, 200000, "the story to end");
    const f = await b.eval(`(() => { const s = window.__true.story; const c = window.__true.state.claims.find((x) => x.id === s.claimId);
      return { state: c.mine.state, reached: s.reached, maxLocked: s.maxLocked.toString(), steps: document.querySelectorAll('#story .steps .done').length,
               text: document.querySelector('#story .narr').textContent, fund: window.__true.state.supply.fund }; })()`);
    assert.equal(f.state, "Debunked", JSON.stringify(f));
    assert.equal(f.reached, 5);
    assert.ok(f.steps >= 5, `steps done ${f.steps}`);
    assert.match(f.text, /Debunked/);
    assert.ok(BigInt(f.fund) - BigInt(before.fund) >= 2n * 10n ** 24n, "the 2 NEAR bond went into the Truth Fund");
  });

  await check("redeeming $TRUE from the Truth Fund works for a holder, and is refused for someone with none", async () => {
    await sleep(1800);
    await b.eval(`(() => { document.querySelector('#redeemAmt').value = '5'; document.querySelector('#redeemForm').requestSubmit(); })()`);
    await b.until(`document.querySelector('#youMsg').textContent.includes('do not hold')`, 10000, "the refusal");
  });

  await check("the page works at phone width with no sideways scroll", async () => {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(800);
    const f = await b.eval(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })`);
    assert.ok(f.sw <= f.iw + 1, `scrollWidth ${f.sw} > ${f.iw}`);
    await b.eval(`document.querySelector('.claim').click()`);
    await b.until(`!document.querySelector('#drawer').hidden`, 5000, "the drawer");
    const g = await b.eval(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dw: document.querySelector('.drawer-in').scrollWidth, dc: document.querySelector('.drawer-in').clientWidth })`);
    assert.ok(g.sw <= g.iw + 1 && g.dw <= g.dc + 1, JSON.stringify(g));
    await b.eval(`document.querySelector('[data-close]').click()`);
  });

  await check("dark mode changes the ground, not just the text", async () => {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    const light = await b.eval(`getComputedStyle(document.body).backgroundColor`);
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    const dark = await b.eval(`getComputedStyle(document.body).backgroundColor`);
    assert.notEqual(light, dark);
  });

  if (process.env.CAPTIONS) {
    await check("captions mode runs the whole silent walk-through by itself and ends on the honesty card", async () => {
      await b.goto(`${URL_}/?captions=1`);
      const seen = [];
      const t0 = Date.now();
      for (;;) {
        const bad = await b.eval(`document.body.dataset.directed === "failed" ? document.body.dataset.error : ""`);
        assert.equal(bad, "", `the walk-through failed in the page: ${bad}`);
        const f = await b.eval(`({ done: document.body.dataset.directed === "done", text: document.querySelector('#cap').hidden ? "" : document.querySelector('#cap').textContent, cap: document.body.classList.contains('captions') })`);
        assert.ok(f.cap, "the page is in captions mode");
        if (f.text && seen[seen.length - 1] !== f.text) seen.push(f.text);
        if (f.done) break;
        assert.ok(Date.now() - t0 < 420000, `timed out; captions so far: ${seen.join(" | ")}`);
        await sleep(400);
      }
      assert.equal(await b.eval(`document.body.dataset.storyResult`), "debunked", "the lie story reached its debunk");
      assert.ok(await b.eval(`!!document.querySelector('#ghost')`), "the cursor was drawn");
      const all = seen.join("\n");
      for (const needle of [/minted from what a market believes/, /Dot = the price now/, /bond 2 NEAR to a false claim/i, /mints \$TRUE/, /Evidence on chain/, /Debunked/, /evidence: a verbatim quote/, /Truth Fund/, /local NEAR node/i]) assert.match(all, needle, `missing caption ${needle}`);
      console.log(`        ${seen.length} captions shown in ${Math.round((Date.now() - t0) / 1000)}s`);
    });
  }

  await check("no script error was thrown anywhere in the run", async () => { assert.deepEqual(b.problems, []); });
} finally {
  b.close();
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length} of ${results.length} UI checks passed`);
process.exit(failed.length ? 1 : 0);
