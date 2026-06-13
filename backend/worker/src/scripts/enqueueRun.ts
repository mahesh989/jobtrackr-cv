import { connection, QUEUE_NAME } from "../queue/connection.js";
import { Queue } from "bullmq";

const queue = new Queue(QUEUE_NAME, { connection });

async function main() {
  const profileId = process.argv[2] || "6e9fea46-16ed-4c67-8287-cfb3a0d1b53a";
  console.log(`[enqueue] enqueueing run_profile for ${profileId}`);
  const job = await queue.add("run_profile", { type: "run_profile", profileId });
  console.log(`[enqueue] done, job id: ${job.id}`);
  process.exit(0);
}
main();
