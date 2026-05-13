import { runPipeline } from "../pipeline/orchestrator.js";

const profileId = process.argv[2] || "6e9fea46-16ed-4c67-8287-cfb3a0d1b53a";
console.log(`[test] running pipeline for profile: ${profileId}`);
await runPipeline(profileId);
console.log(`[test] done`);
process.exit(0);
