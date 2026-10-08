import { Queue, FlowProducer } from "bullmq";
import IORedis from "ioredis";

export const connection = new IORedis({
  host: "127.0.0.1",
  port: 6379,
  maxRetriesPerRequest: null,
});

export const CHUNK_QUEUE = "render-chunk";
export const STITCH_QUEUE = "render-stitch";

export const analysisQueue = new Queue("analysis", { connection });
export const flowProducer = new FlowProducer({ connection });
