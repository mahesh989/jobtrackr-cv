import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../../../shared/supabase/migrations/013_reserve_run_usage_idempotently.sql", import.meta.url),
  "utf8",
);
const grants = readFileSync(
  new URL("../../../../../shared/supabase/migrations/004_grants.sql", import.meta.url),
  "utf8",
);

describe("manual-run usage migration safety", () => {
  it("uses a dedicated request namespace instead of artifact ref_id", () => {
    expect(migration).toContain("create table if not exists public.run_usage_requests");
    expect(migration).toContain("primary key (user_id, request_id)");
    expect(migration).toContain("profile_id     uuid not null");
    expect(migration).toContain("full_refresh   boolean not null");
    expect(migration).toContain("v_profile <> p_profile or v_full_refresh <> p_full_refresh");
    expect(migration).not.toMatch(/set\s+ref_id\s*=\s*p_request/i);
  });

  it("keeps both SECURITY DEFINER functions private after a grants replay", () => {
    expect(grants).toContain(
      "public.reserve_run_usage(uuid, uuid, uuid, boolean, int, timestamptz)",
    );
    expect(grants).toContain("public.commit_run_usage(uuid)");
    expect(grants).toContain("revoke all on table public.run_usage_requests");
  });
});
