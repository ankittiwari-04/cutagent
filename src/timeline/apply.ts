import { randomUUID } from "node:crypto";
import type { Timeline, Op, Clip } from "./schema.js";

const dur = (c: Clip) => c.out - c.in;

function findClip(t: Timeline, clipId: string) {
  for (const track of t.tracks) {
    const i = track.clips.findIndex((c) => c.id === clipId);
    if (i !== -1) return { track, i, clip: track.clips[i] };
  }
  throw new Error(`Clip not found: ${clipId}`);
}

// Pure function: returns a new timeline or throws. Never mutates the input.
export function applyOps(input: Timeline, ops: Op[]): Timeline {
  const t: Timeline = structuredClone(input);

  for (const op of ops) {
    switch (op.type) {
      case "add_clip": {
        const track = t.tracks.find((x) => x.id === op.trackId);
        if (!track) throw new Error(`Track not found: ${op.trackId}`);
        if (op.out <= op.in) throw new Error("out must be greater than in");
        track.clips.push({ id: randomUUID(), assetId: op.assetId, start: op.start, in: op.in, out: op.out, volume: 1 });
        break;
      }
      case "trim_clip": {
        const { clip } = findClip(t, op.clipId);
        if (op.out <= op.in) throw new Error("out must be greater than in");
        clip.in = op.in;
        clip.out = op.out;
        break;
      }
      case "split_clip": {
        const { track, i, clip } = findClip(t, op.clipId);
        if (op.at <= clip.start || op.at >= clip.start + dur(clip)) throw new Error("split point outside clip");
        const offset = op.at - clip.start;
        const right: Clip = { ...clip, id: op.rightClipId ?? randomUUID(), start: op.at, in: clip.in + offset };
        clip.out = clip.in + offset;
        track.clips.splice(i + 1, 0, right);
        break;
      }
      case "delete_clip": {
        const { track, i } = findClip(t, op.clipId);
        track.clips.splice(i, 1);
        break;
      }
      case "move_clip":
        findClip(t, op.clipId).clip.start = op.start;
        break;
      case "set_volume":
        findClip(t, op.clipId).clip.volume = op.volume;
        break;
      case "ripple_delete": {
        const { start: a, end: b } = op;
        if (b <= a) throw new Error("end must be greater than start");
        const d = b - a;
        for (const track of t.tracks) {
          const next: Clip[] = [];
          for (const c of track.clips) {
            const cs = c.start;
            const ce = c.start + dur(c);
            if (ce <= a) { next.push(c); continue; }                      // entirely before the cut
            if (cs >= b) { c.start = cs - d; next.push(c); continue; }    // entirely after: shift left
            if (cs >= a && ce <= b) continue;                             // swallowed by the cut
            if (cs < a && ce > b) {                                       // spans the cut: split in two
              const right: Clip = { ...c, id: randomUUID(), start: a, in: c.in + (b - cs) };
              c.out = c.in + (a - cs);
              next.push(c, right);
            } else if (cs < a) {                                          // overlaps the cut's left edge: trim tail
              c.out = c.in + (a - cs);
              next.push(c);
            } else {                                                      // overlaps the cut's right edge: trim head
              c.in = c.in + (b - cs);
              c.start = a;
              next.push(c);
            }
          }
          track.clips = next;
        }
        break;
      }
    }
  }
  t.version = input.version + 1;
  return t;
}
