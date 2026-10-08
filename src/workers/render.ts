import { Worker } from "bullmq";
import { spawn } from "node:child_process";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { connection, CHUNK_QUEUE, STITCH_QUEUE } from "../queue.js";
import { pool } from "../db.js";

const CHUNK_CONCURRENCY = Number(process.env.CHUNK_CONCURRENCY ?? 2);
const W = Number(process.env.EXPORT_WIDTH ?? 1280);
const H = Number(process.env.EXPORT_HEIGHT ?? 720);
const FPS = Number(process.env.EXPORT_FPS ?? 30);

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-400)}`))
    );
  });
}

const exists = (p: string) => access(p).then(() => true, () => false);

type ChunkJob = {
  exportId: string; idx: number; assetPath: string; hasAudio: boolean;
  srcStart: number; duration: number; outPath: string;
};

// lockDuration/stalledInterval are short on purpose: if a worker dies mid-chunk,
// BullMQ notices within seconds and hands the job to another worker.
const common = { connection, lockDuration: 10000, stalledInterval: 5000, maxStalledCount: 3 };

const chunkWorker = new Worker(
  CHUNK_QUEUE,
  async (job) => {
    const c = job.data as ChunkJob;
    await pool.query(
      "update exports set status = 'running', started_at = coalesce(started_at, now()) where id = $1 and status = 'queued'",
      [c.exportId]
    );

    // Idempotent: the final file only exists after a fully successful encode (we rename a .part file),
    // so a retried or recovered job skips work that already finished.
    if (!(await exists(c.outPath))) {
      await mkdir(path.dirname(c.outPath), { recursive: true });
      const tmp = `${c.outPath}.part`;
      const args = ["-ss", String(c.srcStart), "-t", String(c.duration), "-i", c.assetPath];
      if (!c.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
      args.push(
        "-map", "0:v:0", "-map", c.hasAudio ? "0:a:0" : "1:a:0",
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-threads", "1", // one thread per chunk, so parallelism comes from workers, not from x264
        "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
        "-t", String(c.duration), "-f", "mp4", tmp
      );
      await ffmpeg(args);
      await rename(tmp, c.outPath);
    }

    await pool.query(
      "update export_chunks set status = 'done', finished_at = now() where export_id = $1 and idx = $2",
      [c.exportId, c.idx]
    );
    return { idx: c.idx };
  },
  { ...common, concurrency: CHUNK_CONCURRENCY }
);

type StitchJob = { exportId: string; chunkPaths: string[]; finalPath: string };

const stitchWorker = new Worker(
  STITCH_QUEUE,
  async (job) => {
    const { exportId, chunkPaths, finalPath } = job.data as StitchJob;
    const listPath = path.join(path.dirname(finalPath), "list.txt");
    await writeFile(listPath, chunkPaths.map((p) => `file '${p}'`).join("\n") + "\n");
    const tmp = `${finalPath}.part`;
    // every chunk is encoded with identical settings, so the concat is a fast stream copy
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp]);
    await rename(tmp, finalPath);
    await pool.query(
      "update exports set status = 'done', output_path = $2, finished_at = now(), error = null where id = $1",
      [exportId, finalPath]
    );
    return { finalPath };
  },
  { ...common, concurrency: 1 }
);

async function markFailed(exportId: string, message: string) {
  await pool.query(
    "update exports set status = 'failed', error = $2, finished_at = now() where id = $1 and status <> 'done'",
    [exportId, message]
  );
}

chunkWorker.on("failed", async (job, err) => {
  console.error("chunk failed", job?.id, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) await markFailed(job.data.exportId, `chunk ${job.data.idx}: ${err.message}`);
});
stitchWorker.on("failed", async (job, err) => {
  console.error("stitch failed", job?.id, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) await markFailed(job.data.exportId, `stitch: ${err.message}`);
});
chunkWorker.on("error", (e) => console.error("chunk worker error", e.message));
stitchWorker.on("error", (e) => console.error("stitch worker error", e.message));

console.log(`Render workers running (chunk concurrency ${CHUNK_CONCURRENCY})`);
