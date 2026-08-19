import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ENV_EXAMPLE = readFileSync(
  fileURLToPath(new URL("../.env.example", import.meta.url)),
  "utf8",
);

const OPERATOR_CONFIG = [
  "JOBTRACKR_HMAC_SECRET",
  "CV_BACKEND_URL",
  "INTEGRATION_ENCRYPTION_KEY",
  "USE_GLOBAL_BUCKET",
  "NEXT_PUBLIC_APP_URL",
  "FOUNDER_ALERT_EMAIL",
  "CAREERJET_API_KEY",
  "SETTING_CLASSIFIER_AI",
  "APIFY_PROXY_PASSWORD",
] as const;

describe("worker environment example", () => {
  it.each(OPERATOR_CONFIG)("documents %s", (name) => {
    expect(ENV_EXAMPLE).toMatch(new RegExp(`^${name}=`, "m"));
  });
});
