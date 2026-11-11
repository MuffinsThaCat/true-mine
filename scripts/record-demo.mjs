/**
 * Makes the demo video by itself.
 *
 *   npm run build && npm run record          # writes demo-video/true-demo.mp4
 *
 * It starts a fresh local demo (a real NEAR node, the real contract, the agents), waits until some mines have matured, opens the page in
 * headless Chrome with ?captions=1, which runs the whole silent walk-through (captions, a visible cursor that clicks real buttons, the
 * lie story, the evidence check), captures the frames, and has ffmpeg encode them. Nothing is clicked by hand.
 *
 * Env: OUT (output file), URL (use a demo that is already running instead of starting one), THEME=light|dark (default light),
 * CHROME (path to Chrome), W/H (viewport, default 1600x1000). Needs ffmpeg on PATH and Chrome.
 * The "verified in your browser" step fetches Wikipedia from the browser, so it needs internet; offline it says so on screen.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT ?? path.join(ROOT, "demo-video/true-demo.mp4");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = Number(process.env.W ?? 1600);
const H = Number(process.env.H ?? 1000);
const THEME = process.env.THEME === "dark" ? "dark" : "light";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[record] ${m}`);

let demo = null;
let chrome = null;
let writeErr = null;
const frames = path.join(mkdtempSync(path.join(tmpdir(), "true-rec-")), "frames");
mkdirSync(frames, { recursive: true });
// A Chrome profile is 150 MB or more and the frames are hundreds of MB: both are removed at the end, on success or failure.
const chromeProfile = mkdtempSync(path.join(tmpdir(), "true-rec-chrome-"));
const cleanup = async () => {
  try { chrome?.kill("SIGKILL"); } catch { /* already gone */ }
  await sleep(500);
  try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { console.warn(`[record] could not remove ${chromeProfile}; delete it by hand`); }
  if (demo) { try { process.kill(-demo.pid, "SIGTERM"); } catch { try { demo.kill("SIGTERM"); } catch { /* gone */ } } await sleep(1500); }
};
// Ctrl+C or a plain kill must not leave the demo, its node or Chrome running.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanup(); rmSync(path.dirname(frames), { recursive: true, force: true }); process.exit(130); });

try {
  // The frames are a few hundred MB and Chrome's profile 150 MB or more; a full disk once crashed a run and left both behind.
  let free = null;
  try { const s = statfsSync(tmpdir()); free = Number(s.bavail) * Number(s.bsize); } catch { /* cannot tell; carry on */ }
  if (free !== null && free < 2e9) throw new Error(`only ${(free / 1e9).toFixed(1)} GB free in ${tmpdir()}; the recording needs about 2 GB (frames and a Chrome profile)`);
  let base = process.env.URL;
  if (!base) {
    const port = Number(process.env.PORT ?? 8799);
    base = `http://localhost:${port}`;
    log(`starting a fresh demo on :${port} (this takes about a minute and a half to mature)`);
    const logFile = createWriteStream(path.join(tmpdir(), "true-record-demo.log"));
    demo = spawn("node", ["dist/scripts/demo.js", "--offline"], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    demo.stdout.pipe(logFile); demo.stderr.pipe(logFile);
  }
  const state = async () => { try { return await (await fetch(`${base}/api/state`)).json(); } catch { return null; } };
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    const mining = s?.claims?.filter((c) => c.mine.state === "Mining").length ?? 0;
    const released = s?.claims?.filter((c) => c.mine.released !== "0").length ?? 0;
    if (s?.ok && mining >= 6 && released >= 1) break;
    if (Date.now() - t0 > 300_000) throw new Error(`the demo did not mature in 5 minutes (mining ${mining}, released ${released})`);
    await sleep(2000);
  }
  log(`demo is ready after ${Math.round((Date.now() - t0) / 1000)}s`);

  // Chrome over the DevTools protocol.
  const port = 9500 + Math.floor(Math.random() * 400);
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${chromeProfile}`,
    "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
  let list = [];
  for (let i = 0; i < 60 && !list.length; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(250); } }
  const target = list.find((t) => t.type === "page");
  if (!target) throw new Error("Chrome did not start (is CHROME set to a Chrome binary?)");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const shots = [];
  let n = 0;
  // A call that Chrome never answers (it crashed, say) must fail the run, not hang it.
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`Chrome did not answer ${method} within 30 s`)); }, 30_000);
    pending.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.addEventListener("close", () => { for (const p of pending.values()) p.rej(new Error("Chrome closed the connection")); pending.clear(); });
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method === "Page.screencastFrame") {
      try {
        const file = path.join(frames, `f${String(++n).padStart(6, "0")}.jpg`);
        writeFileSync(file, Buffer.from(msg.params.data, "base64"));
        shots.push({ file, ts: msg.params.metadata.timestamp });
      } catch (e) { writeErr = e; } // a full disk must fail the run cleanly, not crash the process with the folders left behind
      send("Page.screencastFrameAck", { sessionId: msg.params.sessionId }).catch(() => {});
    }
  });
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: THEME }] });

  log(`recording (${W}x${H}, ${THEME})`);
  await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await send("Page.navigate", { url: `${base}/?captions=1` });
  const start = Date.now();
  for (;;) {
    const st = await evaluate(`document.body ? { d: document.body.dataset.directed || "", e: document.body.dataset.error || "" } : { d: "", e: "" }`);
    if (writeErr) throw new Error(`could not write a frame (${writeErr.code ?? writeErr.message}); is the disk full?`);
    if (st.d === "failed") throw new Error(`the walk-through failed in the page: ${st.e}`);
    if (st.d === "done") break;
    if (Date.now() - start > 480_000) throw new Error("the walk-through did not finish in 8 minutes");
    await sleep(500);
  }
  await sleep(1500);
  await send("Page.stopScreencast");
  // A video of a story that never reached its debunk is not the demo; do not write one and call it done.
  const result = await evaluate(`document.body.dataset.storyResult || ""`);
  if (result !== "debunked") throw new Error(`the lie story did not reach its debunk (${result || "no result"}); not writing a video`);
  log(`captured ${shots.length} frames over ${Math.round((Date.now() - start) / 1000)}s`);

  // Frames arrive only when the page changes, so each one lasts until the next arrives.
  const lines = [];
  shots.forEach((s, i) => {
    const dur = i + 1 < shots.length ? Math.max(1 / 60, shots[i + 1].ts - s.ts) : 1.5;
    lines.push(`file '${s.file}'`, `duration ${dur.toFixed(4)}`);
  });
  lines.push(`file '${shots[shots.length - 1].file}'`);
  const listFile = path.join(frames, "list.txt");
  writeFileSync(listFile, lines.join("\n"));
  mkdirSync(path.dirname(OUT), { recursive: true });
  // Encoded to a side file and renamed only when it succeeded, so a failed run never truncates a good video that is already there.
  const partial = `${OUT}.partial.mp4`;
  const enc = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=30,scale=${W}:-2:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", partial], { stdio: "inherit" });
  if (enc.status !== 0) { rmSync(partial, { force: true }); throw new Error("ffmpeg failed; the previous video, if any, was left as it was"); }
  renameSync(partial, OUT);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", OUT]).stdout?.toString().trim();
  log(`wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB, ${Number(probe).toFixed(0)}s)`);
} catch (e) {
  console.error(`[record] FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  rmSync(path.dirname(frames), { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
