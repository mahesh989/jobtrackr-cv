"use client";

/**
 * AddButton — thin client wrapper that opens the AddModal.
 * Placed in server-component pages (profiles list, dashboard header).
 */

import { useState } from "react";
import { PlusCircle } from "lucide-react";
import { Button } from "@/components/ui";
import { AddModal } from "./AddModal";

export function AddButton({ variant = "default" }: { variant?: "default" | "primary" }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant === "primary" ? "primary" : "default"}
        icon={<PlusCircle className="w-3.5 h-3.5" />}
        onClick={() => setOpen(true)}
        title="Add a job you found elsewhere for analysis and tracking"
      >
        Add job
      </Button>
      {open && <AddModal onClose={() => setOpen(false)} />}
    </>
  );
}
