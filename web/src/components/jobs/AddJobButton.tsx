"use client";

/**
 * AddJobButton — thin client wrapper that opens the AddJobModal.
 * Placed in server-component pages (profiles list, dashboard header).
 */

import { useState } from "react";
import { PlusCircle } from "lucide-react";
import { AddJobModal } from "./AddJobModal";

export function AddJobButton({ variant = "default" }: { variant?: "default" | "primary" }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          variant === "primary"
            ? "gh-btn gh-btn-primary text-[13px] inline-flex items-center gap-1.5"
            : "gh-btn text-[13px] inline-flex items-center gap-1.5"
        }
        title="Add a job you found elsewhere for analysis and tracking"
      >
        <PlusCircle className="w-3.5 h-3.5" />
        Add job
      </button>
      {open && <AddJobModal onClose={() => setOpen(false)} />}
    </>
  );
}
