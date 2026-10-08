import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { flowProducer, CHUNK_QUEUE, STITCH_QUEUE } from "../queue.js";
import { getLatest } from "../timeline/store.js";
import { planSegments } from "../export/plan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({ chunkSeconds: z.number().min(1).max(60).default(10) });

export default async function exportRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/projects/:id/exports", async (req, reply) => {
    const { id } = req.params;
    if (!UUID.test(id)) return reply.code(400).send({ error: "invalid project id" });
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid options", details: parsed.error.issues });

    const p = await pool.query("select 1 from projects where id = $1", [id]);
    if (!p.rowCount) return reply.code(404).send({ error: "project not found" });

    const timeline = await getLatest(id);
    const segments = planSegments(timeline, parsed.data.chunkSeconds);
    if (segments.length === 0) return reply.code(409).send({ error: "timeline has no video clips to render" });

    const assetIds = [...new Set(segments.map((s) => s.assetId))];
    if (!assetIds.every((a) => UUID.test(a))) return reply.code(422).send({ error: "timeline references an unknown asset" });
    const { rows } = await pool.query(
      "select id, path, analysis from assets where id = any($1::uuid[]) and project_id = $2",
      [assetIds, id]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (assetIds.some((a) => !byId.has(a))) return reply.code(422).send({ error: "timeline references an unknown asset" });

    const exportId = randomUUID();
    const dir = path.resolve("outputs", "exports", exportId);
    const finalPath = path.join(dir, "final.mp4");
    const chunks = segments.map((s, idx) => {
      const asset = byId.get(s.assetId)!;
      return {
        exportId, idx,
        assetPath: asset.path as string,
        hasAudio: Boolean(asset.analysis?.audio),
        srcStart: s.srcStart,
        duration: s.duration,
        outPath: path.join(dir, `chunk_${String(idx).padStart(4, "0")}.mp4`),
      };
    });

    // rows first, so workers always find them
    await pool.query(
      "insert into exports (id, project_id, timeline_version, total_chunks) values ($1, $2, $3, $4)",
      [exportId, id, timeline.version, chunks.length]
    );
    await pool.query(
      "insert into export_chunks (export_id, idx) select $1::uuid, g from generate_series(0, $2::int - 1) g",
      [exportId, chunks.length]
    );

    try {
      // fan-out: N chunk jobs run in parallel; the stitch job only runs once every child succeeded
      await flowProducer.add({
        name: "stitch",
        queueName: STITCH_QUEUE,
        data: { exportId, chunkPaths: chunks.map((c) => c.outPath), finalPath },
        opts: { jobId: `${exportId}-stitch`, attempts: 2 },
        children: chunks.map((c) => ({
          name: "chunk",
          queueName: CHUNK_QUEUE,
          data: c,
          opts: {
            jobId: `${exportId}-chunk-${c.idx}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 1000 },
            failParentOnFailure: true,
          },
        })),
      });
    } catch (e: any) {
      await pool.query("update exports set status = 'failed', error = $2 where id = $1", [exportId, e.message]);
      throw e;
    }

    return reply.code(202).send({ exportId, timelineVersion: timeline.version, chunks: chunks.length });
  });

  app.get<{ Params: { id: string } }>("/exports/:id", async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: "invalid export id" });
    const { rows } = await pool.query(
      `select e.id, e.project_id, e.timeline_version, e.status, e.total_chunks, e.output_path, e.error,
              e.created_at, e.started_at, e.finished_at,
              (select count(*)::int from export_chunks c where c.export_id = e.id and c.status = 'done') as done_chunks
         from exports e where e.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return reply.code(404).send({ error: "export not found" });
    const r = rows[0];
    return {
      ...r,
      progress: r.total_chunks ? Math.round((100 * r.done_chunks) / r.total_chunks) : 0,
      elapsedSeconds: r.finished_at ? (new Date(r.finished_at).getTime() - new Date(r.created_at).getTime()) / 1000 : null,
    };
  });

  app.get<{ Params: { id: string } }>("/exports/:id/download", async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(400).send({ error: "invalid export id" });
    const { rows } = await pool.query("select status, output_path from exports where id = $1", [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "export not found" });
    if (rows[0].status !== "done") return reply.code(409).send({ error: `export is ${rows[0].status}` });
    return reply.header("content-type", "video/mp4").send(createReadStream(rows[0].output_path));
  });
}
