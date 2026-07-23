"use client";

/**
 * Error boundary for the whole (dashboard) route group. Renders INSIDE the
 * group layout, so a crash on /applications, /billing, /cv, /profiles etc.
 * keeps the sidebar shell instead of falling through to the bare root
 * boundary. /dashboard and /admin have their own closer boundaries.
 */

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui";

export default function DashboardGroupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard-group:error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 px-4">
      <AlertTriangle className="w-10 h-10 text-amber-500" />
      <h2 className="text-lg font-semibold text-text">Something went wrong</h2>
      <p className="text-sm text-text-3 max-w-md text-center">
        {error.message || "An unexpected error occurred. Please try again."}
      </p>
      {error.digest && (
        <p className="text-xs text-text-3 font-mono">Error ID: {error.digest}</p>
      )}
      <Button onClick={reset} variant="default" className="mt-2">
        Try again
      </Button>
    </div>
  );
}
