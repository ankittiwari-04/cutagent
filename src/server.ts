import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "./db.js";
import { analysisQueue } from "./queue.js";

const UPLOAD_DIR = path.resolve("uploads");
await mkdir(UPLOAD_DIR, { recursive: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = Fastify({ logger: true });
await app.register(multipart, { limits: { fileSize: 5 * 1024 ** 3 } });

app.post<{ Body: { name?: string } }>("/projects", async (req, reply) => {
  const name = req.body?.name?.trim();
  if (!name) return reply.code(400).send({ error: "name is required" });
  const { rows } = await pool.query(
    "insert into projects (name) values ($1) returning id, name, created_at",
    [name]
  );
  return reply.code(201).send(rows[0]);
});

app.post<{ Params: { id: string } }>("/projects/:id/assets", async (req, reply) => {
  const { id: projectId } = req.params;
  if (!UUID.test(projectId)) return reply.code(400).send({ error: "invalid project id" });

  const project = await pool.query("select 1 from projects where id = $1", [projectId]);
  if (!project.rowCount) return reply.code(404).send({ error: "project not found" });

  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "no file uploaded" });

  const ext = path.extname(file.filename) || ".mp4";
  const filePath = path.join(UPLOAD_DIR, `${randomUUID()}${ext}`);
  await pipeline(file.file, createWriteStream(filePath)); // stream to disk, never buffer in memory

  if (file.file.truncated) return reply.code(413).send({ error: "file too large" });

  const { rows } = await pool.query(
    "insert into assets (project_id, path) values ($1, $2) returning id, status",
    [projectId, filePath]
  );
  const assetId = rows[0].id;

  await analysisQueue.add("analyze", { assetId }, {
    jobId: assetId,
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });

  return reply.code(202).send({ assetId, status: rows[0].status });
});

app.get<{ Params: { id: string } }>("/assets/:id", async (req, reply) => {
  if (!UUID.test(req.params.id)) return reply.code(400).send({ error: "invalid asset id" });
  const { rows } = await pool.query(
    "select id, project_id, status, analysis, error, created_at from assets where id = $1",
    [req.params.id]
  );
  if (!rows[0]) return reply.code(404).send({ error: "asset not found" });
  return rows[0];
});

app.get<{ Params: { id: string } }>("/projects/:id/assets", async (req, reply) => {
  if (!UUID.test(req.params.id)) return reply.code(400).send({ error: "invalid project id" });
  const { rows } = await pool.query(
    "select id, status, error, created_at from assets where project_id = $1 order by created_at",
    [req.params.id]
  );
  return rows;
});

await app.listen({ port: 3000, host: "0.0.0.0" });
