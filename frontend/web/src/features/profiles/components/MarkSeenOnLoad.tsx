"use client";

import { useEffect, useRef } from "react";
import { markProfileJobsSeen } from "@/lib/actions/jobs";

export function MarkSeenOnLoad({ profileId }: { profileId: string }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    markProfileJobsSeen(profileId);
  }, [profileId]);
  return null;
}
