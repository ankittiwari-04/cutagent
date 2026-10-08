import { pool } from "../db.js";
import type { Timeline } from "./schema.js";

export const emptyTimeline = (): Timeline => ({
  version: 0,
  tracks: [
    { id: "V1", kind: "video", clips: [] },
    { id: "A1", kind: "audio", clips: [] },
  ],
});

export class VersionConflict extends Error {}

export async function getLatest(projectId: string): Promise<Timeline> {
  const { rows } = await pool.query(
    "select data from timelines where project_id = $1 order by version desc limit 1",
    [projectId]
  );
  return rows[0]?.data ?? emptyTimeline();
}

// The (project_id, version) primary key is the optimistic lock:
// two concurrent edits from the same base version cannot both succeed.
export async function saveVersion(projectId: string, next: Timeline, prompt?: string) {
  try {
    await pool.query(
      "insert into timelines (project_id, version, data, prompt) values ($1, $2, $3, $4)",
      [projectId, next.version, JSON.stringify(next), prompt ?? null]
    );
  } catch (e: any) {
    if (e.code === "23505") throw new VersionConflict("timeline changed, reload and retry");
    throw e;
  }
}

// Undo = drop the newest version; the previous one becomes current.
export async function undoLatest(projectId: string): Promise<Timeline | null> {
  const { rowCount } = await pool.query(
    "delete from timelines where project_id = $1 and version = (select max(version) from timelines where project_id = $1)",
    [projectId]
  );
  return rowCount ? getLatest(projectId) : null;
}
