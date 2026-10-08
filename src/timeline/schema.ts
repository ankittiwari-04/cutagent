import { z } from "zod";

export const ClipSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  start: z.number().min(0),   // position on the timeline (seconds)
  in: z.number().min(0),      // source in-point
  out: z.number().positive(), // source out-point
  volume: z.number().min(0).max(2).default(1),
});

export const TrackSchema = z.object({
  id: z.string(),
  kind: z.enum(["video", "audio"]),
  clips: z.array(ClipSchema),
});

export const TimelineSchema = z.object({
  version: z.number().int().min(0),
  tracks: z.array(TrackSchema),
});

export const OpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_clip"), trackId: z.string(), assetId: z.string(),
             start: z.number().min(0), in: z.number().min(0), out: z.number().positive() }),
  z.object({ type: z.literal("trim_clip"), clipId: z.string(), in: z.number().min(0), out: z.number().positive() }),
  z.object({ type: z.literal("split_clip"), clipId: z.string(), at: z.number().positive() }),
  z.object({ type: z.literal("delete_clip"), clipId: z.string() }),
  z.object({ type: z.literal("move_clip"), clipId: z.string(), start: z.number().min(0) }),
  z.object({ type: z.literal("set_volume"), clipId: z.string(), volume: z.number().min(0).max(2) }),
]);

export type Clip = z.infer<typeof ClipSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type Op = z.infer<typeof OpSchema>;
