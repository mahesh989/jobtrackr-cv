"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root:error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4">
      <AlertTriangle className="w-10 h-10 text-warning" />
      <h2 className="text-h3 font-semibold text-text">Something went wrong</h2>
      <p className="text-body text-text-3 max-w-md text-center">
        An unexpected error occurred. Please try again.
        {error.digest && (
          <>
            <br />
            <span className="text-caption">Reference: {error.digest}</span>
          </>
        )}
      </p>
      <div className="flex gap-3 mt-2">
        <Button onClick={reset} variant="default">
          Try again
        </Button>
        <Button asChild variant="default">
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}
