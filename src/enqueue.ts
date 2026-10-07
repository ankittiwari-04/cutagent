import path from "node:path";
import { pool } from "./db.js";
import { analysisQueue } from "./queue.js";

const file = process.argv[2];
if (!file) { console.error("usage: npm run enqueue -- <video>"); process.exit(1); }
const abs = path.resolve(file);

const project = await pool.query("insert into projects (name) values ($1) returning id", ["test project"]);
const asset = await pool.query(
  "insert into assets (project_id, path) values ($1, $2) returning id",
  [project.rows[0].id, abs]
);
const assetId = asset.rows[0].id;

await analysisQueue.add("analyze", { assetId }, {
  jobId: assetId,
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
});

console.log("queued asset", assetId);
await analysisQueue.close();
await pool.end();
process.exit(0);
