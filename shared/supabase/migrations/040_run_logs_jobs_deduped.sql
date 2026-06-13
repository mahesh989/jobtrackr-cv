-- Track jobs dropped specifically by dedup (URL hash + content fingerprint)
-- so the dashboard can separate "duplicate" from "keyword/smart-filtered" drops.
ALTER TABLE run_logs ADD COLUMN IF NOT EXISTS jobs_deduped integer DEFAULT 0;
