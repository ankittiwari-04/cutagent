import type { Timeline } from "../timeline/schema.js";

export type Segment = { assetId: string; srcStart: number; duration: number };

const MIN_SEGMENT = 0.04; // below one frame, not worth a job

// v1 renders the first video track as a back-to-back sequence of clips (gaps are closed)
// and cuts it into chunks of at most chunkSec seconds.
export function planSegments(t: Timeline, chunkSec: number): Segment[] {
  const track = t.tracks.find((x) => x.kind === "video");
  if (!track) return [];
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const c of clips) {
    const total = c.out - c.in;
    for (let off = 0; off < total; off += chunkSec) {
      const duration = Math.min(chunkSec, total - off);
      if (duration < MIN_SEGMENT) continue;
      out.push({ assetId: c.assetId, srcStart: c.in + off, duration });
    }
  }
  return out;
}
