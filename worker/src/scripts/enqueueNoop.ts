import { pipelineQueue } from "../queue/queue.js";

const job = await pipelineQueue.add("noop", {
  type: "noop",
  message: `hello at ${new Date().toISOString()}`,
});

console.log(`enqueued job ${job.id}`);
process.exit(0);
