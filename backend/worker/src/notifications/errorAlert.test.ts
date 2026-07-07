import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn(async (_arg: unknown) => ({ data: { id: "test" }, error: null }));

vi.mock("./resendClient.js", () => ({
  resend: { emails: { send: (arg: unknown) => sendMock(arg) } },
  fromEmail: "JobTrackr <noreply@jobtrackr.app>",
}));

// Minimal Redis SET ... NX EX stand-in: first caller for a key gets "OK"
// (permission to send), later callers for the same key get null (suppressed)
// — mirrors real Redis NX semantics without needing a live TTL clock.
const store = new Set<string>();
vi.mock("../queue/connection.js", () => ({
  connection: {
    set: vi.fn(async (key: string) => {
      if (store.has(key)) return null;
      store.add(key);
      return "OK";
    }),
  },
}));

const { sendPipelineFailureAlert } = await import("./errorAlert.js");

beforeEach(() => {
  store.clear();
  sendMock.mockClear();
  process.env.FOUNDER_ALERT_EMAIL = "founder@example.com";
});

describe("sendPipelineFailureAlert dedup", () => {
  it("sends the first alert for a profile", async () => {
    await sendPipelineFailureAlert("profile-a", "boom");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses a second alert for the same profile within the window", async () => {
    await sendPipelineFailureAlert("profile-a", "boom");
    await sendPipelineFailureAlert("profile-a", "boom again");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not suppress alerts for a different profile", async () => {
    await sendPipelineFailureAlert("profile-a", "boom");
    await sendPipelineFailureAlert("profile-b", "boom");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
