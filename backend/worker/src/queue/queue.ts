import { Queue } from "bullmq";
import { connection, QUEUE_NAME } from "./connection.js";

export const pipelineQueue = new Queue(QUEUE_NAME, { connection });

export type PipelineJobData =
  | { type: "noop"; message: string }
  | { type: "run_profile"; profileId: string; trigger?: "manual" | "auto" }
  | { type: "sync_schedules" }
  | { type: "send_weekly_digest" };
