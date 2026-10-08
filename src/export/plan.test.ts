import { test } from "node:test";
import assert from "node:assert/strict";
import { planSegments } from "./plan.js";
import { applyOps } from "../timeline/apply.js";
import { emptyTimeline } from "../timeline/store.js";

test("splits a 12s clip into 5s chunks", () => {
  const t = applyOps(emptyTimeline(), [{ type: "add_clip", trackId: "V1", assetId: "a1", start: 0, in: 0, out: 12 }]);
  const s = planSegments(t, 5);
  assert.deepEqual(s.map((x) => x.duration), [5, 5, 2]);
  assert.deepEqual(s.map((x) => x.srcStart), [0, 5, 10]);
});

test("orders clips by timeline position and keeps source offsets", () => {
  const t = applyOps(emptyTimeline(), [
    { type: "add_clip", trackId: "V1", assetId: "a1", start: 5, in: 2, out: 4 },
    { type: "add_clip", trackId: "V1", assetId: "a1", start: 0, in: 10, out: 12 },
  ]);
  assert.deepEqual(planSegments(t, 5).map((x) => x.srcStart), [10, 2]);
});

test("no video track gives no segments", () => {
  assert.deepEqual(planSegments({ version: 0, tracks: [] }, 5), []);
});
