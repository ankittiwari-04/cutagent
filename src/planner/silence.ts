import type { Timeline, Op } from "../timeline/schema.js";

export type AssetSilences = {
  id: string;
  duration: number;
  silences: { start: number; end: number }[];
};

export type PlanOptions = { minDuration?: number; padding?: number };

// Rule-based planner, no LLM involved. It turns stored silence analysis into the same typed
// operations an LLM agent would emit, so both paths share validation, versioning and undo.
export function planRemoveSilences(t: Timeline, assets: AssetSilences[], opts: PlanOptions = {}): Op[] {
  const minDuration = opts.minDuration ?? 0.5;
  const padding = opts.padding ?? 0.1; // breathing room kept on each side of a cut
  const byId = new Map(assets.map((a) => [a.id, a]));

  const ranges: [number, number][] = [];
  for (const track of t.tracks) {
    for (const clip of track.clips) {
      const asset = byId.get(clip.assetId);
      if (!asset) continue;
      for (const s of asset.silences) {
        const from = Math.max(s.start, clip.in);
        const to = Math.min(s.end, clip.out, asset.duration); // ffmpeg can report an end past the real duration
        if (to - from < minDuration) continue;
        const a = clip.start + (from - clip.in) + padding;
        const b = clip.start + (to - clip.in) - padding;
        if (b - a > 0.02) ranges.push([a, b]);
      }
    }
  }

  ranges.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  // apply from the end so earlier positions stay valid while later material shifts left
  return merged.reverse().map(([start, end]) => ({ type: "ripple_delete" as const, start, end }));
}
