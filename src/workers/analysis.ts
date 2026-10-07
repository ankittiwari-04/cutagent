import { Worker } from "bullmq";
import { connection } from "../queue.js";
import { pool } from "../db.js";
import { analyze } from "../analysis/analyze.js";

const worker = new Worker(
  "analysis",
  async (job) => {
    const { assetId } = job.data as { assetId: string };

    const { rows } = await pool.query("select path from assets where id = $1", [assetId]);
    if (!rows[0]) throw new Error(`Asset not found: ${assetId}`);

    await pool.query("update assets set status = 'analyzing' where id = $1", [assetId]);
    const result = await analyze(rows[0].path);

    await pool.query(
      "update assets set status = 'ready', analysis = $2, error = null where id = $1",
      [assetId, JSON.stringify(result)]
    );
    return { silences: result.silences.length, scenes: result.sceneCuts.length };
  },
  { connection, concurrency: 2 }
);

worker.on("failed", async (job, err) => {
  console.error("analysis failed", job?.id, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await pool.query("update assets set status = 'failed', error = $2 where id = $1", [
      job.data.assetId,
      err.message,
    ]);
  }
});

console.log("Analysis worker running...");
