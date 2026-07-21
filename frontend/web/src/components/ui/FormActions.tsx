"use client";

import type { ReactNode } from "react";

/**
 * FormActions — the submit/cancel bar for Pattern A forms (mirrors .form-actions
 * in form-patterns.html: top border, 24px top margin, 16px top padding, 12px
 * gap). `status` renders a muted feedback slot after the buttons (e.g. "✓ Saved"
 * or an error message), matching the mockup's .form-status.
 */
export function FormActions({
  children, status, className = "",
}: {
  children: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 mt-6 pt-4 border-t border-border ${className}`}>
      {children}
      {status ? <span className="text-[12px] text-text-3">{status}</span> : null}
    </div>
  );
}
