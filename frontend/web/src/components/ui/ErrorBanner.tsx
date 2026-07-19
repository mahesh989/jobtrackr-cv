"use client";

import { AlertCircle } from "lucide-react";

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mx-4 mb-3 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 px-3 py-2 flex items-start gap-1.5">
      <AlertCircle className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0" />
      <p className="text-[12px] text-red-700 dark:text-red-400">{message}</p>
    </div>
  );
}
