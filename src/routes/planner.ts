import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { applyOps } from "../timeline/apply.js";
import { getLatest, saveVersion, VersionConflict } from "../timeline/store.js";
import { planRemoveSilences, type AssetSilences } from "../planner/silence.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({
  minDuration: z.number().min(0.1).max(30).optional(),
  padding: z.number().min(0).max(1).optional(),
});

export default async function plannerRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/projects/:id/edit/remove-silences", async (req, reply) => {
    const { id } = req.params;
    if (!UUID.test(id)) return reply.code(400).send({ error: "invalid project id" });
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid options", details: parsed.error.issues });

    const p = await pool.query("select 1 from projects where id = $1", [id]);
    if (!p.rowCount) return reply.code(404).send({ error: "project not found" });

    const { rows } = await pool.query(
      "select id, analysis from assets where project_id = $1 and status = 'ready'",
      [id]
    );
    const assets: AssetSilences[] = rows.map((r) => ({
      id: r.id,
      duration: r.analysis.duration,
      silences: r.analysis.silences ?? [],
    }));

    const current = await getLatest(id);
    const ops = planRemoveSilences(current, assets, parsed.data);
    if (ops.length === 0) return { changed: false, ops, timeline: current };

    let next;
    try { next = applyOps(current, ops); }
    catch (e: any) { return reply.code(422).send({ error: e.message }); }

    try { await saveVersion(id, next, "remove-silences"); }
    catch (e) {
      if (e instanceof VersionConflict) return reply.code(409).send({ error: e.message });
      throw e;
    }
    const removed = ops.reduce((s, o) => s + (o.type === "ripple_delete" ? o.end - o.start : 0), 0);
    return { changed: true, removedSeconds: Math.round(removed * 1000) / 1000, ops, timeline: next };
  });
}
