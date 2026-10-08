import { test } from "node:test";
import assert from "node:assert/strict";
import { planRemoveSilences } from "./silence.js";
import { applyOps } from "../timeline/apply.js";
import { emptyTimeline } from "../timeline/store.js";
import type { Timeline } from "../timeline/schema.js";

const tl = (out: number) =>
  applyOps(emptyTimeline(), [{ type: "add_clip", trackId: "V1", assetId: "a1", start: 0, in: 0, out }]);
const total = (t: Timeline) => t.tracks[0].clips.reduce((s, c) => s + (c.out - c.in), 0);

test("removes two silences and leaves contiguous clips", () => {
  const assets = [{ id: "a1", duration: 10, silences: [{ start: 2, end: 3 }, { start: 6, end: 8 }] }];
  const ops = planRemoveSilences(tl(10), assets, { padding: 0 });
  assert.equal(ops.length, 2);
  const out = applyOps(tl(10), ops);
  assert.ok(Math.abs(total(out) - 7) < 1e-6);
  assert.deepEqual(out.tracks[0].clips.map((c) => c.start), [0, 2, 5]);
});

test("ignores silences shorter than minDuration, even after clamping to the real duration", () => {
  const assets = [{ id: "a1", duration: 10, silences: [{ start: 9.8, end: 10.5 }] }];
  assert.equal(planRemoveSilences(tl(10), assets, { padding: 0 }).length, 0);
});

test("padding keeps a little silence around each cut", () => {
  const assets = [{ id: "a1", duration: 10, silences: [{ start: 2, end: 4 }] }];
  const out = applyOps(tl(10), planRemoveSilences(tl(10), assets, { padding: 0.1 }));
  assert.ok(Math.abs(total(out) - 8.2) < 1e-6);
});
