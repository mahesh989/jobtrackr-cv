import { Redis } from "ioredis";

const url = process.env.REDIS_URL;
if (!url) throw new Error("REDIS_URL is required");

export const connection = new Redis(url, {
  maxRetriesPerRequest: null,
  tls: url.startsWith("rediss://") || url.includes("upstash.io") ? {} : undefined,
});

export const QUEUE_NAME = "jobtrackr-pipeline";
