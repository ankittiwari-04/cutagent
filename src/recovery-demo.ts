import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const API = process.env.API ?? "http://localhost:3000";
const file = process.argv[2];
if (!file) { console.error("usage: npm run recovery-demo -- <video>"); process.exit(1); }
const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(p: string, init?: RequestInit): Promise<any> {
  const res = await fetch(API + p, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

function startWorker(concurrency: number): ChildProcess {
  return spawn("node", ["--import", "tsx", "src/workers/render.ts"], {
    env: { ...process.env, CHUNK_CONCURRENCY: String(concurrency) },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true, // own process group: we can kill the worker AND its ffmpeg children at once
  });
}
const killGroup = (w: ChildProcess) => { try { process.kill(-w.pid!, "SIGKILL"); } catch {} };

// setup: project, upload, wait for analysis, one clip on the timeline
const project = await api("/projects", { method: "POST", headers: json, body: JSON.stringify({ name: "recovery-demo" }) });
const form = new FormData();
form.append("file", new Blob([await readFile(file)]), path.basename(file));
const up = await api(`/projects/${project.id}/assets`, { method: "POST", body: form });

let asset: any;
const deadline = Date.now() + 120_000;
for (;;) {
  asset = await api(`/assets/${up.assetId}`);
  if (asset.status === "ready") break;
  if (asset.status === "failed") throw new Error(`analysis failed: ${asset.error}`);
  if (Date.now() > deadline) throw new Error("asset never became ready: is the analysis worker running?");
  await sleep(500);
}
await api(`/projects/${project.id}/timeline/ops`, {
  method: "POST", headers: json,
  body: JSON.stringify({ ops: [{ type: "add_clip", trackId: "V1", assetId: up.assetId, start: 0, in: 0, out: asset.analysis.duration }] }),
});

// 1. start an export on a slow worker and crash it a third of the way through
const worker1 = startWorker(2);
await sleep(3000);
const ex = await api(`/projects/${project.id}/exports`, { method: "POST", headers: json, body: JSON.stringify({ chunkSeconds: 5 }) });
const dir = path.resolve("outputs", "exports", ex.exportId);

let st: any;
for (;;) {
  st = await api(`/exports/${ex.exportId}`);
  if (st.status === "failed") throw new Error(`export failed early: ${st.error}`);
  if (st.done_chunks >= Math.floor(ex.chunks / 3)) break;
  await sleep(100);
}
killGroup(worker1);
const killedAt = Date.now();
console.log(`CRASH: killed the render worker with ${st.done_chunks}/${ex.chunks} chunks done`);
await sleep(500);

const finalChunk = /^chunk_\d{4}\.mp4$/;
const before = new Map<string, number>();
for (const f of await readdir(dir)) if (finalChunk.test(f)) before.set(f, (await stat(path.join(dir, f))).mtimeMs);
console.log(`${before.size} finished chunk files on disk at crash time`);

// 2. start a fresh worker: BullMQ must notice the dead worker's jobs and re-queue them
const worker2 = startWorker(4);
for (;;) {
  st = await api(`/exports/${ex.exportId}`);
  if (st.status === "done" || st.status === "failed") break;
  if (Date.now() - killedAt > 180_000) throw new Error("timed out waiting for recovery");
  await sleep(250);
}
const recoverySec = (Date.now() - killedAt) / 1000;
killGroup(worker2);

// 3. verify
let rerendered = 0;
for (const [f, m] of before) if ((await stat(path.join(dir, f))).mtimeMs !== m) rerendered++;
let duration = NaN;
if (st.status === "done") {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", st.output_path]);
  duration = parseFloat(stdout.trim());
}
const drift = Math.abs(duration - asset.analysis.duration);
const ok = st.status === "done" && rerendered === 0 && drift < 1;

console.log(`\nexport status:            ${st.status}`);
console.log(`time from crash to done:  ${recoverySec.toFixed(1)}s`);
console.log(`chunks reused after crash: ${before.size - rerendered}/${before.size} (re-encoded: ${rerendered})`);
console.log(`chunks rendered after crash: ${ex.chunks - before.size}`);
console.log(`output duration:          ${duration.toFixed(2)}s vs source ${asset.analysis.duration}s (drift ${drift.toFixed(2)}s)`);
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
