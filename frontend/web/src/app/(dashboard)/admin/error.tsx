"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin:error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 px-4">
      <AlertTriangle className="w-10 h-10 text-amber-500" />
      <h2 className="text-lg font-semibold text-text">Admin panel error</h2>
      <p className="text-sm text-text-3 max-w-md text-center">
        {error.message || "An unexpected error occurred in the admin panel."}
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
