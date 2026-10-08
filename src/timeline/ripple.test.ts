import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps } from "./apply.js";
import { emptyTimeline } from "./store.js";
import type { Timeline } from "./schema.js";

const base = () =>
  applyOps(emptyTimeline(), [{ type: "add_clip", trackId: "V1", assetId: "a1", start: 0, in: 0, out: 10 }]);
const total = (t: Timeline) => t.tracks[0].clips.reduce((s, c) => s + (c.out - c.in), 0);

test("ripple_delete in the middle splits the clip and closes the gap", () => {
  const t = applyOps(base(), [{ type: "ripple_delete", start: 2, end: 3 }]);
  const [l, r] = t.tracks[0].clips;
  assert.equal(t.tracks[0].clips.length, 2);
  assert.equal(l.out, 2);
  assert.equal(r.start, 2);
  assert.equal(r.in, 3);
  assert.equal(total(t), 9);
});

test("ripple_delete at the tail trims the clip", () => {
  const t = applyOps(base(), [{ type: "ripple_delete", start: 8, end: 10 }]);
  assert.equal(t.tracks[0].clips.length, 1);
  assert.equal(t.tracks[0].clips[0].out, 8);
});

test("ripple_delete at the head trims the start", () => {
  const t = applyOps(base(), [{ type: "ripple_delete", start: 0, end: 2 }]);
  const c = t.tracks[0].clips[0];
  assert.equal(c.start, 0);
  assert.equal(c.in, 2);
  assert.equal(c.out, 10);
});

test("ripple_delete rejects an empty range", () => {
  assert.throws(() => applyOps(base(), [{ type: "ripple_delete", start: 5, end: 5 }]));
});
