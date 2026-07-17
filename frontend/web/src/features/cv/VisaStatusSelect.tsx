"use client";

import { useState } from "react";
import { Select } from "@/ui";
import { VISA_STATUS_LABELS, isUserVisaStatus } from "@/lib/eligibility";

/**
 * "My working rights" selector — backed by GET/PATCH /api/user/visa-status
 * (user_preferences.contact_details.visa_status). Setting it turns on the
 * eligibility badge on every job card and lets the pipeline drop jobs whose
 * JD rules you out (e.g. "PR/citizens only" for a student-visa holder).
 */
export function VisaStatusSelect({ initial }: { initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [pending, setPending] = useState(false);

  async function handleChange(next: string) {
    const prev = value;
    setValue(next); // optimistic
    setPending(true);
    try {
      const res = await fetch("/api/user/visa-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visa_status: next === "" ? null : next }),
      });
      if (!res.ok) setValue(prev); // revert on failure
    } catch {
      setValue(prev);
    } finally {
      setPending(false);
    }
  }

  return (
    <Select
      label="Visa status"
      value={isUserVisaStatus(value) ? value : ""}
      onChange={(e) => handleChange(e.target.value)}
      disabled={pending}
      className="text-[12px] py-1"
    >
      <option value="">Not set — no eligibility filtering</option>
      {Object.entries(VISA_STATUS_LABELS).map(([k, label]) => (
        <option key={k} value={k}>{label}</option>
      ))}
    </Select>
  );
}
