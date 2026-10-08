import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db.js";
import { OpSchema } from "../timeline/schema.js";
import { applyOps } from "../timeline/apply.js";
import { getLatest, saveVersion, undoLatest, VersionConflict } from "../timeline/store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({ ops: z.array(OpSchema).min(1), baseVersion: z.number().int().min(0).optional() });

export default async function timelineRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const id = (req.params as any)?.id;
    if (!UUID.test(id)) return reply.code(400).send({ error: "invalid project id" });
    const p = await pool.query("select 1 from projects where id = $1", [id]);
    if (!p.rowCount) return reply.code(404).send({ error: "project not found" });
  });

  app.get<{ Params: { id: string } }>("/projects/:id/timeline", async (req) => getLatest(req.params.id));

  app.post<{ Params: { id: string } }>("/projects/:id/timeline/ops", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid ops", details: parsed.error.issues });

    const current = await getLatest(req.params.id);
    if (parsed.data.baseVersion !== undefined && parsed.data.baseVersion !== current.version)
      return reply.code(409).send({ error: "stale baseVersion", currentVersion: current.version });

    let next;
    try { next = applyOps(current, parsed.data.ops); }
    catch (e: any) { return reply.code(422).send({ error: e.message }); }

    try { await saveVersion(req.params.id, next); }
    catch (e) {
      if (e instanceof VersionConflict) return reply.code(409).send({ error: e.message });
      throw e;
    }
    return next;
  });

  app.post<{ Params: { id: string } }>("/projects/:id/timeline/undo", async (req, reply) => {
    const t = await undoLatest(req.params.id);
    if (!t) return reply.code(409).send({ error: "nothing to undo" });
    return t;
  });
}
