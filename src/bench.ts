import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = process.env.API ?? "http://localhost:3000";
const file = process.argv[2];
if (!file) { console.error("usage: npm run bench -- <video>"); process.exit(1); }
const chunkSeconds = Number(process.env.CHUNK_SECONDS ?? 5);
const levels = (process.env.LEVELS ?? "1,2,4").split(",").map(Number);
const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(p: string, init?: RequestInit): Promise<any> {
  const res = await fetch(API + p, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const project = await api("/projects", { method: "POST", headers: json, body: JSON.stringify({ name: "bench" }) });

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

const rows: { n: number; sec: number; chunks: number }[] = [];
for (const n of levels) {
  const worker = spawn("node", ["--import", "tsx", "src/workers/render.ts"], {
    env: { ...process.env, CHUNK_CONCURRENCY: String(n) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await sleep(3000); // let the worker connect

  const t0 = Date.now();
  const ex = await api(`/projects/${project.id}/exports`, {
    method: "POST", headers: json, body: JSON.stringify({ chunkSeconds }),
  });
  let st: any;
  for (;;) {
    st = await api(`/exports/${ex.exportId}`);
    if (st.status === "done" || st.status === "failed") break;
    await sleep(250);
  }
  const sec = (Date.now() - t0) / 1000;
  worker.kill("SIGKILL");
  await sleep(500);
  if (st.status === "failed") throw new Error(`export failed: ${st.error}`);

  rows.push({ n, sec, chunks: ex.chunks });
  console.log(`workers=${n}: ${sec.toFixed(1)}s (${ex.chunks} chunks) -> ${st.output_path}`);
}

console.log(`\nMachine: ${os.cpus().length} logical CPUs, source: ${path.basename(file)} (${asset.analysis.duration}s), chunk size ${chunkSeconds}s\n`);
console.log("| chunk workers | wall time (s) | speedup |\n|---|---|---|");
for (const r of rows) console.log(`| ${r.n} | ${r.sec.toFixed(1)} | ${(rows[0].sec / r.sec).toFixed(2)}x |`);
process.exit(0);
