import { afterEach, describe, expect, it, vi } from "vitest";
import { sendViaOutlook } from "./outlook";

// C67: Graph's toRecipients[].emailAddress.address field wants a bare SMTP
// address. sendApplication.ts's toAddress passes the combined "Display Name
// <email>" form (valid for Gmail's raw-MIME To: header, which this callers'
// sibling sendViaGmail builds) — Graph either rejects that shape outright or
// mishandles it. sendViaOutlook must split the two apart.

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendViaOutlook — recipient address parsing", () => {
  it("splits a \"Display Name <email>\" recipient into name + bare address", async () => {
    const fetchMock = mockFetchOk();
    await sendViaOutlook("token", {
      to: "Jane Hiring Manager <jane@company.com>",
      subject: "Application",
      body: "Hello",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message.toRecipients).toEqual([
      { emailAddress: { name: "Jane Hiring Manager", address: "jane@company.com" } },
    ]);
  });

  it("passes a plain email address through unchanged", async () => {
    const fetchMock = mockFetchOk();
    await sendViaOutlook("token", {
      to: "jane@company.com",
      subject: "Application",
      body: "Hello",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.message.toRecipients).toEqual([
      { emailAddress: { address: "jane@company.com" } },
    ]);
  });
});
