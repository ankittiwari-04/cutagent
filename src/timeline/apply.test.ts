import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps } from "./apply.js";
import { emptyTimeline } from "./store.js";

const withClip = () =>
  applyOps(emptyTimeline(), [{ type: "add_clip", trackId: "V1", assetId: "a1", start: 0, in: 0, out: 10 }]);

test("add_clip bumps version and adds the clip", () => {
  const t = withClip();
  assert.equal(t.version, 1);
  assert.equal(t.tracks[0].clips.length, 1);
});

test("applyOps never mutates its input", () => {
  const base = emptyTimeline();
  applyOps(base, [{ type: "add_clip", trackId: "V1", assetId: "a1", start: 0, in: 0, out: 5 }]);
  assert.equal(base.version, 0);
  assert.equal(base.tracks[0].clips.length, 0);
});

test("split_clip produces two contiguous clips", () => {
  const t = withClip();
  const id = t.tracks[0].clips[0].id;
  const s = applyOps(t, [{ type: "split_clip", clipId: id, at: 4 }]);
  const [l, r] = s.tracks[0].clips;
  assert.equal(l.out, 4);
  assert.equal(r.start, 4);
  assert.equal(r.in, 4);
  assert.equal(r.out, 10);
});

test("split outside the clip throws", () => {
  const t = withClip();
  assert.throws(() => applyOps(t, [{ type: "split_clip", clipId: t.tracks[0].clips[0].id, at: 99 }]));
});

test("a failing op in a batch leaves the original untouched", () => {
  const t = withClip();
  assert.throws(() => applyOps(t, [{ type: "delete_clip", clipId: "nope" }]));
  assert.equal(t.tracks[0].clips.length, 1);
});
