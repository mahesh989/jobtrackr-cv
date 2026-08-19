import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// C67: hmacSig() used to fall back to an empty-string HMAC key
// (`process.env.JOBTRACKR_HMAC_SECRET ?? ""`) when the env var was unset —
// a PUBLICLY COMPUTABLE signature (HMAC-SHA256 with a known empty key),
// not a missing-secret failure. Pins that an unset secret now denies
// every request instead of silently accepting a forgeable signature.

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ upsert: mocks.upsert }),
  }),
}));

vi.mock("@/lib/rateLimit", () => ({
  RATE_LIMIT_MESSAGE: "rate limited",
  rateLimit: mocks.rateLimit,
}));

function makeRequest(uid: string, sig: string) {
  const url = `https://jobtrackr.com.au/api/notifications/unsubscribe?uid=${encodeURIComponent(uid)}&sig=${encodeURIComponent(sig)}`;
  return { nextUrl: new URL(url) } as unknown as import("next/server").NextRequest;
}

function realSig(secret: string, uid: string): string {
  return createHmac("sha256", secret).update(uid).digest("hex");
}

const ORIGINAL_SECRET = process.env.JOBTRACKR_HMAC_SECRET;

describe("GET /api/notifications/unsubscribe", () => {
  beforeEach(() => {
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    mocks.rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 9 });
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.JOBTRACKR_HMAC_SECRET;
    else process.env.JOBTRACKR_HMAC_SECRET = ORIGINAL_SECRET;
    vi.resetModules();
  });

  it("accepts a correctly signed link when the secret is configured", async () => {
    process.env.JOBTRACKR_HMAC_SECRET = "real-shared-secret";
    const { GET } = await import("./route");
    const sig = realSig("real-shared-secret", "user-123");
    const res = await GET(makeRequest("user-123", sig));
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      { user_id: "user-123", notify_new_jobs: false },
      { onConflict: "user_id" },
    );
  });

  it("rejects a link signed with the wrong secret when the real secret is configured", async () => {
    process.env.JOBTRACKR_HMAC_SECRET = "real-shared-secret";
    const { GET } = await import("./route");
    const sig = realSig("some-other-secret", "user-123");
    const res = await GET(makeRequest("user-123", sig));
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("denies every request when JOBTRACKR_HMAC_SECRET is unset — including a signature forged with the empty-key fallback", async () => {
    delete process.env.JOBTRACKR_HMAC_SECRET;
    const { GET } = await import("./route");
    // The exact forgeable signature the old `?? ""` fallback would have
    // accepted — anyone can compute this with no secret knowledge.
    const forgedSig = realSig("", "user-123");
    const res = await GET(makeRequest("user-123", forgedSig));
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
