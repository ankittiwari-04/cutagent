# CutAgent

Backend for an AI-assisted video editor: upload footage, analyze it with FFmpeg, edit a versioned timeline through validated operations, and export it with a parallel, restart-safe render pipeline.

**Demo video (about 1 minute):** https://youtu.be/yuDgP8hf36w

> **Status:** working backend prototype. There is no UI and no LLM yet. Edits come from a rule-based planner that emits the same typed operations an LLM agent would; that operation layer is the integration point for one. See [Limitations](#limitations).

## What it does

1. **Upload** a video (streamed to disk, never buffered in memory). The API returns immediately and queues analysis.
2. **Analyze** it in a worker: `ffprobe` metadata, silence ranges (`silencedetect`) and scene cuts. Results are stored as JSON in Postgres.
3. **Edit** a timeline through typed, Zod-validated operations: `add_clip`, `trim_clip`, `split_clip`, `delete_clip`, `move_clip`, `set_volume`, `ripple_delete`. Every edit creates a new timeline version; undo drops the newest one.
4. **Plan edits**: `remove-silences` reads the stored analysis and emits `ripple_delete` operations (no LLM involved).
5. **Export** the timeline: it is cut into chunks, rendered in parallel by workers, then stitched. Progress is tracked per chunk, and a crashed worker does not lose finished work.

## Architecture

```mermaid
flowchart LR
  C["Client"] -->|"multipart upload"| API["Fastify API"]
  API --> FS[("Disk")]
  API -->|"asset row + job"| QA[["analysis queue"]]
  QA --> AW["Analysis worker<br/>ffprobe, silencedetect, scene cuts"]
  AW --> PG[("Postgres")]
  C -->|"typed ops"| API
  API -->|"applyOps + new version"| PG
  C -->|"POST /exports"| API
  API -->|"BullMQ flow"| QC[["render-chunk queue"]]
  QC --> RW["Render workers x N<br/>one ffmpeg per chunk"]
  RW --> FS
  RW -->|"all chunks done"| QS[["render-stitch queue"]]
  QS --> SW["Stitch worker<br/>concat, stream copy"]
  SW --> FS
  RW -->|"chunk rows"| PG
  SW -->|"export status"| PG
```

Stack: TypeScript, Fastify, BullMQ + Redis, Postgres, FFmpeg.

## Benchmark

Parallel export of a 2-minute video, cut into 24 chunks of 5 seconds. Each chunk is encoded by its own FFmpeg process pinned to one encoder thread (`-threads 1`), so the only variable is how many chunks run at once.

| chunk workers | wall time (s) | speedup |
|---|---|---|
| 1 | 35.0 | 1.00x |
| 2 | 23.1 | 1.51x |
| 4 | 18.4 | 1.90x |

- Source: synthetic 1280x720, 30 fps test pattern (`testsrc2`) with a sine tone. Real footage will behave differently.
- Hardware: 12 logical CPUs, Ubuntu on WSL2, everything on one machine.
- Output: H.264 (`veryfast`, CRF 23) at 1280x720, 30 fps, AAC stereo.
- Scaling is sublinear. Likely contributors are the sequential stitch step, per-chunk seek and decode overhead, and shared CPU and disk on one machine. I have not profiled this yet.

Reproduce:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -t 120 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac bench.mp4
npm run worker        # analysis worker, in another terminal
npm run api           # API, in another terminal
npm run bench -- bench.mp4
```

## Crash recovery

The render workers use short BullMQ lock and stalled-job intervals, so a job whose worker died is re-queued within roughly 15 seconds. Chunk jobs are idempotent: each one writes to a `.part` file and atomically renames it only after FFmpeg succeeds, and a retried job skips any chunk whose final file already exists.

`npm run recovery-demo -- bench.mp4` shows this end to end. It starts an export, hard-kills the render worker and its FFmpeg children after a third of the chunks are done, starts a fresh worker, and checks that the export completes, that finished chunks were not re-encoded, and that the output duration matches the source.
Measured run on the benchmark video (24 chunks): the worker was killed with 8 of 24 chunks done; the export finished 14.3 s later, all 8 finished chunks were reused without re-encoding, the other 16 were rendered by the new worker, and the output duration was 120.02 s against a 120 s source.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects` | Create a project `{name}` |
| POST | `/projects/:id/assets` | Upload a video (multipart field `file`); queues analysis |
| GET | `/projects/:id/assets` | List assets and their status |
| GET | `/assets/:id` | Asset status and analysis JSON |
| GET | `/projects/:id/timeline` | Latest timeline version |
| POST | `/projects/:id/timeline/ops` | Apply operations `{ops, baseVersion?}` |
| POST | `/projects/:id/timeline/undo` | Drop the newest version |
| POST | `/projects/:id/edit/remove-silences` | Rule-based planner `{minDuration?, padding?}` |
| POST | `/projects/:id/exports` | Start an export `{chunkSeconds?}` |
| GET | `/exports/:id` | Status and progress (`done_chunks / total_chunks`) |
| GET | `/exports/:id/download` | Download the finished MP4 |

## Design decisions

- **Timeline edits are a pure function.** `applyOps(timeline, ops)` returns a new timeline or throws and never mutates its input, so a failing batch cannot leave a half-applied timeline. It is covered by unit tests.
- **Versioned timelines are the concurrency control.** Each edit inserts a row keyed `(project_id, version)`. Two edits from the same base version collide on the primary key and the loser gets a `409`. Undo is deleting the newest row.
- **Typed operations as the contract.** Anything that edits a timeline, today a rule-based planner and later possibly an LLM, goes through the same Zod-validated operations, so validation, versioning and undo are shared.
- **Fan-out and join with a BullMQ flow.** Chunk jobs are children of a stitch job. `failParentOnFailure` stops the stitch if any chunk exhausts its retries, and the export is marked `failed` with the reason.
- **Progress is derived from rows, not counters.** One `export_chunks` row per chunk, and progress counts the `done` rows, so a retried chunk can never be double counted.
- **Uploads stream to disk.** Large files never sit in memory, and the API stays responsive while workers do the heavy lifting.
- **Analysis output is sanitized before use.** FFmpeg can report a silence ending slightly past the real duration (codec padding), so ranges are clamped to the media duration.

## Failure handling

| Failure | Behavior |
|---|---|
| Invalid or out-of-range operation | `422`, nothing is saved |
| Stale `baseVersion` | `409` with the current version |
| Two concurrent edits | One wins, the other gets `409` |
| Worker crashes mid-chunk | Stalled job is re-queued; finished chunk files are skipped |
| Chunk fails after 3 attempts | Export marked `failed` with the reason; stitch never runs |
| Analysis fails | Asset marked `failed` with the error after retries |
| Timeline references an unknown asset | Export rejected with `422` |

## Limitations

- No LLM agent yet. The planner is rule-based (silence removal only).
- Export renders the first video track as a back-to-back sequence of clips. Gaps are closed, and there is no compositing, no audio mixing and no volume or transitions yet.
- Fixed output format (1280x720, 30 fps).
- Exporting 4K 60 fps HEVC phone footage directly is slow: a 13 s edit of a 19 s clip took 103 s with 4 workers (12 chunks), because every chunk job decodes the 4K source. I have not profiled it yet. Proxy generation and keyframe-aligned seeking are on the roadmap.
- Local disk instead of object storage, and no authentication.
- No frontend.
- Tests cover the pure logic (timeline operations, planners, export planning). The queue, database and FFmpeg paths are exercised by the benchmark and recovery scripts rather than automated integration tests.
- Not deployed.

## Run locally

Requirements: Node 20+, FFmpeg, Redis on `localhost:6379`, Postgres.

```bash
git clone https://github.com/ankittiwari-04/cutagent && cd cutagent
npm install

createdb cutagent        # or: sudo -u postgres createdb cutagent
export DATABASE_URL=postgresql://postgres:dev@localhost:5432/cutagent   # this is also the default
psql "$DATABASE_URL" -f db/schema.sql

npm run worker           # analysis worker
npm run render-worker    # render workers (CHUNK_CONCURRENCY=4 to run 4 chunks at once)
npm run api              # http://localhost:3000
```

Quick tour:

```bash
P=$(curl -s -X POST localhost:3000/projects -H 'content-type: application/json' -d '{"name":"demo"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')
A=$(curl -s -F "file=@sample.mp4" localhost:3000/projects/$P/assets \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).assetId')

# once /assets/$A reports "ready", put the whole clip on the timeline (use your video's duration for "out")
curl -s -X POST localhost:3000/projects/$P/timeline/ops -H 'content-type: application/json' \
  -d "{\"ops\":[{\"type\":\"add_clip\",\"trackId\":\"V1\",\"assetId\":\"$A\",\"start\":0,\"in\":0,\"out\":5}]}"

curl -s -X POST localhost:3000/projects/$P/edit/remove-silences -H 'content-type: application/json' -d '{}'

E=$(curl -s -X POST localhost:3000/projects/$P/exports -H 'content-type: application/json' -d '{"chunkSeconds":2}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).exportId')
curl -s localhost:3000/exports/$E
curl -s localhost:3000/exports/$E/download -o out.mp4
```

Tests: `npm test`

## Roadmap

- LLM agent that emits the same typed operations (with a validation and self-repair loop)
- Object storage instead of local disk
- Live progress over SSE
- Multi-track rendering and audio mixing
- Proxy transcodes for preview and keyframe-aligned chunk seeking (faster export of high-resolution footage)
- Dockerfile and docker-compose for one-command setup
